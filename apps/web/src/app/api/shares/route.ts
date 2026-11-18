import { resolveRequestOrigin } from '@/server/request-origin';
import { getSiteContext } from '@/server/site-context';
import { handleCreateShare } from '@/shares/share-handlers';

export const POST = async (request: Request): Promise<Response> => {
  const { db } = await getSiteContext();
  return handleCreateShare(request, {
    db,
    origin: resolveRequestOrigin(request),
    now: Date.now(),
  });
};
