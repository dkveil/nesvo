import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  historySearchPageSchema,
  type HistorySearchInput,
  type HistorySearchPage,
  type HistorySearchResult,
} from '@nesvo/contracts';
import { backfillHistoryBatch } from './history-index';

const FALLBACK_ROWS = 4000;
const PAGE_HORIZON = 10_000;
const SNIPPET_LENGTH = 360;

type Snippet = HistorySearchResult['snippet'];

function clipSnippet(text: string, ranges: Snippet['ranges']): Snippet {
  const first = ranges[0]?.start ?? 0;
  const start = Math.max(0, first - 72);
  const end = Math.min(text.length, start + SNIPPET_LENGTH - 2);
  const prefix = start ? '…' : '';
  return {
    text: prefix + text.slice(start, end) + (end < text.length ? '…' : ''),
    ranges: ranges
      .filter(range => range.end > start && range.start < end)
      .map(range => ({
        start: Math.max(range.start, start) - start + prefix.length,
        end: Math.min(range.end, end) - start + prefix.length,
      })),
  };
}

function ftsSnippet(value: string, open: string, close: string): Snippet {
  const ranges: Snippet['ranges'] = [];
  let text = '';
  for (const part of value.split(open)) {
    const end = part.indexOf(close);
    if (end > 0) {
      ranges.push({ start: text.length, end: text.length + end });
      text += part.slice(0, end) + part.slice(end + close.length);
    } else {
      text += part;
    }
  }
  return clipSnippet(text, ranges);
}

function likeSnippet(value: string, terms: string[]): Snippet {
  const pattern = new RegExp(
    terms.toSorted((a, b) => b.length - a.length).join('|'),
    'giu',
  );
  const ranges: Snippet['ranges'] = [];
  for (const match of value.matchAll(pattern)) {
    const end = match.index + match[0].length;
    const previous = ranges.at(-1);
    if (previous?.end === match.index) previous.end = end;
    else ranges.push({ start: match.index, end });
  }
  return clipSnippet(value, ranges);
}

const resultColumns = `
  entries.session_id AS sessionId, nullif(entries.message_id, '') AS messageId,
  sessions.document ->> '$.title' AS title,
  sessions.document ->> '$.directory' AS directory,
  sessions.document ->> '$.provider' AS provider,
  entries.role, entries.created_at AS createdAt
`;

export class HistorySearch {
  private readonly useFts: boolean;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly database: DatabaseSync) {
    this.useFts =
      database
        .prepare("SELECT value FROM metadata WHERE key = 'history_index_mode'")
        .get()?.value === 'fts5';
    if (!this.useFts)
      database.function('history_fold', { deterministic: true }, text =>
        String(text).toLowerCase(),
      );
  }

  start() {
    this.timer = setTimeout(() => {
      try {
        if (backfillHistoryBatch(this.database)) this.start();
      } catch (error) {
        console.error('Could not backfill session history:', error);
      }
    }, 0).unref();
  }

  close() {
    clearTimeout(this.timer);
  }

  search({ query, limit = 30, cursor }: HistorySearchInput): HistorySearchPage {
    const terms = [
      ...new Set(query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []),
    ];
    if (!terms.length)
      return { results: [], truncated: false, nextCursor: null };
    const offset = Number(cursor ?? 0);
    const batch = Math.min(limit, PAGE_HORIZON - offset);
    const open = randomUUID();
    const close = randomUUID();
    let rows: Record<string, SQLOutputValue>[];
    if (this.useFts) {
      rows = this.database
        .prepare(
          `
        SELECT ${resultColumns}, snippet(history_fts, 0, ?, ?, '…', 24) AS excerpt
        FROM history_fts
        JOIN history_entries AS entries ON entries.id = history_fts.rowid
        JOIN sessions ON sessions.id = entries.session_id
        WHERE history_fts MATCH ?
        ORDER BY history_fts.rank, entries.created_at DESC, entries.id DESC
        LIMIT ? OFFSET ?
      `,
        )
        .all(
          open,
          close,
          terms.map(term => `"${term}"`).join(' AND '),
          batch + 1,
          offset,
        );
    } else {
      const filters = terms
        .map(() => "folded LIKE '%' || ? || '%'")
        .join(' AND ');
      rows = this.database
        .prepare(
          `
        WITH recent AS MATERIALIZED (
          SELECT *, history_fold(body) AS folded
          FROM history_entries ORDER BY created_at DESC, id DESC LIMIT ${FALLBACK_ROWS}
        ), matches AS (
          SELECT * FROM recent
          WHERE ${filters}
          ORDER BY instr(folded, ?) = 0, length(body), created_at DESC, id DESC
          LIMIT ? OFFSET ?
        )
        SELECT ${resultColumns}, entries.body AS excerpt
        FROM matches AS entries
        JOIN sessions ON sessions.id = entries.session_id
        ORDER BY instr(entries.folded, ?) = 0, length(entries.body), entries.created_at DESC, entries.id DESC
      `,
        )
        .all(...terms, terms.join(' '), batch + 1, offset, terms.join(' '));
    }
    const hasMore = rows.length > batch;
    const nextOffset = offset + batch;
    const backfilling = !!this.database
      .prepare("SELECT 1 FROM metadata WHERE key = 'history_backfill'")
      .get();
    const scanCapped =
      !this.useFts &&
      !!this.database
        .prepare('SELECT 1 FROM history_entries LIMIT 1 OFFSET ?')
        .get(FALLBACK_ROWS);
    return historySearchPageSchema.parse({
      results: rows.slice(0, batch).map(({ excerpt, ...row }) => ({
        ...row,
        snippet: this.useFts
          ? ftsSnippet(String(excerpt), open, close)
          : likeSnippet(String(excerpt), terms),
      })),
      truncated: hasMore || backfilling || scanCapped,
      nextCursor:
        hasMore && nextOffset < PAGE_HORIZON ? String(nextOffset) : null,
    });
  }
}
