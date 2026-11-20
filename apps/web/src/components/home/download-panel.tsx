'use client';

import { CopyCommand } from '@/components/copy-command';
import { formatMegabytes } from '@/lib/format';
import {
  resolvePrimaryDownload,
  type DetectedSystem,
} from '@/releases/detect-system';
import {
  DOWNLOAD_TARGET_IDS,
  DOWNLOAD_TARGETS,
  type DownloadTargetId,
} from '@/releases/download-targets';
import type { PublishedRelease, ReleaseState } from '@/releases/release-state';

import { DownloadButton, InactiveDownloadButton } from './download-button';
import { FirstLaunchNotes } from './first-launch-notes';
import { PlatformList } from './platform-list';
import { QuietDisclosures, type QuietDisclosure } from './quiet-disclosures';
import { ReleaseChecksums } from './release-checksums';
import { useDetectedSystem } from './use-detected-system';

type DownloadPanelProps = {
  release: ReleaseState;
  initialSystem: DetectedSystem;
  installCommand: string;
};

const isTargetAvailable = (release: ReleaseState, target: DownloadTargetId) =>
  release.status === 'unavailable' ||
  (release.status === 'published' &&
    release.release.downloads.some(
      item => item.target === target && item.isPublished,
    ));

const versionMeta = (release: PublishedRelease) =>
  `v${release.version} · ${release.isPrerelease ? 'Pre-release' : 'Latest'}`;

const primaryMeta = (release: ReleaseState, target: DownloadTargetId) => {
  if (release.status !== 'published')
    return DOWNLOAD_TARGETS[target].buttonDetail;
  const size = release.release.downloads.find(
    item => item.target === target,
  )?.sizeBytes;
  return [
    versionMeta(release.release),
    DOWNLOAD_TARGETS[target].buttonDetail,
    formatMegabytes(size ?? null),
  ]
    .filter(Boolean)
    .join(' · ');
};

const ReleaseChannelNotes = ({ release }: { release: ReleaseState }) => {
  if (release.status !== 'published') return null;
  if (release.release.isPrerelease) {
    return <p className="download-meta">Early build for testing.</p>;
  }
  const preview = release.secondaryPreview;
  return preview ? (
    <p className="download-meta">
      <a href={preview.notesUrl}>Try {preview.version} (pre-release)</a>
    </p>
  ) : null;
};

const isMacTarget = (target: DownloadTargetId) =>
  target === 'mac' || target === 'mac-intel';

const firstLaunchDisclosure: QuietDisclosure = {
  key: 'first-launch',
  label: 'First launch',
  content: <FirstLaunchNotes />,
};

const checksumsDisclosures = (release: ReleaseState): QuietDisclosure[] =>
  release.status === 'published'
    ? [
        {
          key: 'checksums',
          label: 'Checksums',
          content: <ReleaseChecksums release={release.release} />,
        },
      ]
    : [];

export const DownloadPanel = ({
  release,
  initialSystem,
  installCommand,
}: DownloadPanelProps) => {
  const system = useDetectedSystem(initialSystem);
  const primary = resolvePrimaryDownload(system);
  const target = primary.target;

  if (release.status === 'none') {
    return (
      <div className="download" data-os={system.os}>
        <InactiveDownloadButton
          label={target ? DOWNLOAD_TARGETS[target].buttonLabel : 'Download'}
        />
        <p className="download-meta" role="status">
          The first build is on its way.
        </p>
      </div>
    );
  }

  if (!target || !isTargetAvailable(release, target)) {
    return (
      <div className="download" data-os={system.os}>
        <p className="download-meta">
          {release.status === 'published'
            ? versionMeta(release.release)
            : 'Available for macOS and Windows.'}
        </p>
        <ReleaseChannelNotes release={release} />
        <section className="download-list" aria-labelledby="platforms-title">
          <h2 id="platforms-title" className="visually-hidden">
            All platforms
          </h2>
          <PlatformList release={release} targets={DOWNLOAD_TARGET_IDS} />
        </section>
        <QuietDisclosures
          items={[...checksumsDisclosures(release), firstLaunchDisclosure]}
        />
      </div>
    );
  }

  const isMacPrimary = isMacTarget(target);
  const hasInstallCommand = release.status === 'published';
  const otherTargets = DOWNLOAD_TARGET_IDS.filter(item => item !== target);

  return (
    <div className="download" data-os={system.os}>
      <DownloadButton
        href={`/download/${target}`}
        label={DOWNLOAD_TARGETS[target].buttonLabel}
      />
      <p className="download-meta">{primaryMeta(release, target)}</p>
      <ReleaseChannelNotes release={release} />
      {release.status === 'unavailable' ? (
        <p className="download-meta">
          Release details cannot be loaded right now.{' '}
          <a href="/releases">All releases</a>
        </p>
      ) : null}
      {isMacPrimary && hasInstallCommand ? (
        <CopyCommand command={installCommand} label="macOS install command" />
      ) : null}
      <QuietDisclosures
        items={[
          {
            key: 'platforms',
            label: 'Other platforms',
            content: (
              <>
                <PlatformList release={release} targets={otherTargets} />
                {!isMacPrimary && hasInstallCommand ? (
                  <div className="panel-install">
                    <p className="panel-label">macOS from Terminal</p>
                    <CopyCommand
                      command={installCommand}
                      label="macOS install command"
                    />
                  </div>
                ) : null}
              </>
            ),
          },
          ...checksumsDisclosures(release),
          firstLaunchDisclosure,
        ]}
        links={
          target === 'mac' && !primary.isArchitectureKnown ? (
            <a className="quiet-toggle" href="/download/mac-intel">
              Intel Mac?
            </a>
          ) : null
        }
      />
    </div>
  );
};
