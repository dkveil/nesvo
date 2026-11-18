import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  DatabaseStatement,
  DatabaseValue,
  SiteDatabase,
} from '@/server/database';

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'migrations');

export type TestDatabase = SiteDatabase & {
  sqlite: Database;
};

const createStatement = (
  sqlite: Database,
  query: string,
  values: DatabaseValue[],
): DatabaseStatement => ({
  bind: (...next) => createStatement(sqlite, query, next),
  first: async <TRow>() =>
    (sqlite.query(query).get(...values) as TRow | null) ?? null,
  run: async () => ({
    meta: { changes: sqlite.query(query).run(...values).changes },
  }),
});

export const createTestDatabase = (): TestDatabase => {
  const sqlite = new Database(':memory:', { strict: true });
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return {
    sqlite,
    prepare: query => createStatement(sqlite, query, []),
  };
};
