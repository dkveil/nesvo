import {
  DOWNLOAD_TARGETS,
  isDownloadTargetId,
  latestAssetUrl,
} from '@/releases/download-targets';
import { getSiteContext } from '@/server/site-context';

type DownloadRouteContext = {
  params: Promise<{ target: string }>;
};

export const GET = async (
  request: Request,
  { params }: DownloadRouteContext,
): Promise<Response> => {
  const [{ target }, { config }] = await Promise.all([
    params,
    getSiteContext(),
  ]);
  if (!isDownloadTargetId(target)) {
    return Response.redirect(new URL('/', request.url), 302);
  }
  return Response.redirect(
    latestAssetUrl(config.releaseRepository, DOWNLOAD_TARGETS[target].fileName),
    302,
  );
};
