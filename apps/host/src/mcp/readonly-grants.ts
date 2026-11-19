import { createHmac, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  readonlyMcpGrantSchema,
  readonlyMcpObservationSchema,
  type ReadonlyIntegrationInput,
  type ReadonlyIntegrationReply,
  type ReadonlyMcpObservation,
  type Session,
} from '@nesvo/contracts';
import { mcpRecord } from '../providers/mcp-native';
import { SessionError } from '../sessions/session-error';

export type NativeMcpObservation = {
  definition: Record<string, unknown>;
  tools: unknown;
};

type Read = Extract<ReadonlyIntegrationReply, { action: 'read' }>;
type Entry = Read['history'][number];
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

export function grantEndpoint(definition: Record<string, unknown>) {
  if (
    definition.enabled === false ||
    definition.command !== undefined ||
    typeof definition.url !== 'string'
  )
    return null;
  try {
    const url = new URL(definition.url);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    return url.href;
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
    const endpoint = grantEndpoint(definition);
    if (!endpoint)
      return unavailable(
        'Silent grants require a verified HTTPS MCP definition.',
      );
    const entries: [string, unknown][] = Array.isArray(tools)
      ? tools.map(item => [String(mcpRecord(item)?.name ?? ''), item])
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
      endpoint,
      transport: 'https',
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
        claudeHookReason:
          'Selective native loading cannot currently verify that managed and plugin hooks stay outside the approved list.',
        codexHookReason:
          'This host has no verified direct-argv and selective hook loading path for Codex.',
        claudeMcpReason:
          'This host has no verified runtime inventory for automatic Claude Plan grants. Existing one-time approval remains available.',
        history: this.database
          .prepare(
            'SELECT document FROM readonly_integration_actions ORDER BY rowid DESC LIMIT 100',
          )
          .all()
          .map(row => JSON.parse(String(row.document)) as Entry),
      };
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
    if (input.action === 'approve-mcp') {
      const previous = this.previous(input.actionId, input);
      if (previous) return previous;
    }
    const session = this.session(input.sessionId);
    if (!session || session.archivedAt)
      throw new SessionError(
        'not-found',
        'Select an active session for this grant.',
      );
    if (
      session.provider !== 'Codex' ||
      session.parentId ||
      session.workflowRunId ||
      session.scheduledJobId
    )
      return unavailable(
        'Automatic grants are currently available for interactive Codex sessions.',
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
