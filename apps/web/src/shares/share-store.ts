import {
  WORKFLOW_SHARE_RETENTION_MS,
  workflowShareBundleSchema,
  type WorkflowShareBundle,
} from '@nesvo/contracts/workflow-share';

import type { SiteDatabase } from '../server/database';

export type ShareLookup =
  | {
      status: 'active';
      bundleJson: string;
      createdAt: number;
      expiresAt: number;
    }
  | { status: 'expired'; expiresAt: number }
  | { status: 'missing' };

type ShareRow = {
  bundle: string;
  created_at: number;
  expires_at: number;
};

type InsertShareParams = {
  id: string;
  bundle: WorkflowShareBundle;
  revokeTokenHash: string;
  now: number;
};

export const insertShare = async (
  db: SiteDatabase,
  { id, bundle, revokeTokenHash, now }: InsertShareParams,
): Promise<{ expiresAt: number }> => {
  const expiresAt = now + WORKFLOW_SHARE_RETENTION_MS;
  await db
    .prepare(
      `INSERT INTO shares (id, bundle, revoke_token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, JSON.stringify(bundle), revokeTokenHash, now, expiresAt)
    .run();
  return { expiresAt };
};

export const findShare = async (
  db: SiteDatabase,
  id: string,
  now: number,
): Promise<ShareLookup> => {
  const row = await db
    .prepare('SELECT bundle, created_at, expires_at FROM shares WHERE id = ?')
    .bind(id)
    .first<ShareRow>();
  if (!row) return { status: 'missing' };
  if (row.expires_at <= now) {
    return { status: 'expired', expiresAt: row.expires_at };
  }
  return {
    status: 'active',
    bundleJson: row.bundle,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
};

export const parseStoredBundle = (
  bundleJson: string,
): WorkflowShareBundle | null => {
  try {
    const parsed = workflowShareBundleSchema.safeParse(JSON.parse(bundleJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const findRevokeTokenHash = async (
  db: SiteDatabase,
  id: string,
): Promise<string | null> => {
  const row = await db
    .prepare('SELECT revoke_token_hash FROM shares WHERE id = ?')
    .bind(id)
    .first<{ revoke_token_hash: string }>();
  return row?.revoke_token_hash ?? null;
};

export const deleteShare = async (
  db: SiteDatabase,
  id: string,
): Promise<boolean> => {
  const result = await db
    .prepare('DELETE FROM shares WHERE id = ?')
    .bind(id)
    .run();
  return result.meta.changes > 0;
};

export const deleteExpiredShares = async (
  db: SiteDatabase,
  now: number,
): Promise<number> => {
  const result = await db
    .prepare('DELETE FROM shares WHERE expires_at <= ?')
    .bind(now)
    .run();
  return result.meta.changes;
};
