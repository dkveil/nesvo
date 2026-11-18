import type {
  ReviewConventionLayer,
  ReviewDraft,
  ReviewEvent,
  ReviewFindingType,
  ReviewSeverity,
  ReviewTone,
} from '@nesvo/contracts';
import type { BadgeTone } from '@/shared/ui/badge';

export const severityLabels: Record<ReviewSeverity, string> = {
  info: 'Info',
  minor: 'Minor',
  major: 'Major',
  critical: 'Critical',
};

export const severityTones: Record<ReviewSeverity, BadgeTone> = {
  info: 'neutral',
  minor: 'info',
  major: 'warning',
  critical: 'error',
};

export const findingTypeLabels: Record<ReviewFindingType, string> = {
  comment: 'Comment',
  suggestion: 'Code suggestion',
  question: 'Question',
  nit: 'Nit',
};

export const toneLabels: Record<ReviewTone, string> = {
  neutral: 'Neutral',
  friendly: 'Friendly',
  direct: 'Direct',
};

export const layerLabels: Record<ReviewConventionLayer, string> = {
  global: 'Global',
  language: 'Language',
  project: 'Project',
};

export const eventLabels: Record<ReviewEvent, string> = {
  comment: 'Comment',
  'request-changes': 'Request changes',
  approve: 'Approve',
};

export const draftStatusLabels: Record<ReviewDraft['status'], string> = {
  queued: 'Waiting to start',
  running: 'Reviewing',
  ready: 'Draft ready',
  invalid: 'Invalid agent output',
  failed: 'Review failed',
  interrupted: 'Interrupted',
  publishing: 'Publishing',
  published: 'Published',
  discarded: 'Discarded',
};

export const lineRange = (finding: { startLine: number; endLine: number }) =>
  finding.startLine === finding.endLine
    ? `L${finding.startLine}`
    : `L${finding.startLine}–${finding.endLine}`;
