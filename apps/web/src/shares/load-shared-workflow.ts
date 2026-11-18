import type { WorkflowShareBundle } from '@nesvo/contracts/workflow-share';

import type { SiteDatabase } from '@/server/database';

import { findShare, parseStoredBundle } from './share-store';

export type SharedWorkflow =
  | {
      status: 'active';
      bundle: WorkflowShareBundle;
      expiresAt: number;
      now: number;
    }
  | { status: 'expired' | 'missing' | 'unreadable' };

export const loadSharedWorkflow = async (
  db: SiteDatabase | null,
  id: string,
  now = Date.now(),
): Promise<SharedWorkflow> => {
  if (!db) return { status: 'unreadable' };
  const share = await findShare(db, id, now);
  if (share.status !== 'active') return { status: share.status };
  const bundle = parseStoredBundle(share.bundleJson);
  if (!bundle) return { status: 'unreadable' };
  return { status: 'active', bundle, expiresAt: share.expiresAt, now };
};
