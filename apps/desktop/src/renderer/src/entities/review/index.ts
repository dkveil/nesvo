import type { Review } from '@nesvo/contracts';

export type { Review, DecideReviewInput } from '@nesvo/contracts';

export const reviewStatusLabels: Record<Review['status'], string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  'changes-requested': 'Changes requested',
  superseded: 'Outdated',
};

export const fileKindLabels: Record<
  Review['diff']['files'][number]['kind'],
  string
> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  binary: 'Binary',
};

export function reviewDate(value: string) {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function compactPreview(value: string, limit = 240) {
  const normalized = value
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= limit) return normalized;
  const excerpt = normalized.slice(0, limit - 1);
  const boundary = excerpt.lastIndexOf(' ');
  return `${boundary > limit * 0.6 ? excerpt.slice(0, boundary) : excerpt}…`;
}

export function reviewPreview(review: Review) {
  const paragraphs = review.summary
    .replace(/```[\s\S]*?```/g, '')
    .split(/\n\s*\n/)
    .map(value => value.trim())
    .filter(value => value && !/^#{1,6}\s+[^\n]+$/.test(value));
  let candidate = paragraphs.at(-1) ?? '';
  if (candidate.length > 600)
    candidate =
      candidate
        .split('\n')
        .map(value => value.trim())
        .filter(Boolean)
        .at(-1) ?? '';
  if (
    !candidate ||
    candidate.length > 600 ||
    /^(?:I(?:'ll| will)|Let me|First,|Plan(?:uję| działania)?[: ]|Najpierw|Sprawdzę|Zbadam|Przygotuję|Przeanalizuję)\b/i.test(
      candidate,
    )
  )
    candidate = review.task;
  return compactPreview(
    candidate || review.task || 'The result is ready for review.',
  );
}
