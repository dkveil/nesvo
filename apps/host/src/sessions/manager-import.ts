import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
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
  inventory,
  probeManagerTranscript,
  readManagerTranscript,
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
import { openT3Source } from './t3-import-source';
import { readAgentDeckSource } from './agent-deck-import-source';

type ResolvedTranscript = {
  profileId: string | null;
  file: TranscriptFile;
  sourceDirectory: string;
  directory: string;
  workspaceFallback: boolean;
};

type Candidate = {
  source: SourceGroup | SourceSession;
  row: ManagerImportRow;
  target?: ResolvedTranscript;
  directory?: string;
};

type Scan = {
  catalog: Omit<ManagerImportCatalog, 'rows' | 'nextOffset' | 'scanId'>;
  entries: Map<string, Candidate>;
};

type CatalogPage = {
  key: string;
  catalog: Scan['catalog'];
  rows: ManagerImportRow[];
  until: number;
};

type T3Scan = {
  id: string;
  key: string;
  source: NonNullable<Awaited<ReturnType<typeof openT3Source>>>;
  expiry?: ReturnType<typeof setTimeout>;
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

function sameDirectory(left: string, right: string) {
  return relative(left, right) === '';
}

async function missingDirectory(path: string) {
  if (!explicitSourceRoot(path)) return false;
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

class ImportTranscripts {
  private readonly files = new Map<
    string,
    { profileId: string | null; file: TranscriptFile }[]
  >();
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
        sessions.flatMap(session =>
          session.provider === provider && !session.blocked && session.nativeId
            ? [session.nativeId]
            : [],
        ),
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
          const scan = await inventory(
            provider,
            this.signal,
            undefined,
            root,
            ids,
          );
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
    workspaceFallback: boolean,
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
      try {
        const sourceDirectory = await probeManagerTranscript(
          file,
          row.provider,
          this.signal,
        );
        if (!sourceDirectory)
          return 'The provider transcript could not be verified.';
        const sameRecorded =
          row.directory && sameDirectory(row.directory, sourceDirectory);
        const recorded = sameRecorded
          ? undefined
          : await this.folder(sourceDirectory);
        if (sameRecorded || (recorded && sameDirectory(directory, recorded)))
          matches.push({
            profileId,
            file,
            sourceDirectory,
            directory,
            workspaceFallback,
          });
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
  private readonly pages = new Map<string, CatalogPage>();
  private t3Scan?: T3Scan;

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

  private enqueue<T>(operation: () => Promise<T>) {
    const work = this.tail.then(operation);
    this.tail = work.then(
      () => {},
      () => {},
    );
    return work;
  }

  private serialize<T>(operation: (signal: AbortSignal) => Promise<T>) {
    return this.enqueue(() => {
      const signal = AbortSignal.any([
        this.closing,
        AbortSignal.timeout(90_000),
      ]);
      signal.throwIfAborted();
      return operation(signal);
    });
  }

  close() {
    return this.enqueue(() => this.closeT3());
  }

  private async closeT3() {
    const scan = this.t3Scan;
    this.t3Scan = undefined;
    if (!scan) return;
    clearTimeout(scan.expiry);
    await scan.source.close();
  }

  list(input: ListManagerImportInput): Promise<ManagerImportCatalog> {
    return this.serialize(async signal => {
      if (input.source === 't3-code') return this.listT3(input, signal);
      const key = sourceKey(input.source, input.root);
      const now = Date.now();
      for (const [id, page] of this.pages)
        if (page.until < now) this.pages.delete(id);
      const scanId = input.offset ? input.scanId : randomUUID();
      let page = scanId ? this.pages.get(scanId) : undefined;
      if (input.offset) {
        if (!page || page.key !== key)
          return {
            ...emptyCatalog(
              'retry',
              'Refresh the import list before loading another page.',
            ).catalog,
            rows: [],
            nextOffset: null,
            scanId: null,
          };
      } else {
        const scan = await this.scan(input, signal);
        page = {
          key,
          catalog: scan.catalog,
          rows: [...scan.entries.values()].map(entry => entry.row),
          until: Date.now() + 60_000,
        };
      }
      const rows = page.rows.slice(input.offset, input.offset + pageSize);
      const next = input.offset + rows.length;
      const nextOffset = next < page.rows.length ? next : null;
      if (nextOffset !== null && scanId) {
        page.until = Date.now() + 60_000;
        this.pages.set(scanId, page);
        if (this.pages.size > 4)
          this.pages.delete(this.pages.keys().next().value!);
      }
      return {
        ...page.catalog,
        rows,
        nextOffset,
        scanId: nextOffset !== null ? (scanId ?? null) : null,
      };
    });
  }

  private async listT3(
    input: ListManagerImportInput,
    signal: AbortSignal,
  ): Promise<ManagerImportCatalog> {
    const empty = (scan: Scan): ManagerImportCatalog => ({
      ...scan.catalog,
      rows: [],
      nextOffset: null,
      scanId: null,
    });
    const key = sourceKey(input.source, input.root);
    try {
      if (!input.offset) {
        await this.closeT3();
        const source = await openT3Source(
          input.root,
          this.dataDirectory,
          signal,
        );
        if (!source)
          return empty(
            emptyCatalog(
              'not-found',
              'No T3 Code v2 store was found on this computer.',
            ),
          );
        this.t3Scan = { id: randomUUID(), key, source };
      }
      const active = this.t3Scan;
      if (
        !active ||
        active.key !== key ||
        (input.offset && active.id !== input.scanId)
      )
        return empty(
          emptyCatalog(
            'retry',
            'Refresh the import list before loading another page.',
          ),
        );
      clearTimeout(active.expiry);
      const page = active.source.page(input.offset, pageSize);
      const scan = await this.resolve(page, signal, true);
      const rows = [...page.groups, ...page.sessions].flatMap(item => {
        const entry = scan.entries.get(item.key);
        return entry ? [entry.row] : [];
      });
      const next = input.offset + pageSize;
      const nextOffset = next < active.source.total ? next : null;
      if (nextOffset === null) await this.closeT3();
      else
        active.expiry = setTimeout(() => {
          void this.enqueue(async () => {
            if (this.t3Scan === active) await this.closeT3();
          }).catch(() => undefined);
        }, 120_000).unref();
      return {
        ...scan.catalog,
        rows,
        nextOffset,
        scanId: nextOffset === null ? null : active.id,
      };
    } catch (error) {
      await this.closeT3();
      return empty(this.scanFailure(error, signal));
    }
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
      const selected = new Map(input.selected.map(row => [row.key, row]));
      const scan = await this.scan(input, signal, new Set(selected.keys()));
      if (!['ready', 'partial', 'not-found'].includes(scan.catalog.status))
        throw new SessionError(
          'unavailable',
          scan.catalog.message ?? 'The source could not be checked.',
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
          } else if (
            !entry ||
            entry.row.revision !== selected.get(key)?.revision
          ) {
            save(
              key,
              'skipped',
              'The source changed after selection. Refresh before importing.',
            );
          } else if (entry.row.kind === 'session' && !entry.target) {
            save(key, 'skipped', entry.row.reason);
          } else if (
            entry.row.kind === 'session' &&
            entry.row.workspaceFallback &&
            !selected.get(key)?.useProjectFolder
          ) {
            save(
              key,
              'skipped',
              'Choose to resume this session in the project folder.',
            );
          } else {
            try {
              await this.commit(
                entry,
                scan.entries,
                input.source,
                signal,
                status => save(key, status),
              );
            } catch (error) {
              signal.throwIfAborted();
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
        for (const [id, page] of this.pages)
          if (page.key === sourceKey(input.source, input.root))
            this.pages.delete(id);
        this.publishGroups();
      }
      return report();
    });
  }

  private async scan(
    input: Pick<ListManagerImportInput, 'source' | 'root'>,
    signal: AbortSignal,
    selection?: ReadonlySet<string>,
  ): Promise<Scan> {
    try {
      if (input.source === 't3-code') {
        await this.closeT3();
        const source = await openT3Source(
          input.root,
          this.dataDirectory,
          signal,
        );
        if (!source)
          return emptyCatalog(
            'not-found',
            'No T3 Code v2 store was found on this computer.',
          );
        let items;
        try {
          items = source.selection(selection ?? new Set());
        } finally {
          await source.close();
        }
        return await this.resolve(items, signal, true);
      }
      const source = await readAgentDeckSource(
        input.root,
        this.dataDirectory,
        signal,
      );
      if (!source)
        return emptyCatalog(
          'not-found',
          'No Agent Deck profile store was found on this computer.',
        );
      if ('roots' in source)
        return emptyCatalog(
          'choose-root',
          'Agent Deck has conflicting data stores. Choose the one to import.',
          source.roots,
        );
      const sessions = source.sessions
        .slice(0, Math.max(0, managerRowLimit - source.groups.length))
        .filter(row => !selection || selection.has(row.key));
      return await this.resolve(
        {
          ...source,
          sessions,
          groups: source.groups.slice(0, managerRowLimit),
          partial:
            source.partial ||
            (!selection &&
              source.groups.length + sessions.length <
                source.groupCount + source.sessionCount),
        },
        signal,
        false,
      );
    } catch (error) {
      return this.scanFailure(error, signal);
    }
  }

  private scanFailure(error: unknown, signal: AbortSignal): Scan {
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

  private async resolve(
    source: ManagerSource,
    signal: AbortSignal,
    allowProjectFolder: boolean,
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
    await transcripts.index(source.sessions);
    const known = this.knownConversations();
    for (const group of [...source.groups, ...(source.contextGroups ?? [])]) {
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
    for (const session of source.sessions) {
      signal.throwIfAborted();
      const { kind, key, parent, title, archivedAt, profile, provider } =
        session;
      let reason = session.blocked;
      let target: ResolvedTranscript | undefined;
      const previous = this.link(key);
      if (!reason && !previous) {
        const recorded = session.directory
          ? await folder(session.directory)
          : undefined;
        const project =
          !recorded &&
          allowProjectFolder &&
          session.hasWorktree &&
          parent &&
          session.directory &&
          (await missingDirectory(session.directory))
            ? entries.get(parent)?.directory
            : undefined;
        const directory = recorded ?? project;
        if (!directory)
          reason = session.hasWorktree
            ? 'The recorded worktree is missing or inaccessible.'
            : 'The project folder is missing or inaccessible.';
        else {
          const match = await transcripts.match(session, directory, !!project);
          if (typeof match === 'string') reason = match;
          else target = match;
        }
      }
      const existing =
        previous ||
        (target &&
          provider &&
          known.has(identity(provider, target.profileId, target.file.id)));
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
          ...(!existing && target?.workspaceFallback
            ? { workspaceFallback: 'project-folder' as const }
            : {}),
        },
      });
    }
    const partial = source.partial || transcripts.partial;
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

  private async commit(
    entry: Candidate,
    entries: Scan['entries'],
    source: AdoptManagerImportInput['source'],
    signal: AbortSignal,
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
    const { file, directory, profileId, sourceDirectory } = target;
    const provider = row.provider!;
    const providerSessionId = file.id;
    const transcript = await readManagerTranscript(file, provider, signal);
    if (
      !transcript ||
      !sameDirectory(transcript.conversation.directory, sourceDirectory)
    )
      throw new SessionError(
        'unavailable',
        'The provider transcript changed or its history could not be read.',
      );
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
