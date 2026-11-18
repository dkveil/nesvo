export type ReviewEvent = 'approve' | 'request-changes' | 'comment';

export type ReviewDraft = { event: ReviewEvent; body: string };

export const reviewEventLabels: Record<ReviewEvent, string> = {
  approve: 'Approve',
  'request-changes': 'Request changes',
  comment: 'Comment',
};

export const reviewEvents = (viewerCanReview: boolean): ReviewEvent[] =>
  viewerCanReview ? ['approve', 'request-changes', 'comment'] : ['comment'];
