import {
  formatEdge,
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
  type PipelineLayout,
  type ResolvedPipeline,
  type ResolvedStep,
  type StepDefinition,
  type StepPhase,
  type StepType,
} from '@nesvo/contracts';
import { phaseOrder, type PipelineTone } from '@/entities/pipeline';

export type { EdgeCondition, GraphIssue } from '@nesvo/contracts';

export type DraftStep = StepDefinition & {
  draft: true;
  scope: DefinitionScope;
};

export type StepDraft = StepDefinition & {
  scope: DefinitionScope;
  hash: string | null;
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
};

export type EditorDocument = {
  name: string;
  description: string;
  body: string;
  scope: DefinitionScope;
  hash: string | null;
  nodes: EditorNode[];
  edges: EditorEdge[];
  layout: PipelineLayout;
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

export const LANE_HEIGHT_PX = 400;
export const LANE_TOP_PADDING_PX = 48;
export const ROW_HEIGHT_PX = 140;
export const COLUMN_WIDTH_PX = 260;
export const NODE_WIDTH_PX = 224;
export const NODE_HEIGHT_PX = 56;
export const START_NODE_X = -COLUMN_WIDTH_PX;

export const stepTypeLabels: Record<StepType, string> = {
  command: 'Command',
  agent: 'Agent',
  human: 'Human',
  action: 'Action',
};

export const stepTypeOrder: StepType[] = [
  'command',
  'agent',
  'human',
  'action',
];

export const phaseTones: Record<StepPhase, PipelineTone> = {
  plan: 'info',
  'pre-done': 'success',
  'pre-push': 'warning',
};

export const edgeTones: Record<EdgeCondition, PipelineTone> = {
  success: 'muted',
  failure: 'error',
  any: 'info',
};

export const edgeWhenLabels: Record<EdgeCondition, string> = {
  success: 'On success',
  failure: 'On failure',
  any: 'Always',
};

export const laneTop = (phase: StepPhase) =>
  phaseOrder.indexOf(phase) * LANE_HEIGHT_PX;

export const laneOf = (y: number): StepPhase =>
  phaseOrder[
    Math.min(
      phaseOrder.length - 1,
      Math.max(0, Math.floor((y + NODE_HEIGHT_PX / 2) / LANE_HEIGHT_PX)),
    )
  ] as StepPhase;

export const clampToLane = (phase: StepPhase, y: number) => {
  const top = laneTop(phase) + 8;
  const bottom = laneTop(phase) + LANE_HEIGHT_PX - NODE_HEIGHT_PX - 8;
  return Math.min(bottom, Math.max(top, y));
};

export const isDraftStep = (
  step: ResolvedStep | DraftStep,
): step is DraftStep => 'draft' in step && step.draft;

export const stepScope = (step: ResolvedStep | DraftStep): DefinitionScope =>
  isDraftStep(step) ? step.scope : step.source.scope;

export const stepHash = (step: ResolvedStep | DraftStep): string | null =>
  isDraftStep(step) ? null : step.source.contentHash;

export const stepDefinitionOf = (
  step: ResolvedStep | DraftStep | StepDraft,
): StepDefinition => ({
  name: step.name,
  type: step.type,
  phase: step.phase,
  skill: step.skill,
  timeout: step.timeout,
  retries: step.retries,
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
    ? { ...stepDefinitionOf(draft), draft: true, scope: draft.scope }
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
});

export const editorEdge = (edge: GraphEdge): EditorEdge => ({
  id: edgeId(edge),
  ...edge,
});

const graphStep = (step: StepDefinition): GraphStep => ({
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

export const autoLayout = (
  nodes: readonly EditorNode[],
  edges: readonly EditorEdge[],
): Record<string, { x: number; y: number }> => {
  const depths = depthsByPhase(nodes, edges);
  const positions: Record<string, { x: number; y: number }> = {};
  for (const phase of phaseOrder) {
    const rows = new Map<number, number>();
    for (const node of nodes) {
      if (node.step.phase !== phase) continue;
      const depth = depths.get(node.id) ?? 0;
      const row = rows.get(depth) ?? 0;
      rows.set(depth, row + 1);
      positions[node.id] = {
        x: depth * COLUMN_WIDTH_PX,
        y: laneTop(phase) + LANE_TOP_PADDING_PX + row * ROW_HEIGHT_PX,
      };
    }
  }
  return positions;
};

export const placeAtLaneEnd = (
  nodes: readonly EditorNode[],
  phase: StepPhase,
) => {
  const inLane = nodes.filter(node => node.step.phase === phase);
  const x = inLane.length
    ? Math.max(...inLane.map(node => node.position.x)) + COLUMN_WIDTH_PX
    : 0;
  return { x, y: laneTop(phase) + LANE_TOP_PADDING_PX };
};

const layoutOf = (nodes: readonly EditorNode[]): PipelineLayout =>
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

export const fromCatalog = (
  pipeline: ResolvedPipeline,
  catalog: DefinitionCatalog,
): EditorDocument => {
  const resolved = pipeline.steps.map(
    step => catalog.steps.find(item => item.name === step.name) ?? step,
  );
  const edges = pipeline.graph.edges.map(editorEdge);
  const unplaced: EditorNode[] = resolved.map(step => ({
    id: step.name,
    step,
    position: { x: 0, y: laneTop(step.phase) + LANE_TOP_PADDING_PX },
    issues: [],
  }));
  const saved = pipeline.layout ?? {};
  const computed = Object.keys(saved).length ? {} : autoLayout(unplaced, edges);
  const nodes: EditorNode[] = [];
  for (const node of unplaced) {
    const stored = saved[node.id];
    const position = stored
      ? { x: stored[0], y: clampToLane(node.step.phase, stored[1]) }
      : (computed[node.id] ?? placeAtLaneEnd(nodes, node.step.phase));
    nodes.push({ ...node, position });
  }
  return {
    name: pipeline.name,
    description: pipeline.description,
    body: pipeline.body,
    scope: pipeline.source.scope,
    hash: pipeline.source.contentHash,
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

const yamlText = (value: string) =>
  plainScalar.test(value) ? value : JSON.stringify(value);

export const toFileText = (document: EditorDocument): string => {
  const names = orderedStepNames(document);
  const lines = [`name: ${document.name}`];
  if (document.description)
    lines.push(`description: ${yamlText(document.description)}`);
  lines.push(`steps: [${names.join(', ')}]`);
  lines.push('edges:');
  for (const edge of document.edges)
    lines.push(`  - ${formatEdge(toGraphEdge(edge))}`);
  if (document.edges.length === 0) lines[lines.length - 1] = 'edges: []';
  lines.push('layout:');
  for (const name of names) {
    const position = document.layout[name];
    if (position) lines.push(`  ${name}: [${position[0]}, ${position[1]}]`);
  }
  if (names.every(name => !document.layout[name]))
    lines[lines.length - 1] = 'layout: {}';
  return `---\n${lines.join('\n')}\n---\n${document.body}`;
};

export const stepFileText = (step: StepDefinition): string => {
  const lines = [
    `name: ${step.name}`,
    `type: ${step.type}`,
    `phase: ${step.phase}`,
  ];
  if (step.skill) lines.push(`skill: ${step.skill}`);
  lines.push(`timeout: ${step.timeout}`);
  if (step.retries) lines.push(`retries: ${step.retries}`);
  if (step.on_fail !== 'stop') lines.push(`on_fail: ${step.on_fail}`);
  if (step.effect !== 'local') lines.push(`effect: ${step.effect}`);
  if (step.needs.length) lines.push(`needs: [${step.needs.join(', ')}]`);
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
  pipelineName: string,
): string[] =>
  catalog.pipelines
    .filter(
      pipeline =>
        pipeline.name !== pipelineName &&
        pipeline.steps.some(step => step.name === stepName),
    )
    .map(pipeline => pipeline.name);

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

export const validateDocument = (
  document: EditorDocument,
): DocumentValidation => {
  const issues: DocumentIssue[] = [];
  if (!stepNameSchema.safeParse(document.name).success)
    issues.push({
      severity: 'error',
      message: document.name
        ? 'Pipeline name: use lowercase letters, digits and single hyphens.'
        : 'Give the pipeline a name.',
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
      name: document.name || 'pipeline',
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

export const toneColor: Record<PipelineTone, string> = {
  success: 'var(--success-foreground)',
  error: 'var(--error-foreground)',
  warning: 'var(--warning-foreground)',
  info: 'var(--info-foreground)',
  muted: 'var(--muted-foreground)',
};
