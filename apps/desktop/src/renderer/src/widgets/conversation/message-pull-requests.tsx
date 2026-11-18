import { Fragment, useContext, useMemo } from 'react';
import { findPullRequestUrls } from '@nesvo/contracts';
import { PullRequestMentionContext } from './pull-request-mentions';

export function MessagePullRequests({ body }: { body: string }) {
  const render = useContext(PullRequestMentionContext);
  const references = useMemo(() => findPullRequestUrls(body), [body]);
  if (!render || references.length === 0) return null;
  return (
    <div className="space-y-1.5" data-message-pull-requests="">
      {references.map(reference => (
        <Fragment key={`${reference.repository}#${reference.number}`}>
          {render(reference)}
        </Fragment>
      ))}
    </div>
  );
}
