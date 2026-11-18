import { WORKFLOW_SHARE_ID_PATTERN } from '@nesvo/contracts/workflow-share';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { ShareUnavailable } from '@/components/share/share-unavailable';
import { ShareView } from '@/components/share/share-view';
import { resolveOrigin } from '@/server/request-origin';
import { getSiteContext } from '@/server/site-context';
import { loadSharedWorkflow } from '@/shares/load-shared-workflow';

export const metadata: Metadata = {
  title: 'Shared workflow · Nesvo',
  referrer: 'no-referrer',
};

type SharePageProps = {
  params: Promise<{ id: string }>;
};

const SharePage = async ({ params }: SharePageProps) => {
  const [{ id }, requestHeaders, { db }] = await Promise.all([
    params,
    headers(),
    getSiteContext(),
  ]);
  if (!WORKFLOW_SHARE_ID_PATTERN.test(id)) notFound();
  const share = await loadSharedWorkflow(db, id);
  if (share.status === 'missing') notFound();
  if (share.status !== 'active') {
    return <ShareUnavailable reason={share.status} />;
  }
  return (
    <ShareView
      id={id}
      origin={resolveOrigin(requestHeaders.get('host'))}
      bundle={share.bundle}
      expiresAt={share.expiresAt}
      now={share.now}
    />
  );
};

export default SharePage;
