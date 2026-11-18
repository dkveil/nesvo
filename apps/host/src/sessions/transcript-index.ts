import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  providerSchema,
  transcriptSearchPageSchema,
  type Provider,
  type TranscriptSearchPage,
} from '@nesvo/contracts';
import {
  fileByteLimit,
  inventory,
  readTranscript,
  type Transcript,
  type TranscriptFile,
} from './conversation-transcripts';
import { supportsFts } from './history-index';
import { ftsSnippet, likeSnippet } from './history-search';
import type { SessionStore } from './store';

const PROVIDERS: Provider[] = ['Claude Code', 'Codex'];
const TRANSCRIPT_FILE_LIMIT = 300;
const REFRESH_BYTE_LIMIT = 64 * 1024 * 1024;
const REFRESH_TIME_LIMIT_MS = 20_000;
const REFRESH_INTERVAL_MS = 2_000;
const TRANSCRIPT_CHARACTER_LIMIT = 32_768;
const MATCH_ROW_LIMIT = 400;
const INDEX_LIMITS = { messages: 400, characters: 4000 };

type SearchInput = { query: string; limit: number };
type Refresh = { skippedFiles: number; truncated: boolean };

export function installTranscriptIndex(database: DatabaseSync) {
  const mode = supportsFts(database) ? 'fts5' : 'like';
  const previous = database
    .prepare("SELECT value FROM metadata WHERE key = 'transcript_index_mode'")
    .get()?.value;
  if (previous !== mode)
    database.exec(`
      DROP TRIGGER IF EXISTS transcript_fts_insert;
      DROP TRIGGER IF EXISTS transcript_fts_delete;
      DROP TABLE IF EXISTS transcript_fts;
      DROP TABLE IF EXISTS transcript_entries;
      DROP TABLE IF EXISTS transcript_files;
    `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS transcript_files (
      path TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('Claude Code', 'Codex')),
      provider_session_id TEXT NOT NULL,
      size INTEGER NOT NULL,
      modified_at REAL NOT NULL,
      directory TEXT,
      title TEXT,
      last_activity_at TEXT,
      indexed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS transcript_files_provider ON transcript_files (provider, provider_session_id);
    CREATE TABLE IF NOT EXISTS transcript_entries (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL REFERENCES transcript_files(path) ON DELETE CASCADE,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS transcript_entries_path ON transcript_entries (path);
  `);
  if (mode === 'fts5')
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
        body, content = 'transcript_entries', content_rowid = 'id'
      );
      CREATE TRIGGER IF NOT EXISTS transcript_fts_insert AFTER INSERT ON transcript_entries BEGIN
        INSERT INTO transcript_fts (rowid, body) VALUES (NEW.id, NEW.body);
      END;
      CREATE TRIGGER IF NOT EXISTS transcript_fts_delete AFTER DELETE ON transcript_entries BEGIN
        INSERT INTO transcript_fts (transcript_fts, rowid, body) VALUES ('delete', OLD.id, OLD.body);
      END;
    `);
  database
    .prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('transcript_index_mode', ?)",
    )
    .run(mode);
}

function indexedBodies(transcript: Transcript) {
  const bodies: string[] = [];
  let characters = 0;
  for (const message of transcript.messages.toReversed()) {
    if (characters + message.body.length > TRANSCRIPT_CHARACTER_LIMIT) break;
    characters += message.body.length;
    bodies.push(message.body);
  }
  return bodies;
}

export class TranscriptIndex {
  private readonly useFts: boolean;
  private refreshing: Promise<Refresh> | undefined;
  private refreshedAt = 0;
  private last: Refresh = { skippedFiles: 0, truncated: false };

  constructor(
    private readonly database: DatabaseSync,
    private readonly store: SessionStore,
    private readonly signal: AbortSignal,
  ) {
    this.useFts =
      database
        .prepare(
          "SELECT value FROM metadata WHERE key = 'transcript_index_mode'",
        )
        .get()?.value === 'fts5';
    if (!this.useFts)
      database.function('transcript_fold', { deterministic: true }, text =>
        String(text).toLowerCase(),
      );
  }

  async search({ query, limit }: SearchInput): Promise<TranscriptSearchPage> {
    const refresh = await this.refresh();
    const terms = [
      ...new Set(query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []),
    ];
    const indexedTranscripts = Number(
      this.database
        .prepare(
          'SELECT count(*) AS count FROM transcript_files WHERE directory IS NOT NULL',
        )
        .get()?.count ?? 0,
    );
    if (!terms.length) return { results: [], indexedTranscripts, ...refresh };
    const open = randomUUID();
    const close = randomUUID();
    const rows = this.matches(terms, open, close);
    const recorded = new Set(
      this.store
        .providerConversations()
        .filter(row => row.profileId === null)
        .map(row => row.provider + ':' + row.providerSessionId),
    );
    const seen = new Set<string>();
    const results: TranscriptSearchPage['results'] = [];
    let more = false;
    for (const row of rows) {
      const provider = providerSchema.parse(row.provider);
      const providerSessionId = String(row.providerSessionId);
      const key = provider + ':' + providerSessionId;
      if (seen.has(key) || recorded.has(key)) continue;
      seen.add(key);
      if (results.length === limit) {
        more = true;
        break;
      }
      results.push({
        provider,
        providerSessionId,
        directory: String(row.directory),
        title: String(row.title),
        lastActivityAt: String(row.lastActivityAt),
        snippet: this.useFts
          ? ftsSnippet(String(row.excerpt), open, close)
          : likeSnippet(String(row.excerpt), terms),
      });
    }
    return transcriptSearchPageSchema.parse({
      results,
      indexedTranscripts,
      skippedFiles: refresh.skippedFiles,
      truncated: refresh.truncated || rows.length === MATCH_ROW_LIMIT || more,
    });
  }

  private matches(
    terms: string[],
    open: string,
    close: string,
  ): Record<string, SQLOutputValue>[] {
    const columns = `
      files.provider, files.provider_session_id AS providerSessionId,
      files.directory, files.title, files.last_activity_at AS lastActivityAt
    `;
    if (this.useFts)
      return this.database
        .prepare(
          `
        SELECT ${columns}, snippet(transcript_fts, 0, ?, ?, '…', 24) AS excerpt
        FROM transcript_fts
        JOIN transcript_entries AS entries ON entries.id = transcript_fts.rowid
        JOIN transcript_files AS files ON files.path = entries.path
        WHERE transcript_fts MATCH ? AND files.directory IS NOT NULL
        ORDER BY transcript_fts.rank, files.last_activity_at DESC, entries.id DESC
        LIMIT ${MATCH_ROW_LIMIT}
      `,
        )
        .all(open, close, terms.map(term => `"${term}"`).join(' AND '));
    return this.database
      .prepare(
        `
      SELECT ${columns}, entries.body AS excerpt
      FROM transcript_entries AS entries
      JOIN transcript_files AS files ON files.path = entries.path
      WHERE files.directory IS NOT NULL AND ${terms
        .map(() => "transcript_fold(entries.body) LIKE '%' || ? || '%'")
        .join(' AND ')}
      ORDER BY files.last_activity_at DESC, entries.id DESC
      LIMIT ${MATCH_ROW_LIMIT}
    `,
      )
      .all(...terms);
  }

  private refresh(): Promise<Refresh> {
    if (this.refreshing) return this.refreshing;
    if (Date.now() - this.refreshedAt < REFRESH_INTERVAL_MS)
      return Promise.resolve(this.last);
    const refreshing = this.rebuild().then(
      result => {
        this.last = result;
        this.refreshedAt = Date.now();
        return result;
      },
      error => {
        this.signal.throwIfAborted();
        throw error;
      },
    );
    this.refreshing = refreshing;
    void refreshing
      .finally(() => {
        this.refreshing = undefined;
      })
      .catch(() => undefined);
    return refreshing;
  }

  private async rebuild(): Promise<Refresh> {
    const deadline = Date.now() + REFRESH_TIME_LIMIT_MS;
    let skippedFiles = 0;
    let truncated = false;
    for (const provider of PROVIDERS) {
      const listing = await inventory(provider, this.signal);
      const files = listing.files.slice(0, TRANSCRIPT_FILE_LIMIT);
      skippedFiles += listing.skippedFiles;
      truncated ||=
        listing.truncated || listing.files.length > TRANSCRIPT_FILE_LIMIT;
      this.forget(provider, new Set(files.map(file => file.path)));
      const known = new Map(
        this.database
          .prepare(
            'SELECT path, size, modified_at AS modifiedAt FROM transcript_files WHERE provider = ?',
          )
          .all(provider)
          .map(row => [String(row.path), row]),
      );
      let bytes = 0;
      for (const file of files) {
        this.signal.throwIfAborted();
        const row = known.get(file.path);
        if (row?.size === file.size && row.modifiedAt === file.modifiedAt)
          continue;
        if (file.size > fileByteLimit) {
          this.write(provider, file, undefined);
          continue;
        }
        if (bytes + file.size > REFRESH_BYTE_LIMIT || Date.now() > deadline) {
          truncated = true;
          break;
        }
        bytes += file.size;
        let transcript: Transcript | undefined;
        try {
          transcript = await readTranscript(
            file,
            provider,
            this.signal,
            INDEX_LIMITS,
          );
        } catch {
          this.signal.throwIfAborted();
        }
        this.write(provider, file, transcript);
      }
    }
    skippedFiles += Number(
      this.database
        .prepare(
          'SELECT count(*) AS count FROM transcript_files WHERE directory IS NULL',
        )
        .get()?.count ?? 0,
    );
    return { skippedFiles, truncated };
  }

  private forget(provider: Provider, keep: Set<string>) {
    const stale = this.database
      .prepare('SELECT path FROM transcript_files WHERE provider = ?')
      .all(provider)
      .map(row => String(row.path))
      .filter(path => !keep.has(path));
    if (!stale.length) return;
    this.transaction(() => {
      const remove = this.database.prepare(
        'DELETE FROM transcript_files WHERE path = ?',
      );
      for (const path of stale) remove.run(path);
    });
  }

  private write(
    provider: Provider,
    file: TranscriptFile,
    transcript: Transcript | undefined,
  ) {
    this.transaction(() => {
      this.database
        .prepare('DELETE FROM transcript_entries WHERE path = ?')
        .run(file.path);
      this.database
        .prepare(
          `
        INSERT INTO transcript_files (path, provider, provider_session_id, size, modified_at, directory, title, last_activity_at, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          provider = excluded.provider, provider_session_id = excluded.provider_session_id,
          size = excluded.size, modified_at = excluded.modified_at, directory = excluded.directory,
          title = excluded.title, last_activity_at = excluded.last_activity_at, indexed_at = excluded.indexed_at
      `,
        )
        .run(
          file.path,
          provider,
          file.id,
          file.size,
          file.modifiedAt,
          transcript?.conversation.directory ?? null,
          transcript?.conversation.title ?? null,
          transcript?.conversation.lastActivityAt ?? null,
          new Date().toISOString(),
        );
      if (!transcript) return;
      const insert = this.database.prepare(
        'INSERT INTO transcript_entries (path, body) VALUES (?, ?)',
      );
      for (const body of indexedBodies(transcript)) insert.run(file.path, body);
    });
  }

  private transaction(change: () => void) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      change();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
