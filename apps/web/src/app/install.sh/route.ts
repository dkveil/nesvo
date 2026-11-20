import { renderInstallScript } from '@/releases/install-script';
import { loadReleaseState } from '@/releases/load-release-state';
import { getSiteContext } from '@/server/site-context';

export const GET = async (): Promise<Response> => {
  const { db, config } = await getSiteContext();
  const state = await loadReleaseState({ db, config });
  if (state.status !== 'published') {
    return new Response(null, {
      status: state.status === 'none' ? 404 : 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  return new Response(
    renderInstallScript(config.releaseRepository, state.release.tagName),
    {
      headers: {
        'Content-Type': 'text/x-shellscript; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    },
  );
};
