import {
  isDownloadTargetId,
  releaseAssetsUrl,
  releasesUrl,
} from '@/releases/download-targets';
import { loadReleaseState } from '@/releases/load-release-state';
import { getSiteContext } from '@/server/site-context';

type DownloadRouteContext = {
  params: Promise<{ target: string }>;
};

export const GET = async (
  request: Request,
  { params }: DownloadRouteContext,
): Promise<Response> => {
  const { target } = await params;
  if (!isDownloadTargetId(target)) {
    return Response.redirect(new URL('/', request.url), 302);
  }
  const { db, config } = await getSiteContext();
  const state = await loadReleaseState({ db, config });
  if (state.status === 'published') {
    const asset = state.release.downloads.find(
      item => item.target === target && item.isPublished,
    );
    if (asset) {
      const base = releaseAssetsUrl(
        config.releaseRepository,
        state.release.tagName,
      );
      return Response.redirect(
        `${base}/${encodeURIComponent(asset.fileName)}`,
        302,
      );
    }
  }
  return Response.redirect(releasesUrl(config.releaseRepository), 302);
};
