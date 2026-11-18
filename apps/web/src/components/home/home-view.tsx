import { SiteFooter } from '@/components/site-footer';
import { Wordmark } from '@/components/wordmark';
import type { DetectedSystem } from '@/releases/detect-system';
import type { ReleaseState } from '@/releases/release-state';

import { DownloadPanel } from './download-panel';
import { ReleaseDetails } from './release-details';
import { UnsignedNotes } from './unsigned-notes';

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
    <main className="page">
      <div className="hero">
        <h1 className="wordmark">
          <Wordmark />
        </h1>
        <p className="tagline">
          A desktop app to run and supervise AI coding sessions with the Claude
          Code and Codex CLIs you already use.
        </p>
        <DownloadPanel
          release={release}
          initialSystem={system}
          installCommand={installCommand}
        />
      </div>
      <div className="sections">
        <ReleaseDetails release={release} />
        <UnsignedNotes />
      </div>
    </main>
    <SiteFooter />
  </>
);
