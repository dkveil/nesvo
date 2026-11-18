import { formatDate, formatMegabytes } from '@/lib/format';
import type { PublishedRelease } from '@/releases/release-state';

type ReleaseChecksumsProps = {
  release: PublishedRelease;
};

export const ReleaseChecksums = ({ release }: ReleaseChecksumsProps) => {
  const { version, publishedAt, notesUrl, checksumsUrl, downloads } = release;
  const publishedOn = formatDate(publishedAt);

  return (
    <>
      <p className="panel-meta">
        <span>Version {version}</span>
        {publishedOn ? <span>{publishedOn}</span> : null}
        <a href={notesUrl}>Release notes</a>
        {checksumsUrl ? <a href={checksumsUrl}>SHA256SUMS.txt</a> : null}
      </p>
      <dl className="checksums">
        {downloads.map(download => (
          <div key={download.target} className="checksum">
            <dt>
              <span className="checksum-file">{download.fileName}</span>
              {download.sizeBytes ? (
                <span>{formatMegabytes(download.sizeBytes)}</span>
              ) : null}
            </dt>
            <dd>
              {download.isPublished
                ? (download.sha256 ?? 'Checksum not published')
                : 'Not in this release'}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
};
