import { SiteFooter } from '@/components/site-footer';
import { GlitchWordmark } from '@/components/wordmark';
import type { DetectedSystem } from '@/releases/detect-system';
import type { ReleaseState } from '@/releases/release-state';

import { DownloadPanel } from './download-panel';

type HomeViewProps = {
  release: ReleaseState;
  system: DetectedSystem;
  installCommand: string;
};

export const HomeView = ({
  release,
  system,
  installCommand,
}: HomeViewProps) => (
  <>
    <main className="home">
      <h1 className="home-title">
        <GlitchWordmark />
      </h1>
      <p className="slogan">Vibe with full control.</p>
      <p className="tagline">
        Run Claude Code and Codex sessions in parallel, on your rules.
      </p>
      <DownloadPanel
        release={release}
        initialSystem={system}
        installCommand={installCommand}
      />
    </main>
    <SiteFooter />
  </>
);
