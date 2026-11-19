import { createHmac, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  type ClaudePlanHookDefinition,
  readonlyMcpGrantSchema,
  readonlyMcpObservationSchema,
  type ReadonlyIntegrationInput,
  type ReadonlyIntegrationReply,
  type ReadonlyMcpObservation,
  type Session,
} from '@nesvo/contracts';
import { redactLogMessage } from '../log-redaction';
import {
  DirectCommandReviewError,
  inspectDirectCommand,
} from '../process/direct-command';
import { mcpRecord } from '../providers/mcp-native';
import { SessionError } from '../sessions/session-error';

export type NativeMcpObservation = {
  definition: Record<string, unknown>;
  tools: unknown;
};

export type ReadonlyMcpApproval = {
  candidate(server: string, tool: string): boolean;
  allow(
    server: string,
    tool: string,
    input: Record<string, unknown>,
    observation: NativeMcpObservation,
  ): boolean;
};

type Read = Extract<ReadonlyIntegrationReply, { action: 'read' }>;
type Entry = Read['history'][number];
type HookGrant = Read['hooks'][number];
type StoredHook = { grant: HookGrant; definition: ClaudePlanHookDefinition };
export type ClaudePlanHookGroup = {
  matcher: ClaudePlanHookDefinition['matcher'];
  hooks: {
    type: 'command';
    command: string;
    args: string[];
    timeout: number;
  }[];
};
const canonical = (value: unknown, depth = 0): unknown => {
  if (depth > 30)
    throw new Error('The provider tool schema is too deeply nested.');
  if (Array.isArray(value))
    return value.map(entry => canonical(entry, depth + 1));
  const record = mcpRecord(value);
  return record
    ? Object.fromEntries(
        Object.keys(record)
          .sort()
          .map(key => [key, canonical(record[key], depth + 1)]),
      )
    : value;
};

export function grantTransport(definition: Record<string, unknown>) {
  if (definition.enabled === false) return null;
  if (definition.command !== undefined)
    return typeof definition.command === 'string' &&
      definition.command.trim() &&
      definition.url === undefined &&
      (definition.type === undefined || definition.type === 'stdio')
      ? { transport: 'stdio' as const, endpoint: 'Local stdio process' }
      : null;
  if (typeof definition.url !== 'string') return null;
  try {
    const url = new URL(definition.url);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    return { transport: 'https' as const, endpoint: url.href };
  } catch {
    return null;
  }
}

const unavailable = (message: string): never => {
  throw new SessionError('unavailable', message);
};

export class ReadonlyMcpGrants {
  private readonly key: string;

  constructor(
    private readonly database: DatabaseSync,
    private readonly session: (id: string) => Session | undefined,
    private readonly observe: (
      session: Session,
      server: string,
      signal: AbortSignal,
    ) => Promise<NativeMcpObservation>,
  ) {
    database
      .prepare(
        "INSERT OR IGNORE INTO metadata (key, value) VALUES ('readonly_grants_key', ?)",
      )
      .run(randomUUID());
    this.key = String(
      database
        .prepare("SELECT value FROM metadata WHERE key = 'readonly_grants_key'")
        .get()!.value,
    );
  }

  private sign(value: unknown) {
    return createHmac('sha256', this.key)
      .update(JSON.stringify(canonical(value)))
      .digest('hex');
  }

  private view(
    session: Session,
    server: string,
    { definition, tools }: NativeMcpObservation,
  ): ReadonlyMcpObservation {
    const transport = grantTransport(definition);
    if (!transport)
      return unavailable('Select a verified stdio or HTTPS MCP definition.');
    const claude = session.provider === 'Claude Code';
    const entries: [string, unknown][] = Array.isArray(tools)
      ? tools.map(item => [
          typeof item === 'string' ? item : String(mcpRecord(item)?.name ?? ''),
          item,
        ])
      : Object.entries(mcpRecord(tools) ?? {});
    if (
      !entries.length ||
      entries.length > 100 ||
      JSON.stringify(entries).length > 256 * 1024 ||
      new Set(entries.map(([name]) => name)).size !== entries.length
    )
      return unavailable(
        'The provider did not return a bounded tool inventory.',
      );
    const scopedTools = entries
      .map(([name, value]) => {
        if (claude && typeof value === 'string')
          return { name, digest: this.sign(name), readOnlyHint: null };
        const tool = mcpRecord(value);
        if (
          !tool ||
          !mcpRecord(tool.inputSchema) ||
          (tool.name != null && tool.name !== name)
        )
          return unavailable(
            'The provider did not return the complete input schema for each tool.',
          );
        const hint = mcpRecord(tool.annotations)?.readOnlyHint;
        return {
          name,
          digest: this.sign(tool),
          readOnlyHint: typeof hint === 'boolean' ? hint : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return readonlyMcpObservationSchema.parse({
      sessionId: session.id,
      server,
      ...transport,
      tools: scopedTools,
      revision: this.sign([
        session.profileId,
        session.directory,
        definition,
        scopedTools,
      ]),
    });
  }

  private grants(sessionId?: string) {
    const rows = sessionId
      ? this.database
          .prepare(
            'SELECT document FROM readonly_mcp_grants WHERE session_id = ? ORDER BY rowid DESC LIMIT 100',
          )
          .all(sessionId)
      : this.database
          .prepare(
            'SELECT document FROM readonly_mcp_grants ORDER BY rowid DESC LIMIT 100',
          )
          .all();
    return rows.map(row =>
      readonlyMcpGrantSchema.parse(JSON.parse(String(row.document))),
    );
  }

  private hooks(sessionId?: string): StoredHook[] {
    const rows = sessionId
      ? this.database
          .prepare(
            'SELECT document FROM readonly_claude_hooks WHERE session_id = ? ORDER BY rowid LIMIT 100',
          )
          .all(sessionId)
      : this.database
          .prepare(
            'SELECT document FROM readonly_claude_hooks ORDER BY rowid LIMIT 100',
          )
          .all();
    return rows.map(row => JSON.parse(String(row.document)) as StoredHook);
  }

  private async verifyHook(
    session: Session,
    definition: ClaudePlanHookDefinition,
    signal: AbortSignal,
  ) {
    if (
      session.provider !== 'Claude Code' ||
      session.parentId ||
      session.role === 'worker' ||
      session.workflowRunId ||
      session.workflowStepId ||
      session.scheduledJobId
    )
      return unavailable(
        'Select a standalone interactive Claude Code session.',
      );
    if (
      definition.command.argv.some(argument =>
        /\$\{|(?:--?(?:token|password|api[-_]?key|secret|authorization)\b|:\/\/[^/\s]+@)/i.test(
          argument,
        ),
      )
    )
      return unavailable(
        'Use fixed arguments without credentials or variable expansion.',
      );
    try {
      return await inspectDirectCommand(
        definition.command,
        session.directory,
        this.sign([session.id, session.profileId, 'SessionStart', definition]),
        this.key,
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      return unavailable(
        error instanceof DirectCommandReviewError
          ? error.message
          : 'The executable, working directory or command files could not be verified.',
      );
    }
  }

  async planHooks(session: Session, signal: AbortSignal) {
    const groups: ClaudePlanHookGroup[] = [];
    const held: string[] = [];
    const verifiedHooks = await Promise.all(
      this.hooks(session.id)
        .filter(value => value.grant.enabled)
        .map(async stored => ({
          ...stored,
          verified: await this.verifyHook(
            session,
            stored.definition,
            signal,
          ).catch(() => undefined),
        })),
    );
    signal.throwIfAborted();
    const activeIds = new Set(
      this.hooks(session.id)
        .filter(value => value.grant.enabled)
        .map(value => value.grant.id),
    );
    for (const { grant, definition, verified } of verifiedHooks) {
      const active =
        verified?.fingerprint === grant.revision && activeIds.has(grant.id);
      const entry = {
        id: randomUUID(),
        grantId: grant.id,
        sessionId: session.id,
        revision: grant.revision,
        runId: session.runId,
        tool: null,
        hook: grant.name,
        actor: 'host' as const,
      };
      this.record(
        { ...entry, action: active ? 'launch-hook' : 'hold-hook' },
        [grant.id, session.runId],
        { action: 'approve-hook', hook: grant },
      );
      if (!active || !verified) {
        held.push(grant.name);
        continue;
      }
      groups.push({
        matcher: grant.matcher,
        hooks: [
          {
            type: 'command',
            command: verified.executable,
            args: [...definition.command.argv],
            timeout: Math.ceil(definition.command.timeoutMs / 1000),
          },
        ],
      });
    }
    return { groups, held };
  }

  hasHooks(sessionId: string) {
    return this.hooks(sessionId).some(value => value.grant.enabled);
  }

  private record(
    entry: Omit<Entry, 'hostId' | 'at'>,
    payload: unknown,
    reply: ReadonlyIntegrationReply,
  ) {
    const hostId = String(
      this.database
        .prepare("SELECT value FROM metadata WHERE key = 'instance_id'")
        .get()!.value,
    );
    this.database
      .prepare('INSERT INTO readonly_integration_actions VALUES (?, ?, ?, ?)')
      .run(
        entry.id,
        this.sign(payload),
        JSON.stringify({ ...entry, hostId, at: new Date().toISOString() }),
        JSON.stringify(reply),
      );
  }

  private previous(id: string, payload: unknown) {
    const row = this.database
      .prepare(
        'SELECT payload, reply FROM readonly_integration_actions WHERE id = ?',
      )
      .get(id);
    if (row && row.payload !== this.sign(payload))
      throw new SessionError(
        'invalid-request',
        'This integration action ID is already in use.',
      );
    return row
      ? (JSON.parse(String(row.reply)) as ReadonlyIntegrationReply)
      : undefined;
  }

  private transaction(execute: () => void) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      execute();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async settings(
    input: ReadonlyIntegrationInput,
    signal: AbortSignal,
  ): Promise<ReadonlyIntegrationReply> {
    if (input.action === 'read')
      return {
        action: 'read',
        grants: this.grants(input.sessionId),
        hooks: this.hooks(input.sessionId).map(value => value.grant),
        claudeHookReason:
          'Approve and enable SessionStart commands for Claude Code 2.1.328 or later. Hooks managed by your organisation always run.',
        codexHookReason:
          'This host has no verified direct-argv and selective hook loading path for Codex.',
        claudeMcpReason:
          'Grant an exact tool or the current set reported by the configured server. Other calls use one-time approval.',
        history: this.database
          .prepare(
            'SELECT document FROM readonly_integration_actions ORDER BY rowid DESC LIMIT 100',
          )
          .all()
          .map(row => JSON.parse(String(row.document)) as Entry),
      };
    if (input.action === 'revoke-hook' || input.action === 'set-hook-enabled') {
      const previous = this.previous(input.actionId, input);
      if (previous) return previous;
      const stored = this.hooks().find(
        value => value.grant.id === input.grantId,
      );
      if (!stored)
        throw new SessionError(
          'not-found',
          'This hook grant was already removed.',
        );
      const { id, sessionId, revision, name } = stored.grant;
      const replacement =
        input.action === 'set-hook-enabled'
          ? { ...stored.grant, enabled: input.enabled }
          : null;
      const reply = replacement
        ? { action: 'set-hook-enabled' as const, hook: replacement }
        : { action: 'revoke-hook' as const };
      this.transaction(() => {
        if (replacement)
          this.database
            .prepare(
              'UPDATE readonly_claude_hooks SET document = ? WHERE id = ?',
            )
            .run(JSON.stringify({ ...stored, grant: replacement }), id);
        else
          this.database
            .prepare('DELETE FROM readonly_claude_hooks WHERE id = ?')
            .run(id);
        this.record(
          {
            id: input.actionId,
            action: replacement
              ? replacement.enabled
                ? 'enable-hook'
                : 'disable-hook'
              : 'revoke-hook',
            actor: 'operator',
            grantId: id,
            sessionId,
            revision,
            runId: null,
            tool: null,
            hook: name,
          },
          input,
          reply,
        );
      });
      return reply;
    }
    if (input.action === 'revoke') {
      const previous = this.previous(input.actionId, input);
      if (previous) return previous;
      const row = this.database
        .prepare('SELECT document FROM readonly_mcp_grants WHERE id = ?')
        .get(input.grantId);
      if (!row)
        throw new SessionError(
          'not-found',
          'This integration grant was already removed.',
        );
      const grant = readonlyMcpGrantSchema.parse(
        JSON.parse(String(row.document)),
      );
      const reply = { action: 'revoke' as const };
      this.transaction(() => {
        this.database
          .prepare('DELETE FROM readonly_mcp_grants WHERE id = ?')
          .run(grant.id);
        this.record(
          {
            id: input.actionId,
            action: 'revoke',
            actor: 'operator',
            grantId: grant.id,
            sessionId: grant.sessionId,
            revision: grant.revision,
            runId: null,
            tool: null,
          },
          input,
          reply,
        );
      });
      return reply;
    }
    if (input.action === 'approve-mcp' || input.action === 'approve-hook') {
      const previous = this.previous(input.actionId, input);
      if (previous) return previous;
    }
    const session = this.session(input.sessionId);
    if (!session || session.archivedAt)
      throw new SessionError(
        'not-found',
        'Select an active session for this grant.',
      );
    if (input.action === 'inspect-hook' || input.action === 'approve-hook') {
      const { definition } = input;
      const verified = await this.verifyHook(session, definition, signal);
      const { name, matcher } = definition;
      if (input.action === 'inspect-hook')
        return {
          action: 'inspect-hook',
          hook: {
            name,
            matcher,
            executable: verified.executable,
            argv: definition.command.argv.map(value =>
              redactLogMessage(value).slice(0, 4096),
            ),
            revision: verified.fingerprint,
          },
        };
      const previous = this.previous(input.actionId, input);
      if (previous) return previous;
      if (input.revision !== verified.fingerprint)
        return unavailable(
          'The hook changed. Review the current command again.',
        );
      if (this.hooks().length >= 100 || this.hooks(session.id).length >= 8)
        return unavailable(
          'The host has reached its SessionStart grant limit. Revoke a saved hook first.',
        );
      if (
        this.hooks(session.id).some(
          value => value.grant.revision === input.revision,
        )
      )
        return unavailable(
          'This SessionStart command is already approved for the session.',
        );
      const grant = {
        id: randomUUID(),
        sessionId: session.id,
        name,
        matcher,
        revision: input.revision,
        enabled: false,
      };
      const reply = { action: 'approve-hook' as const, hook: grant };
      this.transaction(() => {
        this.database
          .prepare('INSERT INTO readonly_claude_hooks VALUES (?, ?, ?)')
          .run(grant.id, session.id, JSON.stringify({ grant, definition }));
        this.record(
          {
            id: input.actionId,
            action: 'approve-hook',
            actor: 'operator',
            grantId: grant.id,
            sessionId: session.id,
            revision: grant.revision,
            runId: null,
            tool: null,
            hook: name,
          },
          input,
          reply,
        );
      });
      return reply;
    }
    if (
      session.parentId ||
      session.role === 'worker' ||
      session.workflowRunId ||
      session.workflowStepId ||
      session.scheduledJobId
    )
      return unavailable(
        'Select a standalone interactive Claude Code or Codex session.',
      );
    if (input.server === 'nesvo' || input.server === 'nesvo-session-control')
      return unavailable(
        'Internal session-control tools use their own policy.',
      );
    const observation = this.view(
      session,
      input.server,
      await this.observe(session, input.server, signal),
    );
    if (input.action === 'inspect-mcp')
      return { action: 'inspect-mcp', observation };
    const previous = this.previous(input.actionId, input);
    if (previous) return previous;
    if (input.revision !== observation.revision)
      return unavailable(
        'The server or its tool inventory changed. Review the current definition.',
      );
    const selectedTool =
      input.selection.kind === 'tool' ? input.selection.tool : null;
    if (
      selectedTool &&
      !observation.tools.some(tool => tool.name === selectedTool)
    )
      return unavailable(
        'The selected tool is no longer reported by the server.',
      );
    if (this.grants().length >= 100)
      return unavailable(
        'The host has reached its read-only integration grant limit.',
      );
    const grant = readonlyMcpGrantSchema.parse({
      ...observation,
      id: randomUUID(),
      selection: input.selection,
      profileId: session.profileId,
      createdAt: new Date().toISOString(),
    });
    const reply = { action: 'approve-mcp' as const, grant };
    this.transaction(() => {
      this.database
        .prepare('INSERT INTO readonly_mcp_grants VALUES (?, ?, ?)')
        .run(grant.id, session.id, JSON.stringify(grant));
      this.record(
        {
          id: input.actionId,
          action: 'approve',
          actor: 'operator',
          grantId: grant.id,
          sessionId: grant.sessionId,
          revision: grant.revision,
          runId: null,
          tool: selectedTool,
        },
        input,
        reply,
      );
    });
    return reply;
  }

  candidate(session: Session, server: string, tool: string) {
    return this.grants(session.id).some(
      grant =>
        grant.server === server &&
        grant.profileId === session.profileId &&
        (grant.selection.kind === 'server' || grant.selection.tool === tool),
    );
  }

  hasGrant(session: Session) {
    return this.grants(session.id).some(
      grant => grant.profileId === session.profileId,
    );
  }

  allow(
    session: Session,
    server: string,
    tool: string,
    evidence: NativeMcpObservation,
    actionId: string,
  ) {
    if (!session.runId) return false;
    const view = this.view(session, server, evidence);
    const grant = this.grants(session.id).find(
      grant =>
        grant.server === server &&
        grant.profileId === session.profileId &&
        grant.revision === view.revision &&
        (grant.selection.kind === 'server' || grant.selection.tool === tool),
    );
    if (!grant || !view.tools.some(entry => entry.name === tool)) return false;
    const reply = { action: 'approve-mcp' as const, grant };
    const payload = [session.runId, actionId, grant.id, tool];
    if (this.previous(actionId, payload)) return false;
    this.record(
      {
        id: actionId,
        action: 'invoke',
        actor: 'host',
        grantId: grant.id,
        sessionId: session.id,
        revision: grant.revision,
        runId: session.runId,
        tool,
      },
      payload,
      reply,
    );
    return true;
  }
}
