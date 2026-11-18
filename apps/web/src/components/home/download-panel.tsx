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
import type { ReleaseState } from '@/releases/release-state';

import { DownloadButton } from './download-button';
import { useDetectedSystem } from './use-detected-system';

type DownloadPanelProps = {
  release: ReleaseState;
  initialSystem: DetectedSystem;
  installCommand: string;
};

type TargetAvailability = 'published' | 'missing' | 'unknown';

const availabilityOf = (
  release: ReleaseState,
  target: DownloadTargetId,
): TargetAvailability => {
  if (release.status === 'unavailable') return 'unknown';
  if (release.status === 'none') return 'missing';
  const download = release.release.downloads.find(
    item => item.target === target,
  );
  return download?.isPublished ? 'published' : 'missing';
};

const versionLabel = (release: ReleaseState): string | null =>
  release.status === 'published' ? `v${release.release.version}` : null;

const sizeOf = (release: ReleaseState, target: DownloadTargetId) =>
  release.status === 'published'
    ? formatMegabytes(
        release.release.downloads.find(item => item.target === target)
          ?.sizeBytes ?? null,
      )
    : null;

const isMacTarget = (target: DownloadTargetId | null) =>
  target === 'mac' || target === 'mac-intel';

export const DownloadPanel = ({
  release,
  initialSystem,
  installCommand,
}: DownloadPanelProps) => {
  const system = useDetectedSystem(initialSystem);
  const primary = resolvePrimaryDownload(system);
  const primaryTarget = primary.target;
  const primaryAvailability = primaryTarget
    ? availabilityOf(release, primaryTarget)
    : 'missing';
  const hasRelease = release.status !== 'none';
  const hasPrimaryButton = !!primaryTarget && primaryAvailability !== 'missing';
  const otherTargets = DOWNLOAD_TARGET_IDS.filter(
    target => !hasPrimaryButton || target !== primaryTarget,
  );
  const isMacPrimary = hasPrimaryButton && isMacTarget(primaryTarget);
  const showInstallCommand = release.status !== 'none';

  return (
    <div className="downloads" data-os={system.os}>
      <section className="download" aria-label="Download">
        {primaryTarget && hasPrimaryButton ? (
          <DownloadButton
            href={`/download/${primaryTarget}`}
            label={DOWNLOAD_TARGETS[primaryTarget].buttonLabel}
            detail={[
              DOWNLOAD_TARGETS[primaryTarget].buttonDetail,
              versionLabel(release),
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        ) : (
          <div className="download-placeholder" role="status">
            <span className="download-label">
              {hasRelease ? 'Choose your platform' : 'Downloads coming soon'}
            </span>
            <span className="download-detail">
              {hasRelease
                ? 'Nesvo runs on Windows and macOS'
                : 'No release is published yet'}
            </span>
          </div>
        )}

        {hasPrimaryButton &&
        primaryTarget === 'mac' &&
        !primary.isArchitectureKnown ? (
          <p className="download-alt">
            Intel Mac? <a href="/download/mac-intel">Get the Intel build</a>
          </p>
        ) : null}

        {primaryTarget && hasPrimaryButton ? (
          <p className="first-launch">
            <span className="first-launch-tag">First launch</span>
            {DOWNLOAD_TARGETS[primaryTarget].firstLaunch}
          </p>
        ) : null}

        {!hasRelease ? (
          <p className="first-launch">
            The first build is on its way. Follow{' '}
            <a href="/github">the repository</a> to hear when it is out.
          </p>
        ) : null}

        {isMacPrimary && showInstallCommand ? (
          <div className="install">
            <p className="install-title">Or install from Terminal</p>
            <CopyCommand command={installCommand} label="Install command" />
          </div>
        ) : null}
      </section>

      <section className="platforms" aria-labelledby="platforms-title">
        <h2 id="platforms-title" className="section-label">
          {hasPrimaryButton ? 'Other platforms' : 'All platforms'}
        </h2>
        <ul className="platform-list">
          {otherTargets.map(target => {
            const availability = availabilityOf(release, target);
            const size = sizeOf(release, target);
            return (
              <li key={target} className="platform-row">
                <span className="platform-name">
                  {DOWNLOAD_TARGETS[target].title}
                </span>
                <span className="platform-detail">
                  {[DOWNLOAD_TARGETS[target].detail, size]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {availability === 'missing' ? (
                  <span className="platform-status">Not published yet</span>
                ) : (
                  <a className="platform-link" href={`/download/${target}`}>
                    Download
                  </a>
                )}
              </li>
            );
          })}
          <li className="platform-row">
            <span className="platform-name">Linux</span>
            <span className="platform-detail">Desktop Linux</span>
            <span className="platform-status">Not available yet</span>
          </li>
        </ul>
        {!isMacPrimary && showInstallCommand ? (
          <div className="install">
            <p className="install-title">macOS from Terminal</p>
            <CopyCommand command={installCommand} label="Install command" />
          </div>
        ) : null}
      </section>
    </div>
  );
};
