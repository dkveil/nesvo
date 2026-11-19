import { createHash } from 'node:crypto';
import {
  gateTrustConditionSchema,
  parseWorkflowCondition,
} from '@nesvo/contracts';
import type {
  GateTrustCase,
  GateTrustCondition,
  GateTrustRecord,
  GateTrustView,
  ResolvedStep,
  ResolvedWorkflow,
  Review,
  WorkflowRun,
  WorkflowStepRecord,
} from '@nesvo/contracts';
import { pathKey } from './definitions';
import { filterResultText } from './evidence';
import { latestAttempts } from './runner';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const emptyGateTrust: GateTrustRecord = {
  revision: 0,
  reasons: '',
  humanRequired: false,
  split: null,
  dismissed: null,
};

export const gateTrustKey = (
  root: string,
  workflow: ResolvedWorkflow,
  gate: ResolvedStep,
) =>
  'workflow-trust:' +
  digest([pathKey(root), workflow.source.scope, workflow.name, gate.name]);

export const gateTrustDefinition = (
  workflow: ResolvedWorkflow,
  definition: ResolvedStep,
) =>
  digest([
    workflow.source.contentHash,
    definition.source.contentHash,
    workflow.steps.map(step => [step.name, step.source.contentHash]),
  ]);

export function trustFactors(
  run: WorkflowRun,
  gate: WorkflowStepRecord,
  attempts: WorkflowStepRecord[],
  review: Review | undefined,
  at: string,
) {
  const matching =
    review?.id === gate.reviewId && review.version === gate.reviewVersion;
  const diff =
    matching && review.diff.status === 'complete' ? review.diff : null;
  const checks = [
    ...latestAttempts(attempts.filter(step => step.updatedAt <= at)).values(),
  ]
    .filter(step => {
      const bound = step.result?.check?.resultVersion;
      return (
        step.phase === gate.phase &&
        (step.type === 'command' || step.type === 'check') &&
        step.state === 'passed' &&
        step.result?.status === 'pass' &&
        (!matching ||
          (step.startedAt !== null && step.startedAt >= review.createdAt)) &&
        (!bound ||
          (bound.id === review?.id && bound.version === review.version)) &&
        step.result.finishedAt <= at
      );
    })
    .map(step => step.name)
    .slice(0, 12);
  const paths =
    diff?.files.map(file => filterResultText(file.path).slice(0, 300)) ?? [];
  const hasFullPatch =
    diff &&
    diff.patch.length < 200_000 &&
    diff.files.length < 500 &&
    diff.files.every(
      file =>
        file.kind !== 'binary' &&
        !file.path.startsWith('/') &&
        file.path.length <= 300 &&
        !file.path.includes('\\') &&
        file.path
          .split('/')
          .every(part => part && part !== '.' && part !== '..') &&
        filterResultText(file.path) === file.path,
    );
  const lines = hasFullPatch
    ? diff.patch
        .split(/\r?\n/)
        .filter(line => /^[+-]/.test(line) && !/^(---|\+\+\+) /.test(line))
        .length
    : null;
  const assessment = run.lane?.assessment;
  const risk = assessment?.risk ?? 'unknown';
  const concerns: GateTrustCase['concerns'] = [];
  if (!hasFullPatch) concerns.push('diff');
  if (!checks.length) concerns.push('checks');
  if (risk !== 'low') concerns.push('risk');
  if (gate.policyOverride) concerns.push('override');
  return {
    lane: run.lane?.effective ?? null,
    risk,
    paths,
    files: diff?.files.length ?? null,
    lines,
    checks,
    concerns,
  };
}

export function trustCase(
  run: WorkflowRun,
  gate: WorkflowStepRecord,
  attempts: WorkflowStepRecord[],
  review: Review | undefined,
): GateTrustCase | null {
  const decision = gate.decision;
  if (
    !decision ||
    (decision.actor === 'policy' && !gate.policyOverride) ||
    decision.kind === 'mark-done' ||
    decision.kind === 'run-again'
  )
    return null;
  const at = gate.policyOverride?.at ?? decision.at;
  const factors = trustFactors(run, gate, attempts, review, at);
  const safe =
    decision.kind === 'accept' &&
    (!gate.decisionForm || gate.decisionForm.form.kind === 'binary') &&
    gate.recommendation?.outcome === 'would-approve' &&
    factors.concerns.length === 0 &&
    Boolean(factors.lane);
  return {
    ...factors,
    paths: factors.paths.slice(0, 12),
    runId: run.id,
    sessionId: run.sessionId,
    stepId: gate.id,
    at,
    stage: gate.phase,
    decision: gate.policyOverride ? 'reject' : decision.kind,
    safe,
  };
}

export function matchesTrust(
  condition: GateTrustCondition,
  factors: ReturnType<typeof trustFactors> | GateTrustCase,
) {
  const when = parseWorkflowCondition(condition.when);
  return (
    factors.risk === 'low' &&
    when?.input.kind === 'lane' &&
    factors.lane === when.value &&
    factors.files !== null &&
    factors.lines !== null &&
    factors.files <= condition.maximumFiles &&
    factors.lines <= condition.maximumLines &&
    factors.paths.length === factors.files &&
    condition.passedChecks.every(check => factors.checks.includes(check)) &&
    factors.paths.every(path =>
      condition.protectedPaths.every(prefix => {
        const normalized = path.toLowerCase();
        const protectedPath = prefix.toLowerCase();
        return (
          normalized !== protectedPath &&
          !normalized.startsWith(protectedPath + '/')
        );
      }),
    )
  );
}

export function trustProposal(
  cases: GateTrustCase[],
  record: GateTrustRecord,
  edited?: GateTrustCondition,
): NonNullable<GateTrustView['proposal']> {
  const evidence = digest(cases.map(item => [item.stepId, item.at]));
  const safe = cases.filter(
    item => item.safe && item.lane && item.paths.length === item.files,
  );
  const reference = safe.find(
    item =>
      item.lines !== null &&
      item.lines <= 500 &&
      item.files !== null &&
      item.files <= 50 &&
      item.checks.length,
  );
  const baseline: GateTrustCondition | null =
    edited ??
    (reference?.lane && reference.files !== null && reference.lines !== null
      ? {
          when:
            reference.lane === 'light'
              ? ('lane == "light"' as const)
              : ('lane == "full"' as const),
          maximumFiles: Math.max(1, reference.files),
          maximumLines: Math.max(1, reference.lines),
          passedChecks: reference.checks,
          protectedPaths: [],
        }
      : null);
  const comparable =
    baseline && !edited
      ? cases.filter(item => matchesTrust(baseline, item))
      : [];
  const safePaths = new Set(
    comparable
      .filter(item => item.safe)
      .flatMap(item => item.paths.map(path => path.toLowerCase())),
  );
  const protectedPaths = [
    ...new Set(
      comparable.filter(item => !item.safe).flatMap(item => item.paths),
    ),
  ]
    .filter(
      path =>
        !safePaths.has(path.toLowerCase()) &&
        gateTrustConditionSchema.shape.protectedPaths.element.safeParse(path)
          .success,
    )
    .slice(0, 24);
  const draft =
    baseline && !edited ? { ...baseline, protectedPaths } : baseline;
  const examples = draft ? cases.filter(item => matchesTrust(draft, item)) : [];
  const condition =
    !record.humanRequired &&
    examples.length &&
    examples.every(item => item.safe)
      ? draft
      : null;
  return {
    evidence,
    findings: [
      record.humanRequired
        ? 'The recorded human requirement applies to every case.'
        : 'Keep a human review for any case without the declared check evidence, a complete diff or a permitted path.',
      ...(!cases.length
        ? [
            'Collect owner decisions with the diff, workflow lane, test result and recommendation.',
          ]
        : !safe.length
          ? [
              'Record passing checks in this phase and compare the recommendation with the owner decision.',
            ]
          : []),
      ...(cases.some(item => !item.safe && (item.files ?? 0) >= 12)
        ? [
            'Consider asking only about protected paths or files the recommendation flagged as uncertain.',
          ]
        : []),
      ...(draft && examples.some(item => !item.safe)
        ? [
            'A case that needed a person also matches these conditions. Require a distinguishing check, smaller diff or protected path.',
          ]
        : []),
    ],
    candidate: record.humanRequired ? null : draft,
    condition,
    trusted: condition ? examples.length : 0,
    human: condition ? cases.length - examples.length : cases.length,
  };
}
