import { GitPullRequest } from 'lucide-react';
import type { DesktopSession } from '@nesvo/contracts';
import { pullRequestUrl } from '@/entities/pull-request';
import { Button } from '@/shared/ui/button';

export function SessionPullRequest({ session }: { session: DesktopSession }) {
  const request = session.pullRequest;
  if (!request) return null;
  return (
    <Button size="xs" variant="ghost" asChild>
      <a
        href={pullRequestUrl(request)}
        aria-label={`Open PR #${request.number} for ${session.title}`}
        onClick={event => {
          event.preventDefault();
          void window.nesvo
            .openExternal(event.currentTarget.href)
            .catch(() => undefined);
        }}
      >
        <GitPullRequest /> #{request.number}
      </a>
    </Button>
  );
}
