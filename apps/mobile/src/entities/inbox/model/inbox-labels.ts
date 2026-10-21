import type { InboxItemKind } from '@shared/api/host';

import type { InboxPriority } from './inbox-items';

export const INBOX_KIND_LABELS = {
  session: 'Session',
  decision: 'Decision',
  run: 'Run',
  result: 'Job result',
} as const satisfies Record<InboxItemKind, string>;

export const INBOX_PRIORITY_LABELS = {
  3: 'Urgent',
  2: 'Important',
  1: 'To review',
} as const satisfies Record<InboxPriority, string>;

const REASON_LABELS: Record<string, string> = {
  permission: 'Permission request',
  question: 'Agent question',
  auth: 'Sign-in required',
  quota: 'Provider limit',
  limit: 'Provider limit',
  setup: 'Setup required',
  startup: 'Startup problem',
  failure: 'Session failure',
  child: 'Child session needs you',
  done: 'Work finished',
  failed: 'Failed',
  unknown: 'Needs attention',
  decision: 'Waiting for your decision',
  validation: 'Result to validate',
  launchUnknown: 'Launch state unknown',
  needsValidation: 'Result to validate',
  succeeded: 'Job succeeded',
};

export const inboxReasonLabel = (reason: string) => REASON_LABELS[reason] ?? reason;
