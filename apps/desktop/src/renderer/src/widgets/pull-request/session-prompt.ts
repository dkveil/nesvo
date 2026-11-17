import type {
  PullRequestReference,
  PullRequestThread,
  PullRequestTimelineItem,
} from '@nesvo/contracts';
import { pullRequestUrl } from '@/entities/pull-request';

const PROMPT_LIMIT_CHARACTERS = 30_000;

export type TimelineDiscussion = Exclude<
  PullRequestTimelineItem,
  { kind: 'commit' }
>;

const quote = (text: string) =>
  text
    .trim()
    .split(/\r?\n/)
    .map(line => (line ? `> ${line}` : '>'))
    .join('\n');

const location = (thread: PullRequestThread) =>
  `${thread.path}${thread.line ? `:${thread.line}` : ''}`;

const threadBlock = (thread: PullRequestThread) => {
  const state = thread.isOutdated ? ' (outdated)' : '';
  const comments = thread.comments
    .map(
      comment =>
        `> **${comment.author?.login ?? 'unknown'}**\n${quote(comment.body)}`,
    )
    .join('\n>\n');
  return `\`${location(thread)}\`${state}\n\n${comments}`;
};

const limit = (text: string) =>
  text.length <= PROMPT_LIMIT_CHARACTERS
    ? text
    : `${text.slice(0, PROMPT_LIMIT_CHARACTERS)}\n\n…The rest is on the pull request.`;

const heading = (reference: PullRequestReference) =>
  `${reference.repository}#${reference.number} (${pullRequestUrl(reference)})`;

export function threadPrompt(
  reference: PullRequestReference,
  thread: PullRequestThread,
) {
  return limit(
    `Please address this review comment on pull request ${heading(reference)}.\n\n${threadBlock(thread)}`,
  );
}

export function threadsPrompt(
  reference: PullRequestReference,
  threads: PullRequestThread[],
) {
  if (threads.length === 1) return threadPrompt(reference, threads[0]!);
  const blocks = threads
    .map((thread, index) => `### ${index + 1}. ${threadBlock(thread)}`)
    .join('\n\n');
  return limit(
    `Please address these ${threads.length} open review threads on pull request ${heading(reference)}.\n\n${blocks}`,
  );
}

const discussionAuthor = (item: TimelineDiscussion) =>
  item.author?.login ?? 'unknown';

export function discussionPrompt(
  reference: PullRequestReference,
  item: TimelineDiscussion,
  label: string,
) {
  return limit(
    `Please address this ${label} on pull request ${heading(reference)}.

> **${discussionAuthor(item)}**
${quote(item.body)}`,
  );
}

export function replyQuote(item: TimelineDiscussion) {
  return `> **${discussionAuthor(item)}** wrote:
${quote(item.body)}

`;
}
