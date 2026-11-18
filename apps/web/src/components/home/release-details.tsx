import { formatDate, formatMegabytes } from '@/lib/format';
import { DOWNLOAD_TARGETS } from '@/releases/download-targets';
import type { ReleaseState } from '@/releases/release-state';

type ReleaseDetailsProps = {
  release: ReleaseState;
};

export const ReleaseDetails = ({ release }: ReleaseDetailsProps) => {
  if (release.status === 'none') {
    return (
      <section className="details" aria-labelledby="release-title">
        <h2 id="release-title" className="section-label">
          Release
        </h2>
        <p>
          No release is published yet. Downloads start working here as soon as
          the first release is out, with its version and SHA-256 checksums.
        </p>
      </section>
    );
  }

  if (release.status === 'unavailable') {
    return (
      <section className="details" aria-labelledby="release-title">
        <h2 id="release-title" className="section-label">
          Release
        </h2>
        <p>
          Release details cannot be loaded right now. The download links still
          point at the latest release; see <a href="/releases">all releases</a>{' '}
          for versions and checksums.
        </p>
      </section>
    );
  }

  const { version, publishedAt, notesUrl, checksumsUrl, downloads } =
    release.release;
  const publishedOn = formatDate(publishedAt);

  return (
    <section className="details" aria-labelledby="release-title">
      <h2 id="release-title" className="section-label">
        Release
      </h2>
      <p className="release-meta">
        <span>Version {version}</span>
        {publishedOn ? <span>Published {publishedOn}</span> : null}
        <a href={notesUrl}>Release notes</a>
        {checksumsUrl ? <a href={checksumsUrl}>SHA256SUMS.txt</a> : null}
      </p>
      <dl className="checksums">
        {downloads.map(download => (
          <div key={download.target} className="checksum">
            <dt>
              <span className="checksum-file">{download.fileName}</span>
              <span className="checksum-meta">
                {[
                  DOWNLOAD_TARGETS[download.target].title,
                  formatMegabytes(download.sizeBytes),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </dt>
            <dd>
              {download.isPublished ? (
                <code className="checksum-value">
                  {download.sha256 ?? 'Checksum not published'}
                </code>
              ) : (
                <span className="platform-status">Not in this release</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
};
