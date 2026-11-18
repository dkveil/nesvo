import { repositoryUrl } from '@/releases/download-targets';
import { getSiteContext } from '@/server/site-context';

export const GET = async (): Promise<Response> => {
  const { config } = await getSiteContext();
  return Response.redirect(repositoryUrl(config.releaseRepository), 302);
};
