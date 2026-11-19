import { createHash } from 'node:crypto';
import {
  autonomyLevelSchema,
  type AutonomySettings,
  type AutonomyStatistics,
  type ResolvedWorkflow,
  type ResolvedStep,
  type WorkflowStepRecord,
} from '@nesvo/contracts';
import { pathKey } from './definitions';

export const defaultAutonomy: AutonomySettings = {
  revision: 0,
  level: 0,
  minimum: 15,
  windowDays: 30,
};

export function autonomyKey(
  root: string,
  workflow: ResolvedWorkflow,
  step: ResolvedStep,
) {
  const identity = JSON.stringify([
    pathKey(root),
    workflow.name,
    workflow.source.scope,
    workflow.source.contentHash,
    step.name,
    step.source.contentHash,
  ]);
  return (
    'workflow-autonomy:' + createHash('sha256').update(identity).digest('hex')
  );
}

export function autonomyStatistics(
  settings: AutonomySettings,
  history: WorkflowStepRecord[],
  now = Date.now(),
): AutonomyStatistics {
  const cutoff = now - settings.windowDays * 86_400_000;
  const decisions = history.filter(
    step =>
      step.decision?.actor === undefined &&
      step.decision?.at &&
      Date.parse(step.decision.at) >= cutoff &&
      ['accept', 'fix', 'reject'].includes(step.decision.kind),
  );
  const overrides = history.filter(
    step => step.policyOverride && Date.parse(step.policyOverride.at) >= cutoff,
  ).length;
  const comparisons = decisions.flatMap(step =>
    step.recommendation?.report
      ? [
          {
            agree:
              (step.recommendation.report.recommendation === 'approve') ===
              (step.decision?.kind === 'accept'),
          },
        ]
      : [],
  );
  const agreements = comparisons.filter(item => item.agree).length;
  const matching =
    settings.level === 0
      ? decisions.length >= settings.minimum &&
        decisions.every(
          step => step.decision?.kind === decisions[0]?.decision?.kind,
        )
      : agreements >= settings.minimum && comparisons.length === agreements;
  const next = autonomyLevelSchema.safeParse(settings.level + 1);
  const evidence = createHash('sha256')
    .update(
      JSON.stringify(decisions.map(step => step.decision?.decisionId).sort()),
    )
    .digest('hex');
  return {
    settings,
    overrides,
    agreements,
    observations: comparisons.length,
    proposal:
      matching &&
      !overrides &&
      next.success &&
      evidence !== settings.dismissedEvidence
        ? next.data
        : null,
    evidence,
    considerNarrowing: decisions.some(
      step => (step.decisionForm?.files?.length ?? 0) >= 12,
    ),
  };
}
