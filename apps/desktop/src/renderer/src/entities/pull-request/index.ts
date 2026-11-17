import {
  parsePullRequestUrl,
  type Computer,
  type DesktopApi,
  type PullRequest,
  type PullRequestReference,
  type PullRequestSummary,
} from '@nesvo/contracts';

export { PullRequestStateIcon } from './state-icon';
export { ChecksIcon } from './checks-icon';
export { RelativeTime } from './relative-time';

export type PullRequestApi = Pick<
  DesktopApi,
  | 'listPullRequests'
  | 'readPullRequest'
  | 'readPullRequestFiles'
  | 'readPullRequestThreads'
  | 'actOnPullRequest'
  | 'linkSessionPullRequest'
  | 'findSessionPullRequest'
>;

export type PullRequestTarget = {
  hostId: string;
  reference: PullRequestReference;
};

export type PullRequestVisualState = 'open' | 'draft' | 'merged' | 'closed';

export type MergeMethod = PullRequest['allowedMergeMethods'][number];

export const mergeMethodLabels: Record<MergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Create a merge commit',
  rebase: 'Rebase and merge',
};

export const mergeMethodVerbs: Record<MergeMethod, string> = {
  squash: 'squash',
  merge: 'a merge commit',
  rebase: 'rebase',
};

export const visualStateLabels: Record<PullRequestVisualState, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
};

export function visualState(
  pullRequest: Pick<PullRequestSummary, 'state' | 'isDraft'>,
): PullRequestVisualState {
  if (pullRequest.state === 'open')
    return pullRequest.isDraft ? 'draft' : 'open';
  return pullRequest.state;
}

export function shortSha(sha: string) {
  return sha.slice(0, 7);
}

export function referenceKey(target: PullRequestTarget) {
  return `${target.hostId}/${target.reference.repository}#${target.reference.number}`;
}

export function sameReference(
  left: PullRequestReference | null | undefined,
  right: PullRequestReference | null | undefined,
) {
  return (
    !!left &&
    !!right &&
    left.number === right.number &&
    left.repository.toLowerCase() === right.repository.toLowerCase()
  );
}

export function pullRequestUrl(reference: PullRequestReference) {
  return `https://github.com/${reference.repository}/pull/${reference.number}`;
}

export function parseReferenceInput(
  text: string,
  repository: string | null,
): PullRequestReference | null {
  const linked = parsePullRequestUrl(text);
  if (linked) return linked;
  const match = /^#?(\d{1,9})$/.exec(text.trim());
  if (!match || !repository) return null;
  const number = Number(match[1]);
  return number > 0 ? { repository, number } : null;
}

export function pullRequestsUnavailableReason(computer: Computer | undefined) {
  if (!computer) return 'Choose a computer to work with pull requests.';
  if (computer.status !== 'connected')
    return `${computer.name} is offline. Connect it to work with pull requests.`;
  if (!computer.capabilities.includes('pull-requests'))
    return `${computer.name} runs an older Nesvo host. Update it to work with pull requests.`;
  return '';
}
