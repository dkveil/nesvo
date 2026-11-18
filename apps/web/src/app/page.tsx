import { headers } from 'next/headers';

import { HomeView } from '@/components/home/home-view';
import { detectSystem, readSystemHints } from '@/releases/detect-system';
import { installCommandFor } from '@/releases/install-script';
import { loadReleaseState } from '@/releases/load-release-state';
import { resolveOrigin } from '@/server/request-origin';
import { getSiteContext } from '@/server/site-context';

const HomePage = async () => {
  const [requestHeaders, { db, config }] = await Promise.all([
    headers(),
    getSiteContext(),
  ]);
  const release = await loadReleaseState({ db, config });
  return (
    <HomeView
      release={release}
      system={detectSystem(readSystemHints(requestHeaders))}
      installCommand={installCommandFor(
        resolveOrigin(requestHeaders.get('host')),
      )}
    />
  );
};

export default HomePage;
