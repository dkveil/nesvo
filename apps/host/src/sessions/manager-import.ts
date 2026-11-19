import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  managerImportResultSchema,
  SESSION_GROUP_LIMIT,
  SESSION_GROUP_MAX_DEPTH,
  type AdoptManagerImportInput,
  type ListManagerImportInput,
  type ManagerImportCatalog,
  type ManagerImportResult,
  type ManagerImportRow,
  type Provider,
  type SessionGroup,
} from '@nesvo/contracts';
import type { ProviderProfiles } from '../providers/profiles';
import { resolveFolder } from '../workspace/folder';
import { ConversationImport } from './conversation-import';
import {
  fileByteLimit,
  inventory,
  readTranscript,
  type Transcript,
  type TranscriptFile,
} from './conversation-transcripts';
import type { SessionGroupStore } from './group-store';
import { ImportSourceError } from './import-snapshot';
import {
  explicitSourceRoot,
  managerRowLimit,
  sourceKey,
  type ManagerSource,
  type SourceGroup,
  type SourceSession,
} from './manager-source';
import { SessionError } from './service';
import type { SessionStore } from './store';
import { readT3Source } from './t3-import-source';

type ResolvedTranscript = {
  profileId: string | null;
  transcript: Transcript;
  directory: string;
};

type Candidate = {
  source: SourceGroup | SourceSession;
  row: ManagerImportRow;
  target?: ResolvedTranscript;
  directory?: string;
};

type Scan = {
  catalog: Omit<ManagerImportCatalog, 'rows' | 'nextOffset'>;
  entries: Map<string, Candidate>;
};

type Outcome = ManagerImportResult['outcomes'][number];
const pageSize = 100;
const providers: Provider[] = ['Claude Code', 'Codex'];
const identity = (
  provider: Provider,
  profileId: string | null,
  nativeId: string,
) => sourceKey(provider, profileId, nativeId);

const emptyCatalog = (
  status: Scan['catalog']['status'],
  message: string,
  roots: string[] = [],
): Scan => ({
  catalog: {
    status,
    message,
    roots,
    groupCount: 0,
    sessionCount: 0,
    profileCount: 0,
  },
  entries: new Map(),
});

class ImportTranscripts {
  private readonly files = new Map<
    string,
    { profileId: string | null; file: TranscriptFile }[]
  >();
  private bytes = 0;
  partial = false;

  constructor(
    private readonly profiles: ProviderProfiles,
    private readonly signal: AbortSignal,
    private readonly folder: (path: string) => Promise<string | undefined>,
  ) {}

  async index(sessions: SourceSession[]) {
    const profiles = this.profiles.list();
    for (const provider of providers) {
      const ids = new Set(
        sessions
          .filter(session => session.provider === provider && !session.blocked)
          .map(session => session.nativeId),
      );
      if (!ids.size) continue;
      for (const profileId of [
        null,
        ...profiles
          .filter(profile => profile.provider === provider)
          .map(profile => profile.id),
      ]) {
        try {
          const root = await this.profiles.directory(
            provider,
            profileId,
            this.signal,
          );
          const scan = await inventory(provider, this.signal, undefined, root);
          this.partial ||= scan.truncated || scan.skippedFiles > 0;
          for (const file of scan.files) {
            if (!ids.has(file.id)) continue;
            const key = sourceKey(provider, file.id);
            const candidates = this.files.get(key) ?? [];
            candidates.push({ profileId, file });
            this.files.set(key, candidates);
          }
        } catch {
          this.signal.throwIfAborted();
          this.partial = true;
        }
      }
    }
  }

  async match(
    row: SourceSession,
    directory: string,
  ): Promise<ResolvedTranscript | string> {
    if (!row.provider || !row.nativeId)
      return 'The provider reference is unavailable.';
    const matches: ResolvedTranscript[] = [];
    const files = this.files.get(sourceKey(row.provider, row.nativeId)) ?? [];
    if (!files.length)
      return this.partial
        ? 'The provider transcript was not found in the available scan.'
        : 'The provider transcript is missing.';
    for (const { profileId, file } of files) {
      if (
        file.size > fileByteLimit ||
        this.bytes + file.size > 96 * 1024 * 1024
      ) {
        this.partial = true;
        return 'The provider transcript exceeds the import read limits.';
      }
      this.bytes += file.size;
      try {
        const transcript = await readTranscript(
          file,
          row.provider,
          this.signal,
        );
        if (!transcript)
          return 'The provider transcript could not be verified.';
        const recorded = await this.folder(transcript.conversation.directory);
        if (recorded && relative(directory, recorded) === '')
          matches.push({ profileId, transcript, directory });
      } catch {
        this.signal.throwIfAborted();
        return 'The provider transcript could not be read.';
      }
    }
    if (!matches.length)
      return 'The provider transcript belongs to a different folder.';
    if (matches.length !== 1)
      return 'More than one provider transcript matches this conversation.';
    return matches[0]!;
  }
}

export class ManagerImport {
  private tail = Promise.resolve();
  private page?: { key: string; scan: Scan; until: number };

  constructor(
    private readonly database: DatabaseSync,
    private readonly store: SessionStore,
    private readonly groups: SessionGroupStore,
    private readonly conversations: ConversationImport,
    private readonly profiles: ProviderProfiles,
    private readonly dataDirectory: string,
    private readonly closing: AbortSignal,
    private readonly publishGroups: () => void,
  ) {}

  private serialize<T>(operation: (signal: AbortSignal) => Promise<T>) {
    const work = this.tail.then(() => {
      const signal = AbortSignal.any([
        this.closing,
        AbortSignal.timeout(90_000),
      ]);
      signal.throwIfAborted();
      return operation(signal);
    });
    this.tail = work.then(
      () => {},
      () => {},
    );
    return work;
  }

  list(input: ListManagerImportInput): Promise<ManagerImportCatalog> {
    return this.serialize(async signal => {
      const key = sourceKey(input.source, input.root);
      if (
        input.offset &&
        (this.page?.key !== key || this.page.until < Date.now())
      )
        return {
          ...emptyCatalog(
            'retry',
            'Refresh the import list before loading another page.',
          ).catalog,
          rows: [],
          nextOffset: null,
        };
      const scan =
        input.offset && this.page
          ? this.page.scan
          : await this.scan(input, signal);
      this.page = { key, scan, until: Date.now() + 60_000 };
      const rows = [...scan.entries.values()]
        .slice(input.offset, input.offset + pageSize)
        .map(entry => entry.row);
      const next = input.offset + rows.length;
      return {
        ...scan.catalog,
        rows,
        nextOffset: next < scan.entries.size ? next : null,
      };
    });
  }

  adopt(input: AdoptManagerImportInput): Promise<ManagerImportResult> {
    return this.serialize(async signal => {
      const fingerprint = sourceKey(input.source, input.root, input.selected);
      const request = this.database
        .prepare(
          'SELECT fingerprint, result FROM manager_import_requests WHERE id = ?',
        )
        .get(input.requestId);
      if (request && request.fingerprint !== fingerprint)
        throw new SessionError(
          'invalid-request',
          'The import request ID is already in use.',
        );
      const prior = request
        ? managerImportResultSchema.parse(JSON.parse(String(request.result)))
        : null;
      if (prior?.outcomes.length === input.selected.length) return prior;
      const outcomes = new Map(
        prior?.outcomes.map(result => [result.key, result]),
      );
      const report = () => ({
        requestId: input.requestId,
        outcomes: input.selected.flatMap(({ key }) => {
          const outcome = outcomes.get(key);
          return outcome ? [outcome] : [];
        }),
      });
      const save = (
        key: string,
        status: Outcome['status'],
        reason: string | null = null,
      ) => {
        outcomes.set(key, { key, status, reason });
        this.database
          .prepare(
            `
          INSERT INTO manager_import_requests (id, fingerprint, result) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET result = excluded.result
        `,
          )
          .run(input.requestId, fingerprint, JSON.stringify(report()));
      };
      const scan = await this.scan(input, signal);
      if (!['ready', 'partial', 'not-found'].includes(scan.catalog.status))
        throw new SessionError(
          'unavailable',
          scan.catalog.message ?? 'The source could not be checked.',
        );
      const selected = new Map(
        input.selected.map(row => [row.key, row.revision]),
      );
      const ordered = new Set(
        [...scan.entries.keys()].filter(key => selected.has(key)),
      );
      for (const key of selected.keys()) ordered.add(key);
      try {
        for (const key of ordered) {
          signal.throwIfAborted();
          if (outcomes.has(key)) continue;
          const entry = scan.entries.get(key);
          if (this.link(key)) {
            save(key, 'existing');
          } else if (!entry || entry.row.revision !== selected.get(key)) {
            save(
              key,
              'skipped',
              'The source changed after selection. Refresh before importing.',
            );
          } else if (entry.row.kind === 'session' && !entry.target) {
            save(key, 'skipped', entry.row.reason);
          } else {
            try {
              this.commit(entry, scan.entries, input.source, status =>
                save(key, status),
              );
            } catch (error) {
              save(
                key,
                'skipped',
                error instanceof SessionError
                  ? error.message
                  : 'Nesvo could not save this item.',
              );
            }
          }
        }
      } finally {
        this.page = undefined;
        this.publishGroups();
      }
      return report();
    });
  }

  private async scan(
    input: Pick<ListManagerImportInput, 'source' | 'root'>,
    signal: AbortSignal,
  ): Promise<Scan> {
    try {
      if (input.source !== 't3-code')
        return emptyCatalog(
          'unsupported',
          'This source is unavailable on this computer.',
        );
      const source = await readT3Source(input.root, this.dataDirectory, signal);
      if (!source)
        return emptyCatalog(
          'not-found',
          'No T3 Code v2 store was found on this computer.',
        );
      return await this.resolve(source, signal);
    } catch (error) {
      this.closing.throwIfAborted();
      if (error instanceof ImportSourceError)
        return emptyCatalog(error.status, error.message);
      if (signal.aborted)
        return emptyCatalog(
          'retry',
          'The source scan timed out. Refresh to try again.',
        );
      return emptyCatalog(
        'unavailable',
        'The source could not be read. Check the selected directory and try again.',
      );
    }
  }

  private async resolve(
    source: ManagerSource,
    signal: AbortSignal,
  ): Promise<Scan> {
    const entries = new Map<string, Candidate>();
    const folders = new Map<string, Promise<string | undefined>>();
    const folder = (path: string) => {
      const found = folders.get(path);
      if (found) return found;
      const pending = explicitSourceRoot(path)
        ? resolveFolder(path, signal).catch(() => undefined)
        : Promise.resolve(undefined);
      folders.set(path, pending);
      return pending;
    };
    const transcripts = new ImportTranscripts(this.profiles, signal, folder);
    const sessions = source.sessions.slice(
      0,
      Math.max(0, managerRowLimit - source.groups.length),
    );
    await transcripts.index(sessions);
    const known = this.knownConversations();
    for (const group of source.groups.slice(0, managerRowLimit)) {
      signal.throwIfAborted();
      const directory = group.directory
        ? await folder(group.directory)
        : undefined;
      const { kind, key, parent, title, archivedAt, profile } = group;
      const revision = sourceKey(
        group,
        directory,
        parent && entries.get(parent)?.row.revision,
      );
      entries.set(key, {
        source: group,
        directory,
        row: { kind, key, revision, parent, title, archivedAt, profile },
      });
    }
    for (const session of sessions) {
      signal.throwIfAborted();
      const { kind, key, parent, title, archivedAt, profile, provider } =
        session;
      let reason = session.blocked;
      let target: ResolvedTranscript | undefined;
      const previous = this.link(key);
      if (!reason && !previous) {
        const directory = session.directory
          ? await folder(session.directory)
          : undefined;
        if (!directory)
          reason = session.hasWorktree
            ? 'The recorded worktree is missing or inaccessible.'
            : 'The project folder is missing or inaccessible.';
        else {
          const match = await transcripts.match(session, directory);
          if (typeof match === 'string') reason = match;
          else target = match;
        }
      }
      const existing =
        previous ||
        (target &&
          known.has(
            identity(
              target.transcript.conversation.provider,
              target.profileId,
              target.transcript.conversation.providerSessionId,
            ),
          ));
      const revision = sourceKey(
        session,
        target,
        reason,
        parent && entries.get(parent)?.row.revision,
      );
      entries.set(key, {
        source: session,
        target,
        row: {
          kind,
          key,
          revision,
          parent,
          title,
          archivedAt,
          profile,
          provider,
          disposition: existing ? 'existing' : reason ? 'blocked' : 'ready',
          reason: existing ? null : reason,
        },
      });
    }
    const partial =
      source.partial ||
      transcripts.partial ||
      entries.size < source.groupCount + source.sessionCount;
    return {
      catalog: {
        status: partial ? 'partial' : 'ready',
        message: partial
          ? 'The scan reached a limit or some source entries were unreadable.'
          : null,
        roots: [],
        groupCount: source.groupCount,
        sessionCount: source.sessionCount,
        profileCount: source.profileCount,
      },
      entries,
    };
  }

  private knownConversations() {
    return new Map(
      this.store
        .providerConversations()
        .map(row => [
          identity(row.provider, row.profileId, row.providerSessionId),
          row.id,
        ]),
    );
  }

  private link(key: string) {
    return this.database
      .prepare(
        'SELECT target_id FROM manager_import_provenance WHERE source_key = ?',
      )
      .get(key)?.target_id as string | undefined;
  }

  private record(
    source: AdoptManagerImportInput['source'],
    row: Candidate['source'],
    id: string,
  ) {
    this.database
      .prepare(
        'INSERT INTO manager_import_provenance (source_key, kind, source, target_id, branch) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        row.key,
        row.kind,
        source,
        id,
        row.kind === 'session' ? row.branch : null,
      );
  }

  private commit(
    entry: Candidate,
    entries: Scan['entries'],
    source: AdoptManagerImportInput['source'],
    save: (status: Outcome['status']) => void,
  ) {
    const row = entry.source;
    if (row.kind === 'group') {
      this.store.saveMany([], () => {
        this.ensureGroup(row.key, entries, source);
        save('created');
      });
      return;
    }
    const target = entry.target!;
    const { transcript, directory, profileId } = target;
    const { provider, providerSessionId } = transcript.conversation;
    const existing = this.knownConversations().get(
      identity(provider, profileId, providerSessionId),
    );
    if (existing) {
      this.store.saveMany([], () => {
        this.record(source, row, existing);
        save('existing');
      });
      return;
    }
    const groupId = row.parent
      ? (this.link(row.parent) ?? randomUUID())
      : undefined;
    this.conversations.adoptTranscript(transcript, directory, {
      sessionId: randomUUID(),
      profileId,
      groupId:
        groupId && (!this.link(row.parent!) || this.groups.get(groupId))
          ? groupId
          : undefined,
      title: row.title,
      presentation: {
        archivedAt: row.archivedAt,
        order: row.order,
        ...(row.createdAt ? { createdAt: row.createdAt } : {}),
        ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
      },
      writeRelated: id => {
        if (row.parent) this.ensureGroup(row.parent, entries, source, groupId);
        this.record(source, row, id);
        save('created');
      },
    });
  }

  private ensureGroup(
    key: string,
    entries: Scan['entries'],
    source: AdoptManagerImportInput['source'],
    id: string = randomUUID(),
  ): string | null {
    const known = this.link(key);
    if (known) return this.groups.get(known) ? known : null;
    const entry = entries.get(key);
    if (!entry || entry.source.kind !== 'group')
      throw new SessionError(
        'invalid-request',
        'The source group is outside this import list.',
      );
    const parentId = entry.source.parent
      ? this.ensureGroup(entry.source.parent, entries, source)
      : null;
    const { groups } = this.groups.list();
    if (groups.length >= SESSION_GROUP_LIMIT)
      throw new SessionError(
        'invalid-request',
        'This computer has reached its session group limit.',
      );
    let parent = parentId;
    let depth = 1;
    while (parent && depth <= SESSION_GROUP_MAX_DEPTH) {
      parent = groups.find(group => group.id === parent)?.parentId ?? null;
      depth++;
    }
    if (depth > SESSION_GROUP_MAX_DEPTH)
      throw new SessionError(
        'invalid-request',
        'The destination group is nested too deeply.',
      );
    const order =
      groups.reduce(
        (max, group) =>
          group.parentId === parentId ? Math.max(max, group.order) : max,
        -1,
      ) + 1;
    const now = new Date().toISOString();
    const group: SessionGroup = {
      id,
      parentId,
      name: entry.source.title,
      order,
      createdAt: now,
      updatedAt: now,
      defaults: entry.directory ? { directory: entry.directory } : {},
    };
    this.groups.write([group]);
    this.record(source, entry.source, id);
    return id;
  }
}
