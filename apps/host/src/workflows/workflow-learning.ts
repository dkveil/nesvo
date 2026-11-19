import {
  formatEdge,
  parseEdge,
  parseWorkflowCondition,
  type GateRuleProposal,
  type WorkflowRun,
  type WorkflowStepRecord,
} from '@nesvo/contracts';
import { createHash } from 'node:crypto';
import { document } from '../skills/portable';
import { parseCheckCommand } from './check-inventory';
import { deterministicId, latestAttempts } from './runner';

export function passingSubstitution(step: WorkflowStepRecord) {
  const check = step.result?.check;
  const invocation = check?.invocations.find(
    item => item.outcome === 'passed' && item.substitution,
  );
  if (
    step.state !== 'passed' ||
    check?.mapping ||
    !invocation?.command ||
    !parseCheckCommand(invocation.command) ||
    invocation.candidate.directory !== '.'
  )
    return null;
  return { command: invocation.command, source: invocation.candidate.source };
}

export function editableConditionalRoute(
  run: WorkflowRun,
  text: string,
): string | null {
  const edge = parseEdge(text);
  const condition = edge?.predicate && parseWorkflowCondition(edge.predicate);
  if (
    !edge ||
    !condition ||
    condition.input.kind !== 'stack' ||
    condition.operator !== '==' ||
    !['typescript', 'kotlin'].includes(condition.value) ||
    !run.workflow.edges?.length
  )
    return null;
  const before = formatEdge({ from: edge.from, to: edge.to, when: edge.when });
  if (
    !run.workflow.edges.some(value => {
      const parsed = parseEdge(value);
      return parsed && formatEdge(parsed) === before;
    })
  )
    return null;
  const target = run.workflow.steps.find(step => step.name === edge.to);
  if (
    target?.type !== 'agent' ||
    target.phase !== 'pre-done' ||
    target.required
  )
    return null;
  return formatEdge(edge);
}

export function routeDocument(text: string, route: string): string {
  const parsed = document(text, 'Workflow');
  const edge = parseEdge(route)!;
  const edges = parsed.fields.edges;
  if (!Array.isArray(edges))
    throw new Error('The workflow no longer has explicit edges.');
  const before = formatEdge({ from: edge.from, to: edge.to, when: edge.when });
  const fields = {
    ...parsed.fields,
    edges: edges.map((value: string) => {
      const current = parseEdge(value);
      return current && formatEdge(current) === before ? route : value;
    }),
  };
  return (
    '---\n' +
    Object.entries(fields)
      .map(([key, value]) => key + ': ' + JSON.stringify(value))
      .join('\n') +
    '\n---\n' +
    parsed.body
  );
}

export function workflowLearning(
  run: WorkflowRun,
  current: readonly WorkflowStepRecord[],
  previous: readonly WorkflowRun[],
  steps: (runId: string) => WorkflowStepRecord[],
) {
  if (!run.sessionId) return [];
  const rows: {
    row: GateRuleProposal;
    step: WorkflowStepRecord;
    key: string;
  }[] = [];
  const base = {
    runId: run.id,
    sessionId: run.sessionId,
    taskSessionId: run.sessionId,
    workflow: run.workflow.name,
    revision: 1,
    createdAt: run.updatedAt,
    status: 'pending' as const,
    current: null,
    changeId: null,
    ruleId: null,
    error: null,
  };
  const latest = [...latestAttempts(current).values()];
  for (const step of latest) {
    const mapping =
      run.status === 'passed' &&
      run.projectProfile &&
      passingSubstitution(step);
    if (
      mapping &&
      previous.some(
        other =>
          other.id !== run.id &&
          other.status === 'passed' &&
          other.projectRoot === run.projectRoot &&
          steps(other.id).some(prior => {
            const earlier = passingSubstitution(prior);
            return (
              earlier?.command === mapping.command &&
              earlier.source.hash === mapping.source.hash
            );
          }),
      )
    ) {
      const key = createHash('sha256')
        .update(JSON.stringify([run.projectRoot, mapping]))
        .digest('hex');
      rows.push({
        key,
        step,
        row: {
          ...base,
          id: deterministicId(`mapping:${run.id}:${key}`),
          scope: 'project',
          origin: 'mapping',
          decisionKind: 'accept',
          mapping: {
            ...mapping,
            expectedHash: run.projectProfile?.overrideHash ?? null,
          },
          proposal: {
            description: 'Applies when resolving the Project test command',
            kind: 'check',
            steps: [step.name],
            update: null,
            quote: 'The same verified substitute passed in separate runs.',
            justification:
              'Prefer the working Project test command on the next run.',
            body: {
              rule: 'Save this observed test command as the Project mapping.',
              why: 'The equivalent command passed after the preferred setup was unavailable.',
              check: mapping.command,
            },
          },
        },
      });
      break;
    }
  }
  for (const step of current) {
    const decision = step.decision;
    if (
      step.type !== 'human' ||
      !decision ||
      decision.actor ||
      (decision.kind !== 'fix' && decision.kind !== 'reject')
    )
      continue;
    const instruction = decision.comment
      .split(/\r?\n/)
      .find(line => line.startsWith('Route: '));
    const route =
      instruction && editableConditionalRoute(run, instruction.slice(7));
    if (!route) continue;
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          run.workflow.source.path,
          run.workflow.source.contentHash,
          route,
        ]),
      )
      .digest('hex');
    rows.push({
      key,
      step,
      row: {
        ...base,
        id: deterministicId(`route:${run.id}:${key}`),
        scope: run.workflow.source.scope,
        origin: 'route',
        decisionKind: decision.kind,
        proposal: {
          description: 'Applies when routing the optional review',
          kind: 'check',
          steps: [step.name],
          update: null,
          quote: instruction!.slice(0, 400),
          justification:
            'The owner proposed a conditional route in this gate decision.',
          body: {
            rule: 'Apply the proposed condition to the existing review route.',
            why: 'The condition narrows an optional review based on the detected project stack.',
            check: route,
          },
        },
      },
    });
    break;
  }
  return rows;
}
