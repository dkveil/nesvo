import { ShareShell } from './share-shell';

export type ShareUnavailableReason = 'expired' | 'missing' | 'unreadable';

const COPY = {
  expired: {
    title: 'This shared workflow has expired',
    body: 'Shared links last 7 days. Ask the person who shared it for a new link.',
  },
  missing: {
    title: 'This shared workflow is not here',
    body: 'The link may be mistyped, or the person who shared it removed it. Ask them for a new link.',
  },
  unreadable: {
    title: 'This shared workflow cannot be shown',
    body: 'Sharing is not available right now. Try again in a few minutes.',
  },
} as const satisfies Record<
  ShareUnavailableReason,
  { title: string; body: string }
>;

type ShareUnavailableProps = {
  reason: ShareUnavailableReason;
};

export const ShareUnavailable = ({ reason }: ShareUnavailableProps) => (
  <ShareShell>
    <div className="share-empty">
      <h1 className="share-title">{COPY[reason].title}</h1>
      <p className="share-description">{COPY[reason].body}</p>
      <div className="share-actions">
        <a className="button" href="/">
          Download Nesvo
        </a>
      </div>
    </div>
  </ShareShell>
);
