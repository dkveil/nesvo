export type DatabaseRunResult = {
  meta: { changes: number };
};

export type DatabaseValue = string | number | null;

export type DatabaseStatement = {
  bind: (...values: DatabaseValue[]) => DatabaseStatement;
  first: <TRow = Record<string, unknown>>() => Promise<TRow | null>;
  run: () => Promise<DatabaseRunResult>;
};

export type SiteDatabase = {
  prepare: (query: string) => DatabaseStatement;
};
