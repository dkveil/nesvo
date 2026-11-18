import { formatMegabytes } from '@/lib/format';
import {
  DOWNLOAD_TARGETS,
  type DownloadTargetId,
} from '@/releases/download-targets';
import type { ReleaseState } from '@/releases/release-state';

type PlatformListProps = {
  release: ReleaseState;
  targets: readonly DownloadTargetId[];
};

const downloadOf = (release: ReleaseState, target: DownloadTargetId) =>
  release.status === 'published'
    ? release.release.downloads.find(item => item.target === target)
    : undefined;

const isAvailable = (release: ReleaseState, target: DownloadTargetId) =>
  release.status === 'unavailable' ||
  !!downloadOf(release, target)?.isPublished;

export const PlatformList = ({ release, targets }: PlatformListProps) => (
  <ul className="platform-list">
    {targets.map(target => (
      <li key={target} className="platform-row">
        <span className="platform-name">{DOWNLOAD_TARGETS[target].title}</span>
        <span className="platform-detail">
          {[
            DOWNLOAD_TARGETS[target].detail,
            formatMegabytes(downloadOf(release, target)?.sizeBytes ?? null),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {isAvailable(release, target) ? (
          <a className="platform-action" href={`/download/${target}`}>
            Download
          </a>
        ) : (
          <span className="platform-action">Not published yet</span>
        )}
      </li>
    ))}
    <li className="platform-row">
      <span className="platform-name">Linux</span>
      <span className="platform-detail">Desktop Linux</span>
      <span className="platform-action">Not available yet</span>
    </li>
  </ul>
);
