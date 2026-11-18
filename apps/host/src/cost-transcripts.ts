import { constants } from 'node:fs';
import { open, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CostReport, Provider } from '@nesvo/contracts';
import { z } from 'zod';

const maxLineBytes = 8 * 1024 * 1024;
const workers = 4;
const codexFields = ['"token_count"', '"session_meta"', '"turn_context"'].map(
  field => Buffer.from(field),
);
const claudeFields = [Buffer.from('"usage"')];
const count = z.number().int().nonnegative();
const id = z.string().min(1).max(256);
const directory = z
  .string()
  .max(4096)
  .refine(isAbsolute)
  .transform(path => normalize(path));
const timestamp = z.iso
  .datetime({ offset: true })
  .transform(value => new Date(value).toISOString());

const claudeSchema = z.object({
  type: z.literal('assistant'),
  timestamp,
  sessionId: z.uuid(),
  requestId: id.nullish(),
  cwd: directory.optional(),
  costUSD: z.number().nonnegative().nullish(),
  message: z.object({
    id,
    model: id,
    usage: z.object({
      input_tokens: count,
      cache_creation_input_tokens: count.nullish(),
      cache_read_input_tokens: count.nullish(),
      output_tokens: count,
      speed: z.string().nullish(),
    }),
  }),
});

const codexContext = z.object({
  type: z.enum(['session_meta', 'turn_context']),
  payload: z.object({
    id: z.uuid().optional(),
    cwd: directory.optional(),
    model: id.optional(),
    turn_id: id.nullish(),
    service_tier: z.string().nullish(),
    thread_settings: z.object({ service_tier: z.string().nullish() }).nullish(),
  }),
});

const codexTokens = z.object({
  input_tokens: count,
  cached_input_tokens: count.nullish(),
  output_tokens: count,
});

const codexSchema = z.object({
  type: z.literal('event_msg'),
  timestamp,
  payload: z.object({
    type: z.literal('token_count'),
    info: z.object({
      last_token_usage: codexTokens,
      total_token_usage: codexTokens.nullish(),
    }),
  }),
});

const contextSchema = z.object({
  sessionId: z.uuid().optional(),
  directory: directory.optional(),
  model: id.optional(),
  turnId: id.nullish(),
  tier: z.string().nullish(),
});

type Context = z.infer<typeof contextSchema>;
type Source = {
  provider: Provider;
  root: string;
  files: string[];
  complete: boolean;
};
type Usage = {
  key: string;
  at: string;
  sessionId: string;
  directory?: string;
  model?: string;
  fast: boolean;
  uncached: number;
  read: number;
  write: number;
  output: number;
  reported?: number | null;
};

export function migrateTranscriptCosts(database: DatabaseSync) {
  database.exec(`
    DROP TABLE IF EXISTS cost_turns;
    CREATE TABLE IF NOT EXISTS cost_transcript_files (
      path TEXT PRIMARY KEY,
      root TEXT NOT NULL,
      provider TEXT NOT NULL,
      identity TEXT NOT NULL,
      size INTEGER NOT NULL,
      modified REAL NOT NULL,
      offset INTEGER NOT NULL,
      context TEXT NOT NULL,
      incomplete INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS cost_transcript_usage (
      path TEXT NOT NULL REFERENCES cost_transcript_files(path) ON DELETE CASCADE,
      record_key TEXT NOT NULL,
      started_at TEXT NOT NULL,
      provider_session TEXT NOT NULL,
      directory TEXT,
      model TEXT,
      fast INTEGER NOT NULL,
      uncached INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL,
      output INTEGER NOT NULL,
      reported REAL,
      PRIMARY KEY (path, record_key)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS cost_transcript_usage_date ON cost_transcript_usage(started_at);
  `);
}

function parseLine(
  provider: Provider,
  context: Context,
  line: Buffer,
): Usage | null | undefined {
  const codex = provider === 'Codex';
  const fields = codex ? codexFields : claudeFields;
  if (!fields.some(field => line.includes(field))) return;
  let value: unknown;
  try {
    value = JSON.parse(line.toString('utf8'));
  } catch {
    return;
  }
  if (!codex) {
    const parsed = claudeSchema.safeParse(value);
    if (!parsed.success) return null;
    const row = parsed.data;
    const usage = row.message.usage;
    if (row.message.model === '<synthetic>') return null;
    return {
      key: JSON.stringify([row.message.id, row.requestId ?? null]),
      at: row.timestamp,
      sessionId: row.sessionId,
      directory: row.cwd,
      model: row.message.model,
      fast: usage.speed === 'fast',
      uncached: usage.input_tokens,
      read: usage.cache_read_input_tokens ?? 0,
      write: usage.cache_creation_input_tokens ?? 0,
      output: usage.output_tokens,
      reported: row.costUSD,
    };
  }
  const settings = codexContext.safeParse(value);
  if (settings.success) {
    const payload = settings.data.payload;
    context.sessionId = payload.id ?? context.sessionId;
    context.directory = payload.cwd ?? context.directory;
    context.model = payload.model ?? context.model;
    context.turnId = payload.turn_id ?? context.turnId;
    if (
      payload.thread_settings !== undefined ||
      payload.service_tier !== undefined
    )
      context.tier =
        payload.thread_settings?.service_tier ?? payload.service_tier ?? null;
    return null;
  }
  const event = codexSchema.safeParse(value);
  if (!event.success || !context.sessionId) return null;
  const { last_token_usage: usage, total_token_usage: total } =
    event.data.payload.info;
  const cached = Math.min(usage.cached_input_tokens ?? 0, usage.input_tokens);
  return {
    key: total
      ? JSON.stringify([
          'count',
          context.sessionId,
          total.input_tokens,
          total.cached_input_tokens ?? 0,
          total.output_tokens,
        ])
      : JSON.stringify([
          'turn',
          context.sessionId,
          context.turnId ?? event.data.timestamp,
        ]),
    at: event.data.timestamp,
    sessionId: context.sessionId,
    directory: context.directory,
    model: context.model,
    fast: context.tier === 'fast' || context.tier === 'priority',
    uncached: usage.input_tokens - cached,
    read: cached,
    write: 0,
    output: usage.output_tokens,
  };
}

async function discover(
  source: Source,
  folder: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    for await (const entry of await opendir(folder)) {
      signal.throwIfAborted();
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await discover(source, path, signal);
      else if (
        entry.isFile() &&
        (source.provider === 'Codex'
          ? /^rollout-.*\.jsonl$/i
          : /\.jsonl$/i
        ).test(entry.name)
      )
        source.files.push(path);
    }
  } catch {
    source.complete = false;
  }
}

export class CostTranscripts {
  constructor(private readonly database: DatabaseSync) {}

  async scan(
    profiles: ReadonlyArray<{ provider: Provider; configDirectory: string }>,
    signal: AbortSignal,
  ) {
    const statuses: CostReport['transcripts'] = {
      'Claude Code': 'missing',
      Codex: 'missing',
    };
    const roots = new Map<string, Provider>();
    let retained = new Set<string>();
    for (const { provider, configDirectory } of [
      {
        provider: 'Claude Code' as const,
        configDirectory:
          process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'),
      },
      {
        provider: 'Codex' as const,
        configDirectory:
          process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'),
      },
      ...profiles,
    ]) {
      const subfolders =
        provider === 'Codex' ? ['sessions', 'archived_sessions'] : ['projects'];
      for (const subfolder of subfolders) {
        signal.throwIfAborted();
        const path = resolve(configDirectory, subfolder);
        try {
          const root = await realpath(path);
          roots.set(root, provider);
          if (statuses[provider] === 'missing')
            statuses[provider] = 'available';
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            statuses[provider] = 'incomplete';
            retained.add(path);
          }
        }
      }
    }
    const sources = [...roots].map(([root, provider]): Source => ({
      provider,
      root,
      files: [],
      complete: true,
    }));
    for (const source of sources) await discover(source, source.root, signal);
    signal.throwIfAborted();
    retained = new Set([
      ...retained,
      ...sources.filter(source => !source.complete).map(source => source.root),
    ]);
    const paths = new Set(sources.flatMap(source => source.files));
    const remove = this.database.prepare(
      'DELETE FROM cost_transcript_files WHERE path = ?',
    );
    for (const row of this.database
      .prepare('SELECT path, root FROM cost_transcript_files')
      .all()) {
      if (!paths.has(String(row.path)) && !retained.has(String(row.root)))
        remove.run(row.path!);
    }
    const jobs = sources.flatMap(source =>
      source.files.map(path => ({ source, path })),
    );
    let next = 0;
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (let job = jobs[next++]; job; job = jobs[next++]) {
          const { source, path } = job;
          if (signal.aborted) return;
          if (!(await this.scanFile(source, path, signal)))
            statuses[source.provider] = 'incomplete';
        }
      }),
    );
    for (const source of sources)
      if (!source.complete) statuses[source.provider] = 'incomplete';
    return statuses;
  }

  private async scanFile(
    source: Source,
    path: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const cached = this.database
      .prepare('SELECT * FROM cost_transcript_files WHERE path = ?')
      .get(path);
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    ).catch(() => null);
    if (!file) return false;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return false;
      const identity = JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs]);
      const same =
        cached?.identity === identity && cached.provider === source.provider;
      if (same && cached.size === stat.size && cached.modified === stat.mtimeMs)
        return !cached.incomplete;
      const append = same && stat.size > Number(cached.size);
      let offset = append ? Number(cached.offset) : 0;
      const context = append
        ? contextSchema.parse(JSON.parse(String(cached.context)))
        : {};
      let incomplete = !!(append && cached.incomplete);
      const rows: Usage[] = [];
      let chunks: Buffer[] = [];
      let length = 0;
      let position = offset;
      let skipping = false;
      for await (const chunk of stat.size > offset
        ? file.createReadStream({
            start: offset,
            end: stat.size - 1,
            autoClose: false,
            signal,
          })
        : []) {
        const bytes = chunk as Buffer<ArrayBufferLike>;
        let start = 0;
        while (start < bytes.length) {
          const newline = bytes.indexOf(10, start);
          const end = newline === -1 ? bytes.length : newline;
          const part = bytes.subarray(start, end);
          length += part.length;
          if (length > maxLineBytes) {
            skipping = true;
            incomplete = true;
            chunks = [];
          }
          if (!skipping) chunks.push(part);
          start = end + Number(newline !== -1);
          if (newline === -1) break;
          if (!skipping) {
            const usage = parseLine(
              source.provider,
              context,
              chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, length),
            );
            if (usage) rows.push(usage);
          }
          offset = position + start;
          chunks = [];
          length = 0;
          skipping = false;
        }
        position += bytes.length;
      }
      if (position !== stat.size || signal.aborted) return false;
      if (length && !skipping) {
        const last = parseLine(
          source.provider,
          context,
          Buffer.concat(chunks, length),
        );
        if (last !== undefined) offset = position;
        if (last) rows.push(last);
      }
      this.saveFile(
        source,
        path,
        identity,
        stat.size,
        stat.mtimeMs,
        offset,
        context,
        incomplete,
        append,
        rows,
      );
      return !incomplete;
    } catch {
      return false;
    } finally {
      await file.close();
    }
  }

  private saveFile(
    source: Source,
    path: string,
    identity: string,
    size: number,
    modified: number,
    offset: number,
    context: Context,
    incomplete: boolean,
    append: boolean,
    rows: Usage[],
  ) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (!append)
        this.database
          .prepare('DELETE FROM cost_transcript_files WHERE path = ?')
          .run(path);
      this.database
        .prepare(
          `
        INSERT INTO cost_transcript_files (path, root, provider, identity, size, modified, offset, context, incomplete)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET size = excluded.size, modified = excluded.modified,
          offset = excluded.offset, context = excluded.context, incomplete = excluded.incomplete
      `,
        )
        .run(
          path,
          source.root,
          source.provider,
          identity,
          size,
          modified,
          offset,
          JSON.stringify(context),
          Number(incomplete),
        );
      const replace =
        source.provider === 'Codex'
          ? `WHERE json_extract(excluded.record_key, '$[0]') = 'turn'`
          : '';
      const insert = this.database.prepare(`
        INSERT INTO cost_transcript_usage
          (path, record_key, started_at, provider_session, directory, model, fast, uncached, cache_read, cache_write, output, reported)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (path, record_key) DO UPDATE SET
          started_at = min(started_at, excluded.started_at),
          reported = coalesce(excluded.reported, reported),
          directory = coalesce(excluded.directory, directory),
          model = coalesce(excluded.model, model),
          fast = excluded.fast,
          uncached = excluded.uncached,
          cache_read = excluded.cache_read,
          cache_write = excluded.cache_write,
          output = excluded.output
        ${replace}
      `);
      for (const row of rows)
        insert.run(
          path,
          row.key,
          row.at,
          row.sessionId,
          row.directory ?? null,
          row.model ?? null,
          Number(row.fast),
          row.uncached,
          row.read,
          row.write,
          row.output,
          row.reported ?? null,
        );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
