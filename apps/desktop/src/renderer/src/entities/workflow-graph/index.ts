import type { WorkflowLanes } from '@nesvo/contracts';
import {
  formatEdge,
  workflowDefinitionSchema,
  resolveGraph,
  stepDefinitionSchema,
  stepNameSchema,
  topologicalOrder,
  type DefinitionCatalog,
  type DefinitionScope,
  type EdgeCondition,
  type GraphEdge,
  type GraphIssue,
  type GraphStep,
  type WorkflowLayout,
  type ResolvedWorkflow,
  type ResolvedStep,
  type StepDefinition,
  type StepPhase,
  type StepType,
} from '@nesvo/contracts';
import { phaseOrder, type WorkflowTone } from '@/entities/workflow';

export type { EdgeCondition, GraphIssue } from '@nesvo/contracts';

export type DraftStep = StepDefinition & {
  draft: true;
  scope: DefinitionScope;
  hash: string | null;
};

export type StepDraft = StepDefinition & {
  scope: DefinitionScope;
  hash: string | null;
  itemsText?: string;
};

export type NodeIssue = { severity: 'error' | 'warning'; message: string };

export type EditorNode = {
  id: string;
  step: ResolvedStep | DraftStep;
  position: { x: number; y: number };
  issues: NodeIssue[];
};

export type EditorEdge = {
  id: string;
  from: string;
  to: string;
  when: EdgeCondition;
  predicate?: string | undefined;
};

export type EditorDocument = {
  name: string;
  lanes?: WorkflowLanes | undefined;
  decisionMemory?: 'review' | 'automatic' | undefined;
  description: string;
  body: string;
  scope: DefinitionScope;
  hash: string | null;
  nodes: EditorNode[];
  edges: EditorEdge[];
  layout: WorkflowLayout;
};

export type DocumentIssue = NodeIssue & {
  steps: string[];
  edgeId: string | null;
  field: string | null;
};

export type DocumentValidation = {
  issues: DocumentIssue[];
  nodeIssues: Map<string, NodeIssue[]>;
  hasErrors: boolean;
};

export const NODE_WIDTH_PX = 220;
export const NODE_HEIGHT_PX = 64;
export const COLUMN_WIDTH_PX = 300;
export const ROW_HEIGHT_PX = 96;
export const PHASE_GAP_PX = 110;
export const FRAME_PADDING_PX = 28;
export const FRAME_LABEL_PX = 22;
export const START_NODE_WIDTH_PX = 200;

export type Position = { x: number; y: number };

export type PhaseFrame = {
  phase: StepPhase;
  x: number;
  y: number;
  width: number;
  height: number;
};

export const stepTypeLabels: Record<StepType, string> = {
  command: 'Command',
  check: 'Check',
  agent: 'Agent',
  human: 'Human',
  action: 'Action',
  'wait-ci': 'Wait for PR checks',
  until: 'Loop until',
  probe: 'Diff probe',
  session: 'Child session',
  'fan-out': 'Fan-out',
};

export const stepTypeOrder: StepType[] = [
  'command',
  'check',
  'agent',
  'human',
  'action',
  'wait-ci',
  'until',
  'probe',
  'session',
  'fan-out',
];

export const phaseTones: Record<StepPhase, WorkflowTone> = {
  plan: 'info',
  'pre-done': 'success',
  'pre-push': 'warning',
};

export const edgeTones: Record<EdgeCondition, WorkflowTone> = {
  success: 'muted',
  failure: 'error',
  any: 'info',
};

export const edgeWhenLabels: Record<EdgeCondition, string> = {
  success: 'On success',
  failure: 'On failure',
  any: 'Always',
};

const overlaps = (left: Position, right: Position) =>
  Math.abs(left.x - right.x) < NODE_WIDTH_PX &&
  Math.abs(left.y - right.y) < NODE_HEIGHT_PX;

const freeSlot = (nodes: readonly EditorNode[], wanted: Position): Position => {
  const position = { ...wanted };
  while (nodes.some(node => overlaps(node.position, position)))
    position.y += ROW_HEIGHT_PX;
  return position;
};

export const placeAfter = (
  nodes: readonly EditorNode[],
  source: EditorNode,
): Position =>
  freeSlot(nodes, {
    x: source.position.x + COLUMN_WIDTH_PX,
    y: source.position.y,
  });

export const placeBetween = (
  nodes: readonly EditorNode[],
  from: EditorNode,
  to: EditorNode,
): Position =>
  freeSlot(nodes, {
    x: Math.round((from.position.x + to.position.x) / 2),
    y: Math.round((from.position.y + to.position.y) / 2) + ROW_HEIGHT_PX,
  });

export const placeBelow = (
  nodes: readonly EditorNode[],
  source: EditorNode,
): Position =>
  freeSlot(nodes, {
    x: source.position.x,
    y: source.position.y + ROW_HEIGHT_PX,
  });

export const phaseFrames = (nodes: readonly EditorNode[]): PhaseFrame[] =>
  phaseOrder.flatMap(phase => {
    const inPhase = nodes.filter(node => node.step.phase === phase);
    if (inPhase.length === 0) return [];
    const xs = inPhase.map(node => node.position.x);
    const ys = inPhase.map(node => node.position.y);
    const x = Math.min(...xs) - FRAME_PADDING_PX;
    const y = Math.min(...ys) - FRAME_PADDING_PX - FRAME_LABEL_PX;
    return [
      {
        phase,
        x,
        y,
        width: Math.max(...xs) + NODE_WIDTH_PX + FRAME_PADDING_PX - x,
        height: Math.max(...ys) + NODE_HEIGHT_PX + FRAME_PADDING_PX - y,
      },
    ];
  });

export const startPosition = (nodes: readonly EditorNode[]): Position => {
  if (nodes.length === 0) return { x: 0, y: 0 };
  return {
    x: Math.min(...nodes.map(node => node.position.x)) - COLUMN_WIDTH_PX,
    y: Math.min(...nodes.map(node => node.position.y)),
  };
};

export const firstStepPosition = (): Position => ({
  x: COLUMN_WIDTH_PX,
  y: 0,
});

export const isDraftStep = (
  step: ResolvedStep | DraftStep,
): step is DraftStep => 'draft' in step && step.draft;

export const stepScope = (step: ResolvedStep | DraftStep): DefinitionScope =>
  isDraftStep(step) ? step.scope : step.source.scope;

export const stepHash = (step: ResolvedStep | DraftStep): string | null =>
  isDraftStep(step) ? step.hash : step.source.contentHash;

export const stepDefinitionOf = (
  step: ResolvedStep | DraftStep | StepDraft,
): StepDefinition => ({
  name: step.name,
  type: step.type,
  phase: step.phase,
  skill: step.skill,
  prompt_skill: step.prompt_skill,
  timeout: step.timeout,
  retries: step.retries,
  retry_backoff: step.retry_backoff,
  idempotent: step.idempotent,
  pr: step.pr,
  poll_interval: step.poll_interval,
  decision: step.decision,
  delegate: step.delegate,
  join: step.join,
  required: step.required,
  repeat: step.repeat?.map(name => name.trim()),
  condition: step.condition,
  max_iterations: step.max_iterations,
  probe: step.probe,
  intent: step.intent,
  preferred: step.preferred,
  session: step.session,
  items: step.items,
  policy: step.policy,
  max_depth: step.max_depth,
  on_fail: step.on_fail,
  effect: step.effect,
  needs: [...step.needs],
  body: step.body,
});

export const stepDraftOf = (step: ResolvedStep | DraftStep): StepDraft => ({
  ...stepDefinitionOf(step),
  scope: stepScope(step),
  hash: stepHash(step),
});

export const applyDraft = (
  current: ResolvedStep | DraftStep,
  draft: StepDraft,
): ResolvedStep | DraftStep =>
  isDraftStep(current)
    ? {
        ...stepDefinitionOf(draft),
        draft: true,
        scope: draft.scope,
        hash: current.hash,
      }
    : { ...current, ...stepDefinitionOf(draft) };

export const newDraftStep = (scope: DefinitionScope): StepDraft => ({
  name: '',
  type: 'command',
  phase: 'pre-done',
  skill: null,
  timeout: '15m',
  retries: 0,
  on_fail: 'stop',
  effect: 'local',
  needs: [],
  body: '',
  scope,
  hash: null,
});

export const edgeId = (edge: GraphEdge) => formatEdge(edge);

export const toGraphEdge = (edge: EditorEdge): GraphEdge => ({
  from: edge.from,
  to: edge.to,
  when: edge.when,
  ...(edge.predicate ? { predicate: edge.predicate } : {}),
});

export const editorEdge = (edge: GraphEdge): EditorEdge => ({
  ...edge,
  id: edgeId(edge),
});

const graphStep = (step: StepDefinition): GraphStep => ({
  decision: step.decision,
  join: step.join,
  required: step.required,
  pr: step.pr,
  repeat: step.repeat,
  condition: step.condition,
  type: step.type,
  phase: step.phase,
  effect: step.effect,
  body: step.body,
});

const stepsByName = (nodes: readonly EditorNode[]) =>
  new Map(nodes.map(node => [node.id, graphStep(node.step)]));

const depthsByPhase = (
  nodes: readonly EditorNode[],
  edges: readonly EditorEdge[],
) => {
  const depths = new Map<string, number>();
  for (const phase of phaseOrder) {
    const names = topologicalOrder(
      {
        steps: nodes.map(node => ({ name: node.id, phase: node.step.phase })),
        graph: { edges: edges.map(toGraphEdge) },
      },
      phase,
    );
    for (const name of names) {
      const incoming = edges.filter(edge => edge.to === name);
      depths.set(
        name,
        incoming.reduce(
          (depth, edge) => Math.max(depth, (depths.get(edge.from) ?? 0) + 1),
          0,
        ),
      );
    }
  }
  return depths;
};

const byCurrentPlace = (left: EditorNode, right: EditorNode) =>
  left.position.y - right.position.y ||
  left.position.x - right.position.x ||
  left.id.localeCompare(right.id);

export const autoLayout = (
  nodes: readonly EditorNode[],
  edges: readonly EditorEdge[],
): Record<string, Position> => {
  const depths = depthsByPhase(nodes, edges);
  const positions: Record<string, Position> = {};
  let offset = 0;
  for (const phase of phaseOrder) {
    const inPhase = [...nodes]
      .filter(node => node.step.phase === phase)
      .sort(byCurrentPlace);
    if (inPhase.length === 0) continue;
    const rows = new Map<number, number>();
    let columns = 1;
    for (const node of inPhase) {
      const depth = depths.get(node.id) ?? 0;
      const row = rows.get(depth) ?? 0;
      rows.set(depth, row + 1);
      columns = Math.max(columns, depth + 1);
      positions[node.id] = {
        x: offset + depth * COLUMN_WIDTH_PX,
        y: row * ROW_HEIGHT_PX,
      };
    }
    offset += columns * COLUMN_WIDTH_PX + PHASE_GAP_PX;
  }
  return positions;
};

export const placeAtPhaseEnd = (
  nodes: readonly EditorNode[],
  phase: StepPhase,
): Position => {
  const inPhase = nodes.filter(node => node.step.phase === phase);
  if (inPhase.length)
    return freeSlot(nodes, {
      x: Math.max(...inPhase.map(node => node.position.x)) + COLUMN_WIDTH_PX,
      y: Math.min(...inPhase.map(node => node.position.y)),
    });
  const earlier = nodes.filter(
    node => phaseOrder.indexOf(node.step.phase) < phaseOrder.indexOf(phase),
  );
  const later = nodes.filter(
    node => phaseOrder.indexOf(node.step.phase) > phaseOrder.indexOf(phase),
  );
  if (earlier.length)
    return freeSlot(nodes, {
      x:
        Math.max(...earlier.map(node => node.position.x)) +
        COLUMN_WIDTH_PX +
        PHASE_GAP_PX,
      y: Math.min(...earlier.map(node => node.position.y)),
    });
  if (later.length)
    return freeSlot(nodes, {
      x:
        Math.min(...later.map(node => node.position.x)) -
        COLUMN_WIDTH_PX -
        PHASE_GAP_PX,
      y: Math.min(...later.map(node => node.position.y)),
    });
  return firstStepPosition();
};

const layoutOf = (nodes: readonly EditorNode[]): WorkflowLayout =>
  Object.fromEntries(
    nodes.map(node => [
      node.id,
      [Math.round(node.position.x), Math.round(node.position.y)] as [
        number,
        number,
      ],
    ]),
  );

export const withLayout = (nodes: EditorNode[]) => ({
  nodes,
  layout: layoutOf(nodes),
});

export const defaultScope = (catalog: DefinitionCatalog): DefinitionScope =>
  catalog.roots.project ? 'project' : 'global';

export const newDocument = (catalog: DefinitionCatalog): EditorDocument => ({
  name: '',
  description: '',
  body: '',
  scope: defaultScope(catalog),
  hash: null,
  nodes: [],
  edges: [],
  layout: {},
});

const isStackedLayout = (
  nodes: readonly EditorNode[],
  saved: WorkflowLayout,
): boolean => {
  const bands = phaseOrder
    .map(phase =>
      nodes
        .filter(node => node.step.phase === phase && saved[node.id])
        .map(node => saved[node.id]!),
    )
    .filter(band => band.length > 0);
  if (bands.length < 2) return false;
  return bands.slice(1).every((band, index) => {
    const earlier = bands[index]!;
    const earlierMaxX = Math.max(...earlier.map(([x]) => x));
    const laterMinX = Math.min(...band.map(([x]) => x));
    const earlierMaxY = Math.max(...earlier.map(([, y]) => y));
    const laterMinY = Math.min(...band.map(([, y]) => y));
    return laterMinX <= earlierMaxX && laterMinY > earlierMaxY;
  });
};

export const fromCatalog = (
  workflow: ResolvedWorkflow,
  catalog: DefinitionCatalog,
): EditorDocument => {
  const resolved = workflow.steps.map(
    step => catalog.steps.find(item => item.name === step.name) ?? step,
  );
  const edges = workflow.graph.edges.map(editorEdge);
  const unplaced: EditorNode[] = resolved.map(step => ({
    id: step.name,
    step,
    position: { x: 0, y: 0 },
    issues: [],
  }));
  const saved = workflow.layout ?? {};
  const stacked = isStackedLayout(unplaced, saved);
  const computed =
    Object.keys(saved).length && !stacked ? {} : autoLayout(unplaced, edges);
  const nodes: EditorNode[] = [];
  for (const node of unplaced) {
    const stored = stacked ? undefined : saved[node.id];
    const position = stored
      ? { x: stored[0], y: stored[1] }
      : (computed[node.id] ?? placeAtPhaseEnd(nodes, node.step.phase));
    nodes.push({ ...node, position });
  }
  return {
    name: workflow.name,
    lanes: workflow.lanes,
    decisionMemory: workflow.decision_memory,
    description: workflow.description,
    body: workflow.body,
    scope: workflow.source.scope,
    hash: workflow.source.contentHash,
    edges,
    ...withLayout(nodes),
  };
};

export const orderedStepNames = (document: EditorDocument): string[] => {
  const sorted = [...document.nodes].sort(
    (left, right) =>
      phaseOrder.indexOf(left.step.phase) -
        phaseOrder.indexOf(right.step.phase) ||
      left.position.x - right.position.x ||
      left.position.y - right.position.y ||
      left.id.localeCompare(right.id),
  );
  const view = {
    steps: sorted.map(node => ({ name: node.id, phase: node.step.phase })),
    graph: { edges: document.edges.map(toGraphEdge) },
  };
  return phaseOrder.flatMap(phase => topologicalOrder(view, phase));
};

const plainScalar = /^[A-Za-z0-9][A-Za-z0-9 ,.;'()_/-]*[A-Za-z0-9.)']$/;
const coreScalar =
  /^(?:true|false|null|~|yes|no|on|off|[-+]?(?:0x[0-9a-f_]+|0o[0-7_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:e[-+]?[0-9]+)?)|\.inf|\.nan)$/i;

const yamlText = (value: string) =>
  plainScalar.test(value) && !coreScalar.test(value)
    ? value
    : JSON.stringify(value);

const yamlName = (value: string) =>
  coreScalar.test(value) ? JSON.stringify(value) : value;

export const toFileText = (document: EditorDocument): string => {
  const names = orderedStepNames(document);
  const lines = [`name: ${yamlName(document.name)}`];
  if (document.description)
    lines.push(`description: ${yamlText(document.description)}`);
  if (document.lanes) lines.push(`lanes: ${JSON.stringify(document.lanes)}`);
  if (document.decisionMemory)
    lines.push(`decision_memory: ${document.decisionMemory}`);
  lines.push(`steps: [${names.map(yamlName).join(', ')}]`);
  lines.push('edges:');
  for (const edge of document.edges)
    lines.push(
      `  - ${edge.predicate ? JSON.stringify(formatEdge(toGraphEdge(edge))) : formatEdge(toGraphEdge(edge))}`,
    );
  if (document.edges.length === 0) lines[lines.length - 1] = 'edges: []';
  lines.push('layout:');
  for (const name of names) {
    const position = document.layout[name];
    if (position)
      lines.push(`  ${yamlName(name)}: [${position[0]}, ${position[1]}]`);
  }
  if (names.every(name => !document.layout[name]))
    lines[lines.length - 1] = 'layout: {}';
  return `---\n${lines.join('\n')}\n---\n${document.body}`;
};

export const stepFileText = (step: StepDefinition): string => {
  const lines = [
    `name: ${yamlName(step.name)}`,
    `type: ${step.type}`,
    `phase: ${step.phase}`,
  ];
  if (step.skill) lines.push(`skill: ${yamlName(step.skill)}`);
  if (step.prompt_skill)
    lines.push(`prompt_skill: ${JSON.stringify(step.prompt_skill)}`);
  lines.push(`timeout: ${step.timeout}`);
  if (step.retries) lines.push(`retries: ${step.retries}`);
  if (step.retry_backoff) lines.push(`retry_backoff: ${step.retry_backoff}`);
  if (step.idempotent) lines.push('idempotent: true');
  if (step.pr) lines.push(`pr: ${yamlText(step.pr)}`);
  if (step.poll_interval) lines.push(`poll_interval: ${step.poll_interval}`);
  if (step.join === 'reached') lines.push('join: reached');
  if (step.required) lines.push('required: true');
  if (step.decision) lines.push(`decision: ${JSON.stringify(step.decision)}`);
  if (step.delegate) lines.push(`delegate: ${yamlName(step.delegate)}`);
  if (step.repeat)
    lines.push(`repeat: [${step.repeat.map(yamlName).join(', ')}]`);
  if (step.condition) lines.push(`condition: ${yamlText(step.condition)}`);
  if (step.max_iterations) lines.push(`max_iterations: ${step.max_iterations}`);
  if (step.probe) lines.push(`probe: ${step.probe}`);
  if (step.intent) lines.push(`intent: ${step.intent}`);
  if (step.preferred)
    lines.push(`preferred: ${JSON.stringify(step.preferred)}`);
  if (step.on_fail !== 'stop') lines.push(`on_fail: ${step.on_fail}`);
  if (step.effect !== 'local') lines.push(`effect: ${step.effect}`);
  if (step.needs.length) lines.push(`needs: [${step.needs.join(', ')}]`);
  if (step.session) lines.push(`session: ${JSON.stringify(step.session)}`);
  if (step.items) lines.push(`items: ${JSON.stringify(step.items)}`);
  if (step.policy) lines.push(`policy: ${JSON.stringify(step.policy)}`);
  if (step.max_depth) lines.push(`max_depth: ${step.max_depth}`);
  const body = step.body.endsWith('\n') ? step.body : `${step.body}\n`;
  return `---\n${lines.join('\n')}\n---\n${body}`;
};

export const isStepChanged = (
  node: EditorNode,
  catalog: DefinitionCatalog,
): boolean => {
  if (isDraftStep(node.step)) return true;
  const original = catalog.steps.find(step => step.name === node.id);
  return (
    !original ||
    stepFileText(stepDefinitionOf(original)) !==
      stepFileText(stepDefinitionOf(node.step))
  );
};

export const stepsToWrite = (
  document: EditorDocument,
  catalog: DefinitionCatalog,
): EditorNode[] => document.nodes.filter(node => isStepChanged(node, catalog));

export const usedBy = (
  catalog: DefinitionCatalog,
  stepName: string,
  workflowName: string,
): string[] =>
  catalog.workflows
    .filter(
      workflow =>
        workflow.name !== workflowName &&
        workflow.steps.some(step => step.name === stepName),
    )
    .map(workflow => workflow.name);

const stepIssues = (node: EditorNode): DocumentIssue[] => {
  const parsed = stepDefinitionSchema.safeParse(stepDefinitionOf(node.step));
  if (parsed.success) return [];
  return parsed.error.issues.map(issue => ({
    severity: 'error',
    message: `Step "${node.id}": ${issue.message}`,
    steps: [node.id],
    edgeId: null,
    field: String(issue.path[0] ?? ''),
  }));
};

const graphToDocumentIssue = (
  issue: GraphIssue,
  edges: readonly EditorEdge[],
): DocumentIssue => ({
  severity: issue.severity,
  message: issue.message,
  steps: issue.steps,
  edgeId: issue.edge === null ? null : (edges[issue.edge]?.id ?? null),
  field: issue.field,
});

const workflowFieldIssues = (document: EditorDocument): DocumentIssue[] => {
  const parsed = workflowDefinitionSchema.safeParse({
    name: document.name,
    lanes: document.lanes,
    description: document.description,
    body: document.body,
    steps: document.nodes.map(node => node.id),
    edges: document.edges.map(edge => formatEdge(toGraphEdge(edge))),
    layout: document.layout,
  });
  if (parsed.success) return [];
  return parsed.error.issues
    .filter(issue => issue.path[0] !== 'name' && issue.path[0] !== 'steps')
    .map(issue => ({
      severity: 'error' as const,
      message: `Workflow ${String(issue.path[0] ?? 'file')}: ${issue.message}`,
      steps: [],
      edgeId: null,
      field: String(issue.path[0] ?? ''),
    }));
};

export const validateDocument = (
  document: EditorDocument,
  existingWorkflows: readonly string[] = [],
): DocumentValidation => {
  const issues: DocumentIssue[] = [];
  if (document.hash === null && existingWorkflows.includes(document.name))
    issues.push({
      severity: 'error',
      message: `A workflow named "${document.name}" already exists; open it with Edit.`,
      steps: [],
      edgeId: null,
      field: 'name',
    });
  for (const node of document.nodes)
    if (isDraftStep(node.step) && node.step.name !== node.id)
      issues.push({
        severity: 'error',
        message: `Step name "${node.step.name}" is already used; choose another name.`,
        steps: [node.id],
        edgeId: null,
        field: 'name',
      });
  issues.push(...workflowFieldIssues(document));
  if (!stepNameSchema.safeParse(document.name).success)
    issues.push({
      severity: 'error',
      message: document.name
        ? 'Workflow name: use lowercase letters, digits and single hyphens.'
        : 'Give the workflow a name.',
      steps: [],
      edgeId: null,
      field: 'name',
    });
  if (document.nodes.length === 0)
    issues.push({
      severity: 'error',
      message: 'Add at least one step.',
      steps: [],
      edgeId: null,
      field: 'steps',
    });
  for (const node of document.nodes) issues.push(...stepIssues(node));
  const resolution = resolveGraph(
    {
      name: document.name || 'workflow',
      lanes: document.lanes,
      steps: document.nodes.map(node => node.id),
      edges: document.edges.map(edge => formatEdge(toGraphEdge(edge))),
      layout: document.layout,
    },
    stepsByName(document.nodes),
  );
  for (const issue of resolution.issues)
    issues.push(graphToDocumentIssue(issue, document.edges));
  const nodeIssues = new Map<string, NodeIssue[]>();
  for (const issue of issues)
    for (const step of issue.steps)
      nodeIssues.set(step, [
        ...(nodeIssues.get(step) ?? []),
        { severity: issue.severity, message: issue.message },
      ]);
  return {
    issues,
    nodeIssues,
    hasErrors: issues.some(issue => issue.severity === 'error'),
  };
};

export const connectionRefusal = (
  document: EditorDocument,
  edge: GraphEdge,
): string | null => {
  const before = validateDocument(document).issues.filter(
    issue => issue.severity === 'error',
  );
  const after = validateDocument({
    ...document,
    edges: [...document.edges, editorEdge(edge)],
  }).issues.filter(issue => issue.severity === 'error');
  const seen = new Set(before.map(issue => issue.message));
  return after.find(issue => !seen.has(issue.message))?.message ?? null;
};

export const toneColor: Record<WorkflowTone, string> = {
  success: 'var(--success-foreground)',
  error: 'var(--error-foreground)',
  warning: 'var(--warning-foreground)',
  info: 'var(--info-foreground)',
  muted: 'var(--muted-foreground)',
};
