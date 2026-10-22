import type { InboxFeatures, PushKind } from './types';

export const PUSH_KIND_CAPABILITIES = {
  decisionPending: 'decisions',
  resultReady: 'attentionInbox',
} as const satisfies Record<PushKind, keyof InboxFeatures>;

const PUSH_KINDS = Object.keys(PUSH_KIND_CAPABILITIES) as PushKind[];

export const pushKindsFor = (features: Partial<Record<keyof InboxFeatures, boolean>>) =>
  PUSH_KINDS.filter(kind => features[PUSH_KIND_CAPABILITIES[kind]] === true);
