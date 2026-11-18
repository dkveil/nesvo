import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  allowRuleSchema,
  sessionModeSchema,
  type AllowScope,
  type ClaudeAutonomy,
  type Session,
} from '@nesvo/contracts';
import {
  allowPatternMatches,
  prepareAllowPattern,
  type AllowCandidate,
} from '../providers/claude-allow-pattern';
import { SessionError } from './session-error';

const settingsKey = 'claude_autonomy';
const maxRules = 200;
const storedRuleSchema = z.strictObject({
  rule: allowRuleSchema,
  target: z.string(),
  binding: z.string().optional(),
  matching: z.literal('pattern').optional(),
  mode: sessionModeSchema.optional(),
});
const settingsSchema = z.strictObject({
  epoch: z.uuid().nullable().default(null),
  entries: z.array(storedRuleSchema).max(maxRules).default([]),
});
type Settings = z.infer<typeof settingsSchema>;

export function permissionProject(directory: string): string {
  for (let folder = directory; ; folder = dirname(folder)) {
    const marker = lstatSync(join(folder, '.git'), { throwIfNoEntry: false });
    if (marker?.isFile() || marker?.isDirectory()) return folder;
    if (dirname(folder) === folder) return directory;
  }
}

const eligibleSession = (session: Session) =>
  !session.parentId &&
  session.role !== 'worker' &&
  !session.workflowRunId &&
  !session.scheduledJobId &&
  !session.externalAttachment &&
  !session.archivedAt;

export class ClaudeAutonomyStore {
  constructor(private readonly database: DatabaseSync) {}

  private read(key: string): unknown {
    const row = this.database
      .prepare('SELECT value FROM metadata WHERE key = ?')
      .get(key);
    return typeof row?.value === 'string' ? JSON.parse(row.value) : {};
  }

  private write(key: string, value: unknown) {
    this.database
      .prepare(
        'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value));
  }

  private settings() {
    return settingsSchema.parse(this.read(settingsKey));
  }

  get(): ClaudeAutonomy {
    const { epoch, entries } = this.settings();
    return {
      fullAccessEnabled: epoch !== null,
      rules: entries.map(entry => entry.rule),
    };
  }

  setEnabled(enabled: boolean) {
    const settings = this.settings();
    settings.epoch = enabled ? (settings.epoch ?? randomUUID()) : null;
    this.write(settingsKey, settings);
  }

  private grantKey(session: Session) {
    return 'full_access:' + session.id;
  }

  private grantValue(session: Session, epoch: string) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          epoch,
          session.provider,
          session.profileId,
          session.directory,
        ]),
      )
      .digest('hex');
  }

  epoch() {
    return this.settings().epoch;
  }

  confirm(session: Session, directory: string, epoch: string) {
    if (epoch !== this.epoch())
      throw new SessionError(
        'invalid-request',
        'Full access settings changed. Confirm again.',
      );
    if (
      !eligibleSession(session) ||
      session.directory !== directory ||
      relative(realpathSync(directory), directory) ||
      session.plan?.status === 'planning' ||
      session.plan?.status === 'plan-ready'
    )
      throw new SessionError(
        'invalid-request',
        'Full access is unavailable for this session or folder.',
      );
    this.write(this.grantKey(session), this.grantValue(session, epoch));
  }

  requireFullAccess(session: Session) {
    const { epoch } = this.settings();
    if (
      !epoch ||
      !eligibleSession(session) ||
      this.read(this.grantKey(session)) !== this.grantValue(session, epoch) ||
      relative(realpathSync(session.directory), session.directory)
    )
      throw new SessionError(
        'invalid-request',
        'Full access requires the host setting and confirmation for this session folder.',
      );
  }

  revoke(session: Session) {
    this.database
      .prepare('DELETE FROM metadata WHERE key = ?')
      .run(this.grantKey(session));
  }

  remove(id: string) {
    const settings = this.settings();
    settings.entries = settings.entries.filter(entry => entry.rule.id !== id);
    this.write(settingsKey, settings);
  }

  private applies(
    entry: Settings['entries'][number],
    session: Session,
    project: string,
    candidate: AllowCandidate,
  ) {
    const { rule, target, binding } = entry;
    if (
      rule.scope === 'session'
        ? rule.sessionId !== session.id
        : rule.directory !== project
    )
      return false;
    if (!entry.matching)
      return (
        rule.tool === candidate.tool &&
        (candidate.kind !== 'mcp' || candidate.legacyMcp === true) &&
        target === candidate.target &&
        binding ===
          (candidate.kind === 'shell'
            ? candidate.legacyBinding
            : candidate.binding) &&
        (candidate.kind !== 'shell' ||
          rule.pattern === 'Bash(' + candidate.value + ')')
      );
    return (
      (candidate.kind === 'mcp'
        ? rule.tool.startsWith('mcp__')
        : rule.tool === candidate.tool) &&
      binding === candidate.binding &&
      (candidate.kind !== 'mcp' || entry.mode === session.mode) &&
      allowPatternMatches(candidate, rule.pattern, target)
    );
  }

  allows(session: Session, candidate: AllowCandidate) {
    const project = permissionProject(session.directory);
    return this.settings().entries.some(entry =>
      this.applies(entry, session, project, candidate),
    );
  }

  validateRule(
    session: Session,
    scope: AllowScope,
    candidate: AllowCandidate,
    source: string,
  ) {
    const basis =
      scope === 'session'
        ? session.directory
        : permissionProject(session.directory);
    return prepareAllowPattern(candidate, source, basis);
  }

  prepareRule(
    session: Session,
    scope: AllowScope,
    candidate: AllowCandidate,
    source: string,
  ) {
    const settings = this.settings();
    const directory =
      scope === 'session'
        ? session.directory
        : permissionProject(session.directory);
    const validated = prepareAllowPattern(candidate, source, directory);
    if ('reason' in validated)
      throw new SessionError('invalid-request', validated.reason);
    const { pattern } = validated;
    const mode = candidate.kind === 'mcp' ? session.mode : undefined;
    const existing = settings.entries.find(
      ({ rule, binding, matching, mode: savedMode }) =>
        matching === 'pattern' &&
        rule.scope === scope &&
        rule.directory === directory &&
        (scope === 'project' || rule.sessionId === session.id) &&
        rule.pattern === pattern &&
        binding === candidate.binding &&
        savedMode === mode,
    );
    if (existing) return null;
    if (settings.entries.length >= maxRules)
      throw new SessionError(
        'invalid-request',
        'Remove a saved permission rule before adding another.',
      );
    const rule = {
      id: randomUUID(),
      sessionId: session.id,
      tool: candidate.tool,
      pattern,
      directory,
      scope,
      createdAt: new Date().toISOString(),
    };
    const entry = {
      rule,
      target: directory,
      matching: 'pattern' as const,
      mode,
      binding: candidate.binding,
    };
    return {
      rule,
      save: () =>
        this.write(settingsKey, {
          ...settings,
          entries: [...settings.entries, entry],
        }),
    };
  }
}
