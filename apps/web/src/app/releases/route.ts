import { releasesUrl } from '@/releases/download-targets';
import { getSiteContext } from '@/server/site-context';

export const GET = async (): Promise<Response> => {
  const { config } = await getSiteContext();
  return Response.redirect(releasesUrl(config.releaseRepository), 302);
};
