import {
  workflowTriageSchema,
  type Review,
  type WorkflowLanes,
  type WorkflowTriage,
  type WorkflowLaneDecision,
} from '@nesvo/contracts';
import { z } from 'zod';

export const triageOutputSchema = z.toJSONSchema(workflowTriageSchema, {
  io: 'input',
  target: 'draft-7',
});

export function laneDecision(
  assessment: WorkflowTriage | null,
  planMessageId: string | null,
  forceFull: boolean,
): WorkflowLaneDecision {
  const eligible =
    !forceFull &&
    assessment?.lane === 'light' &&
    assessment.size === 'small' &&
    assessment.risk === 'low';
  return {
    requested: assessment?.lane ?? null,
    effective: eligible ? 'light' : 'full',
    rationale: forceFull
      ? 'Full review was selected before the task started.'
      : (assessment?.rationale ??
        'The plan could not be confidently classified. Full review is required.'),
    planMessageId,
    ...(assessment ? { assessment } : {}),
  };
}

const protectedPath =
  /(?:^|\/)(?:\.github|\.agents|\.claude|\.codex|auth|authentication|authorization|security|credentials?|secrets?)(?:[./_-]|$)|(?:^|\/)(?:package-lock\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|build\.gradle(?:\.kts)?|Dockerfile)(?:$|\.)/i;

export function lightDiffRisk(
  review: Review | undefined,
  lanes: WorkflowLanes,
): string | null {
  if (!review || review.diff.status === 'unavailable')
    return 'The final diff could not be verified.';
  if (review.diff.status === 'not-applicable')
    return review.diff.files.length === 0
      ? null
      : 'The final diff could not be verified.';
  const { files, fingerprint, patch } = review.diff;
  if (
    !fingerprint ||
    files.some(file => {
      const path = file.path.replaceAll('\\', '/');
      return (
        path.startsWith('/') ||
        path.startsWith('../') ||
        protectedPath.test(path) ||
        file.kind === 'binary'
      );
    }) ||
    /^(?:old|new) type\/mode /m.test(patch)
  )
    return 'The final diff touches protected files or file metadata.';
  if (
    files.length > lanes.light.max_changed_files ||
    patch.split('\n').filter(line => /^[+-](?![+-]{2}\s)/.test(line)).length >
      lanes.light.max_changed_lines
  )
    return 'The final diff exceeds the light lane limits.';
  return null;
}
