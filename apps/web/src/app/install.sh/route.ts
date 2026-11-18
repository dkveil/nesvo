import { renderInstallScript } from '@/releases/install-script';
import { getSiteContext } from '@/server/site-context';

export const GET = async (): Promise<Response> => {
  const { config } = await getSiteContext();
  return new Response(renderInstallScript(config.releaseRepository), {
    headers: {
      'Content-Type': 'text/x-shellscript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
