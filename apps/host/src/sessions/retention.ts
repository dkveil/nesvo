import type { DatabaseSync } from 'node:sqlite';

const DAY_MS = 24 * 60 * 60 * 1000;

export function readRetentionDays(database: DatabaseSync): number | null {
  const days = Number(
    database
      .prepare(
        "SELECT value FROM metadata WHERE key = 'transcript_retention_days'",
      )
      .get()?.value,
  );
  return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : null;
}

export function retentionCutoff(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * DAY_MS);
}
