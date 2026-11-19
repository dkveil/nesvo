import type { WorkflowLanes } from './lanes';
import type { StepEffect, StepPhase, StepType } from './definitions';
import {
  parseUntilCondition,
  parseWorkflowCondition,
  STEP_OUTPUT_REFERENCE,
} from './expressions';

export const workflowGraphLimits = {
  edges: 64,
  edgeText: 280,
  layoutCoordinate: 100_000,
} as const;

export const WORKFLOW_EDGE_CONDITIONS = ['success', 'failure', 'any'] as const;
export const WORKFLOW_EDGE_PATTERN =
  /^\s*([a-z0-9-]+)\s*->\s*([a-z0-9-]+)(?:\s+on\s+(success|failure|any))?(?:\s+when\s+([^\r\n]+?))?\s*$/;

export type EdgeCondition = (typeof WORKFLOW_EDGE_CONDITIONS)[number];
export type GraphEdge = {
  from: string;
  to: string;
  when: EdgeCondition;
  predicate?: string | undefined;
};
export type GraphNode = { name: string; phase: StepPhase };
export type GraphStep = {
  type: StepType;
  phase: StepPhase;
  effect: StepEffect;
  body: string;
  pr?: string;
  repeat?: readonly string[];
  condition?: string;
  join?: 'all' | 'reached' | undefined;
  required?: boolean | undefined;
};
export type GraphLayout = Readonly<Record<string, readonly [number, number]>>;
export type GraphInput = {
  name: string;
  lanes?: WorkflowLanes | undefined;
  steps: readonly string[];
  edges?: readonly string[] | null | undefined;
  layout?: GraphLayout | null | undefined;
};
export type WorkflowGraph = { explicit: boolean; edges: GraphEdge[] };
export type GraphEdges = { edges: readonly GraphEdge[] };
export type GraphView = { steps: readonly GraphNode[]; graph: GraphEdges };
export type GraphRule =
  | 'E1'
  | 'E2'
  | 'E3'
  | 'E4'
  | 'E5'
  | 'E6'
  | 'E7'
  | 'E8'
  | 'E9'
  | 'E10'
  | 'E11'
  | 'E12'
  | 'E13'
  | 'E14'
  | 'W1'
  | 'W2'
  | 'W3'
  | 'W4';
export type GraphIssue = {
  rule: GraphRule;
  severity: 'error' | 'warning';
  field: 'edges' | 'layout' | null;
  message: string;
  steps: string[];
  edge: number | null;
};
export type GraphResolution = { graph: WorkflowGraph; issues: GraphIssue[] };

type Outcome = Exclude<EdgeCondition, 'any'>;
type Requirements = Map<string, Set<Outcome>>;

const phaseRank: Record<StepPhase, number> = {
  plan: 0,
  'pre-done': 1,
  'pre-push': 2,
};
const phases = (Object.keys(phaseRank) as StepPhase[]).sort(
  (left, right) => phaseRank[left] - phaseRank[right],
);
const externalEffectPattern = /\bgit\s+push\b|\bgh\s+pr\b|\bcurl\b|\bwget\b/;
export const looksExternal = (body: string) => externalEffectPattern.test(body);
const externalHeuristic = 'git push, gh pr, curl or wget';

const quoted = (value: string) => `"${value}"`;
const printable = (value: string, length: number) =>
  value
    .slice(0, length)
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
      '',
    );

export const graphMessages = {
  edgeSyntax: (text: string) =>
    `Edge "${printable(text, workflowGraphLimits.edgeText)}" must read "<step> -> <step>" with an optional "on success", "on failure" or "on any"`,
  unknownStep: (edge: string, step: string) =>
    `Edge "${edge}" names step "${step}", which is not in this workflow`,
  selfEdge: (step: string) => `Step "${step}" cannot connect to itself`,
  duplicateEdge: (edge: string) => `Edge "${edge}" is listed twice`,
  crossPhase: (edge: GraphEdge, fromPhase: StepPhase, toPhase: StepPhase) =>
    `Edge "${formatEdge(edge)}" crosses phases; "${edge.from}" is ${fromPhase} and "${edge.to}" is ${toPhase}`,
  cycle: (steps: readonly string[]) =>
    `Steps ${steps.map(quoted).join(', ')} form a cycle`,
  humanRouting: (edge: string) =>
    `Edge "${edge}" starts at a human step; human decisions are accept, reject or fix and are not routed`,
  contradictoryJoin: (step: string, source: string) =>
    `Step "${step}" waits for both outcomes of "${source}" and can never start`,
  edgeLimit: `A workflow has at most ${workflowGraphLimits.edges} edges`,
  layoutStep: (step: string) =>
    `Layout names step "${printable(step, 64)}", which is not in this workflow`,
  noGate: (workflow: string) =>
    `Workflow "${workflow}" has no gate; add a command, check, agent or human step`,
  externalStep: (step: string) =>
    `Step "${step}" has an external effect and a path reaches it without a human step`,
  externalLooking: (step: string) =>
    `Step "${step}" looks like an external action (${externalHeuristic}) and a path reaches it without a human step`,
  chainExternalStep: (step: string, workflow: string) =>
    `Step "${step}" in workflow "${workflow}" is declared external without a human step before it`,
  chainExternalLooking: (step: string, workflow: string) =>
    `Step "${step}" in workflow "${workflow}" looks like an external action (${externalHeuristic}) without a human step before it`,
  parallelAgents: (first: string, second: string) =>
    `Steps "${first}" and "${second}" are agent steps that could start together; they run one at a time on this computer`,
} as const;

export const parseEdge = (text: string): GraphEdge | null => {
  if (text.length < 3 || text.length > workflowGraphLimits.edgeText)
    return null;
  const match = WORKFLOW_EDGE_PATTERN.exec(text);
  if (!match) return null;
  const predicate = match[4]?.trim();
  if (match[4] && (!predicate || !parseWorkflowCondition(predicate)))
    return null;
  return {
    from: match[1] as string,
    to: match[2] as string,
    when: (match[3] as EdgeCondition | undefined) ?? 'success',
    ...(predicate ? { predicate } : {}),
  };
};

export const formatEdge = (edge: GraphEdge): string =>
  `${edge.from} -> ${edge.to}${edge.when === 'success' ? '' : ` on ${edge.when}`}${edge.predicate ? ` when ${edge.predicate}` : ''}`;

export const implicitEdges = (steps: readonly GraphNode[]): GraphEdge[] =>
  phases.flatMap(phase => {
    const names = steps
      .filter(step => step.phase === phase)
      .map(step => step.name);
    return names.slice(1).map((to, index) => ({
      from: names[index] as string,
      to,
      when: 'success' as const,
    }));
  });

export const incoming = (graph: GraphEdges, step: string): GraphEdge[] =>
  graph.edges.filter(edge => edge.to === step);

export const outgoing = (graph: GraphEdges, step: string): GraphEdge[] =>
  graph.edges.filter(edge => edge.from === step);

export const ancestors = (graph: GraphEdges, step: string): string[] => {
  const found: string[] = [];
  const seen = new Set([step]);
  const queue = [step];
  while (queue.length)
    for (const edge of incoming(graph, queue.shift() as string)) {
      if (seen.has(edge.from)) continue;
      seen.add(edge.from);
      found.push(edge.from);
      queue.push(edge.from);
    }
  return found;
};

const orderNames = (
  names: readonly string[],
  edges: readonly GraphEdge[],
): string[] => {
  const members = new Set(names);
  const inside = edges.filter(
    edge => members.has(edge.from) && members.has(edge.to),
  );
  const waiting = new Map(names.map(name => [name, 0]));
  for (const edge of inside)
    waiting.set(edge.to, (waiting.get(edge.to) ?? 0) + 1);
  const ordered: string[] = [];
  const placed = new Set<string>();
  while (ordered.length < names.length) {
    const ready = names.find(
      name => !placed.has(name) && waiting.get(name) === 0,
    );
    if (!ready) break;
    placed.add(ready);
    ordered.push(ready);
    for (const edge of inside)
      if (edge.from === ready)
        waiting.set(edge.to, (waiting.get(edge.to) ?? 0) - 1);
  }
  return [...ordered, ...names.filter(name => !placed.has(name))];
};

export const topologicalOrder = (
  workflow: GraphView,
  phase: StepPhase,
): string[] =>
  orderNames(
    workflow.steps.filter(step => step.phase === phase).map(step => step.name),
    workflow.graph.edges,
  );

export const phaseSources = (workflow: GraphView, phase: StepPhase): string[] =>
  workflow.steps
    .filter(
      step =>
        step.phase === phase &&
        incoming(workflow.graph, step.name).length === 0,
    )
    .map(step => step.name);

type Collector = {
  issues: GraphIssue[];
  add: (
    rule: GraphRule,
    message: string,
    steps?: readonly string[],
    edge?: number | null,
  ) => void;
};

const collector = (): Collector => {
  const issues: GraphIssue[] = [];
  return {
    issues,
    add: (rule, message, steps = [], edge = null) =>
      issues.push({
        rule,
        severity: rule.startsWith('E') ? 'error' : 'warning',
        field: rule.startsWith('E') ? 'edges' : rule === 'W1' ? 'layout' : null,
        message,
        steps: [...steps],
        edge,
      }),
  };
};

type IndexedEdge = { edge: GraphEdge; index: number };

const listedEdges = (
  texts: readonly string[],
  members: ReadonlySet<string>,
  report: Collector,
): IndexedEdge[] | null => {
  if (texts.length > workflowGraphLimits.edges) {
    report.add('E9', graphMessages.edgeLimit);
    return null;
  }
  const listed: IndexedEdge[] = [];
  const seen = new Set<string>();
  const before = report.issues.length;
  texts.forEach((text, index) => {
    const edge = parseEdge(text);
    if (!edge)
      return report.add('E1', graphMessages.edgeSyntax(text), [], index);
    const label = formatEdge(edge);
    const ends = [...new Set([edge.from, edge.to])];
    const unknown = ends.filter(name => !members.has(name));
    if (unknown.length) {
      for (const name of unknown)
        report.add(
          'E2',
          graphMessages.unknownStep(label, name),
          ends.filter(end => members.has(end)),
          index,
        );
      return;
    }
    if (edge.from === edge.to)
      return report.add('E3', graphMessages.selfEdge(edge.from), ends, index);
    if (seen.has(label))
      return report.add('E4', graphMessages.duplicateEdge(label), ends, index);
    seen.add(label);
    listed.push({ edge, index });
  });
  return report.issues.length === before ? listed : null;
};

const phaseEdges = (
  listed: readonly IndexedEdge[],
  stepsByName: ReadonlyMap<string, GraphStep>,
  report: Collector,
): GraphEdge[] =>
  listed.flatMap(({ edge, index }) => {
    const source = stepsByName.get(edge.from);
    const target = stepsByName.get(edge.to);
    const ends = [edge.from, edge.to];
    if (source && target && source.phase !== target.phase) {
      report.add(
        'E5',
        graphMessages.crossPhase(edge, source.phase, target.phase),
        ends,
        index,
      );
      return [];
    }
    if (source?.type === 'human' && edge.when === 'failure')
      report.add(
        'E7',
        graphMessages.humanRouting(formatEdge(edge)),
        [edge.from],
        index,
      );
    return [edge];
  });

const reachable = (edges: readonly GraphEdge[], start: string) => {
  const reached = new Set<string>();
  const pending = [start];
  while (pending.length) {
    const current = pending.pop() as string;
    for (const edge of edges)
      if (edge.from === current && !reached.has(edge.to)) {
        reached.add(edge.to);
        pending.push(edge.to);
      }
  }
  return reached;
};

const cycles = (
  names: readonly string[],
  edges: readonly GraphEdge[],
): string[][] => {
  const reach = new Map(names.map(name => [name, reachable(edges, name)]));
  const cyclic = names.filter(name => reach.get(name)?.has(name));
  const assigned = new Set<string>();
  const groups: string[][] = [];
  for (const name of cyclic) {
    if (assigned.has(name)) continue;
    const group = cyclic.filter(
      other => reach.get(name)?.has(other) && reach.get(other)?.has(name),
    );
    for (const member of group) assigned.add(member);
    groups.push(group);
  }
  return groups;
};

const contradiction = (
  names: readonly string[],
  requirements: Requirements | undefined,
): string | null =>
  names.find(source => (requirements?.get(source)?.size ?? 0) > 1) ?? null;

const requirementsOf = (
  names: readonly string[],
  edges: readonly GraphEdge[],
): Map<string, Requirements> => {
  const all = new Map<string, Requirements>();
  for (const name of orderNames(names, edges)) {
    const required: Requirements = new Map();
    const add = (source: string, outcomes: Iterable<Outcome>) =>
      required.set(
        source,
        new Set([...(required.get(source) ?? []), ...outcomes]),
      );
    for (const edge of edges) {
      if (edge.to !== name) continue;
      for (const [source, outcomes] of all.get(edge.from) ?? [])
        add(source, outcomes);
      if (edge.when !== 'any') add(edge.from, [edge.when]);
    }
    all.set(name, required);
  }
  return all;
};

const contradictoryJoins = (
  names: readonly string[],
  edges: readonly GraphEdge[],
  requirements: ReadonlyMap<string, Requirements>,
  report: Collector,
) => {
  const blocked = (name: string) =>
    contradiction(names, requirements.get(name));
  for (const name of names) {
    const source = blocked(name);
    if (!source) continue;
    if (edges.some(edge => edge.to === name && blocked(edge.from))) continue;
    report.add('E8', graphMessages.contradictoryJoin(name, source), [name]);
  }
};

const externalWarnings = (
  input: GraphInput,
  explicit: boolean,
  order: readonly string[],
  edges: readonly GraphEdge[],
  stepsByName: ReadonlyMap<string, GraphStep>,
  report: Collector,
) => {
  const isHuman = (name: string) => stepsByName.get(name)?.type === 'human';
  const runsOnSuccess = new Set<string>();
  const covered = new Set<string>();
  for (const name of order) {
    const into = edges.filter(edge => edge.to === name);
    if (
      into.every(
        edge => edge.when !== 'failure' && runsOnSuccess.has(edge.from),
      )
    )
      runsOnSuccess.add(name);
    if (
      into.length &&
      into.every(
        edge =>
          (isHuman(edge.from) && edge.when === 'success') ||
          covered.has(edge.from),
      )
    )
      covered.add(name);
  }
  const humanBefore = (phase: StepPhase) =>
    input.steps.some(name => {
      const step = stepsByName.get(name);
      return (
        step?.type === 'human' &&
        phaseRank[step.phase] < phaseRank[phase] &&
        runsOnSuccess.has(name)
      );
    });
  const executionOrder = phases.flatMap(phase =>
    input.steps.filter(name => stepsByName.get(name)?.phase === phase),
  );
  for (const name of executionOrder) {
    const step = stepsByName.get(name) as GraphStep;
    if (step.type === 'human' || covered.has(name) || humanBefore(step.phase))
      continue;
    if (step.effect === 'external')
      report.add(
        'W2',
        explicit
          ? graphMessages.externalStep(name)
          : graphMessages.chainExternalStep(name, input.name),
        [name],
      );
    else if (
      (step.type === 'action' || step.type === 'command') &&
      looksExternal(step.body)
    )
      report.add(
        'W2',
        explicit
          ? graphMessages.externalLooking(name)
          : graphMessages.chainExternalLooking(name, input.name),
        [name],
      );
  }
};

const parallelAgentWarning = (
  input: GraphInput,
  order: readonly string[],
  edges: readonly GraphEdge[],
  requirements: ReadonlyMap<string, Requirements>,
  stepsByName: ReadonlyMap<string, GraphStep>,
  report: Collector,
) => {
  const before = new Map<string, Set<string>>();
  for (const name of order) {
    const found = new Set<string>();
    for (const edge of edges)
      if (edge.to === name) {
        found.add(edge.from);
        for (const ancestor of before.get(edge.from) ?? []) found.add(ancestor);
      }
    before.set(name, found);
  }
  const startable = (name: string) =>
    !contradiction(input.steps, requirements.get(name));
  const together = (first: string, second: string) => {
    const joined: Requirements = new Map();
    for (const name of [first, second])
      for (const [source, outcomes] of requirements.get(name) ?? [])
        joined.set(
          source,
          new Set([...(joined.get(source) ?? []), ...outcomes]),
        );
    return !contradiction(input.steps, joined);
  };
  for (const phase of phases) {
    const agents = input.steps.filter(name => {
      const step = stepsByName.get(name);
      return step?.type === 'agent' && step.phase === phase && startable(name);
    });
    for (const [index, first] of agents.entries())
      for (const second of agents.slice(index + 1)) {
        if (before.get(second)?.has(first) || before.get(first)?.has(second))
          continue;
        if (!together(first, second)) continue;
        report.add('W4', graphMessages.parallelAgents(first, second), [
          first,
          second,
        ]);
        return;
      }
  }
};

const layoutWarnings = (
  layout: GraphInput['layout'],
  members: ReadonlySet<string>,
  report: Collector,
) => {
  for (const name of Object.keys(layout ?? {}))
    if (!members.has(name)) report.add('W1', graphMessages.layoutStep(name));
};

const ordered = (issues: readonly GraphIssue[]): GraphIssue[] => [
  ...issues.filter(issue => issue.severity === 'error'),
  ...issues.filter(issue => issue.severity === 'warning'),
];

export const graphListRules: readonly GraphRule[] = [
  'E1',
  'E2',
  'E3',
  'E4',
  'E9',
  'W1',
];

export const checkGraphList = (
  input: Pick<GraphInput, 'steps' | 'edges' | 'layout'>,
): GraphIssue[] => {
  const report = collector();
  const members = new Set(input.steps);
  if (input.edges) listedEdges(input.edges, members, report);
  layoutWarnings(input.layout, members, report);
  return ordered(report.issues);
};

function validateHostSteps(
  names: readonly string[],
  stepsByName: ReadonlyMap<string, GraphStep>,
  graph: GraphEdges,
  report: Collector,
): void {
  const members = new Set(names);
  const claimed = new Set<string>();
  for (const name of names) {
    const step = stepsByName.get(name);
    if (!step) continue;
    const prSource = step.pr && STEP_OUTPUT_REFERENCE.exec(step.pr)?.[1];
    if (prSource) {
      const upstream = stepsByName.get(prSource);
      if (
        !members.has(prSource) ||
        !upstream ||
        !(
          phaseRank[upstream.phase] < phaseRank[step.phase] ||
          ancestors(graph, name).includes(prSource)
        )
      )
        report.add(
          'E11',
          'The pull request expression must read an upstream step in this workflow.',
          [name],
        );
    }
    if (step.type !== 'until' || !step.repeat?.length) continue;
    const chain = [...step.repeat, name];
    const condition = step.condition && parseUntilCondition(step.condition);
    if (!condition || !step.repeat.includes(condition.step))
      report.add(
        'E10',
        'The loop condition must read an output from a repeated step.',
        [name],
      );
    for (const [index, member] of step.repeat.entries()) {
      const previous = chain[index - 1];
      const next = chain[index + 1];
      const sources = incoming(graph, member);
      const targets = outgoing(graph, member);
      const definition = stepsByName.get(member);
      if (
        !members.has(member) ||
        !definition ||
        definition.phase !== step.phase ||
        definition.type === 'until' ||
        claimed.has(member) ||
        (previous &&
          (sources.length !== 1 ||
            sources[0]?.from !== previous ||
            sources[0]?.when !== 'success' ||
            sources[0]?.predicate)) ||
        targets.length !== 1 ||
        targets[0]?.to !== next ||
        targets[0]?.when !== 'success' ||
        targets[0]?.predicate
      ) {
        report.add(
          'E10',
          'Connect the repeated steps and Loop until in one same-phase success chain. A repeated step can belong to only one loop.',
          [name, member],
        );
        break;
      }
      claimed.add(member);
    }
    const end = incoming(graph, name);
    if (end.length !== 1 || end[0]?.from !== step.repeat.at(-1))
      report.add(
        'E10',
        'Loop until must have one incoming edge from the last repeated step.',
        [name],
      );
  }
}

export const resolveGraph = (
  input: GraphInput,
  stepsByName: ReadonlyMap<string, GraphStep>,
): GraphResolution => {
  const report = collector();
  const members = new Set(input.steps);
  const known = input.steps.flatMap(name => {
    const step = stepsByName.get(name);
    return step ? [{ name, phase: step.phase, type: step.type }] : [];
  });
  const explicit = Boolean(input.edges);
  const listed = input.edges ? listedEdges(input.edges, members, report) : null;
  const edges = input.edges
    ? phaseEdges(listed ?? [], stepsByName, report)
    : implicitEdges(known);
  const looped = !input.edges || listed ? cycles(input.steps, edges) : [];
  for (const cycle of looped)
    report.add('E6', graphMessages.cycle(cycle), cycle);
  layoutWarnings(input.layout, members, report);
  validateHostSteps(input.steps, stepsByName, { edges }, report);
  const conditional =
    Boolean(input.lanes) ||
    edges.some(edge => edge.predicate) ||
    known.some(
      step =>
        stepsByName.get(step.name)?.join === 'reached' ||
        stepsByName.get(step.name)?.required,
    );
  for (const { edge, index } of listed ?? []) {
    if (!edge.predicate) continue;
    const condition = parseWorkflowCondition(edge.predicate);
    if (
      condition?.input.kind === 'lane' &&
      (edge.to !== input.lanes?.light.omit ||
        condition.operator !== '==' ||
        condition.value !== 'full')
    )
      report.add(
        'E14',
        'A lane condition can only require the full lane for the declared deep review.',
        [edge.from, edge.to],
        index,
      );
    if (condition?.input.kind !== 'output') continue;
    const reference = condition.input.step;
    const source = stepsByName.get(edge.from);
    const referenced = stepsByName.get(reference);
    if (!(
      source &&
      referenced &&
      members.has(reference) &&
      (reference === edge.from ||
        phaseRank[referenced.phase] < phaseRank[source.phase] ||
        ancestors({ edges }, edge.from).includes(reference))
    ))
      report.add(
        'E12',
        'The condition must read the source step or one upstream of it.',
        [edge.from, edge.to],
        index,
      );
  }
  if (input.lanes) {
    const omit = input.lanes.light.omit;
    const optional = stepsByName.get(omit);
    if (
      !members.has(omit) ||
      optional?.type !== 'agent' ||
      optional.phase !== 'pre-done' ||
      optional.required
    )
      report.add(
        'E14',
        'The light lane may omit one optional pre-done agent review.',
        [omit],
      );
    for (const edge of outgoing({ edges }, omit)) {
      if (
        stepsByName.get(edge.to)?.join !== 'reached' ||
        !incoming({ edges }, edge.to).some(source => source.from !== omit)
      )
        report.add(
          'E14',
          'Steps after the optional review need a reached join with a common input.',
          [omit, edge.to],
        );
    }
  }
  if (conditional) {
    const gates = known.filter(
      step => step.type === 'human' || step.type === 'wait-ci',
    );
    for (const step of known) {
      const definition = stepsByName.get(step.name);
      if (
        !definition ||
        (definition.effect !== 'external' && !looksExternal(definition.body))
      )
        continue;
      if (definition.type !== 'command' && definition.type !== 'action')
        continue;
      const upstream = new Set(ancestors({ edges }, step.name));
      if (
        !gates.some(
          gate =>
            gate.type === 'human' &&
            (phaseRank[gate.phase] < phaseRank[step.phase] ||
              upstream.has(gate.name)),
        ) ||
        gates.some(
          gate => gate.phase === step.phase && !upstream.has(gate.name),
        )
      ) {
        report.add(
          'E13',
          'An external step needs an upstream human gate and every same-phase hard gate.',
          [step.name],
        );
      }
    }
  }
  if (known.length && known.every(step => step.type === 'action'))
    report.add('W3', graphMessages.noGate(input.name));
  if ((!input.edges || listed) && !looped.length) {
    const order = orderNames(input.steps, edges);
    const requirements = requirementsOf(input.steps, edges);
    const requiredEdges = edges.filter(
      edge => !edge.predicate && stepsByName.get(edge.to)?.join !== 'reached',
    );
    contradictoryJoins(
      input.steps,
      requiredEdges,
      conditional ? requirementsOf(input.steps, requiredEdges) : requirements,
      report,
    );
    externalWarnings(input, explicit, order, edges, stepsByName, report);
    parallelAgentWarning(
      input,
      order,
      edges,
      requirements,
      stepsByName,
      report,
    );
  }
  return { graph: { explicit, edges }, issues: ordered(report.issues) };
};
