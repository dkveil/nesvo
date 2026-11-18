import { resolveRequestOrigin } from '@/server/request-origin';
import { getSiteContext } from '@/server/site-context';
import { handleReadShare, handleRevokeShare } from '@/shares/share-handlers';

type ShareRouteContext = {
  params: Promise<{ id: string }>;
};

export const GET = async (
  request: Request,
  { params }: ShareRouteContext,
): Promise<Response> => {
  const [{ id }, { db }] = await Promise.all([params, getSiteContext()]);
  return handleReadShare(id, {
    db,
    origin: resolveRequestOrigin(request),
    now: Date.now(),
  });
};

export const DELETE = async (
  request: Request,
  { params }: ShareRouteContext,
): Promise<Response> => {
  const [{ id }, { db }] = await Promise.all([params, getSiteContext()]);
  return handleRevokeShare(request, id, {
    db,
    origin: resolveRequestOrigin(request),
    now: Date.now(),
  });
};
