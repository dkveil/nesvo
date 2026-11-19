import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DefinitionCatalog,
  DefinitionIssue,
  WorkflowDefinitionConflict,
  WorkflowsApi,
  ResolvedStep,
  StepPhase,
  StepType,
} from '@nesvo/contracts';
import { stepDefinitionSchema } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import {
  applyDraft,
  autoLayout,
  connectionRefusal,
  editorEdge,
  fromCatalog,
  isDraftStep,
  newDocument,
  newDraftStep,
  placeAfter,
  placeAtPhaseEnd,
  placeBelow,
  placeBetween,
  stepDefinitionOf,
  stepFileText,
  stepHash,
  stepScope,
  stepsToWrite,
  toFileText,
  validateDocument,
  withLayout,
  type DocumentIssue,
  type EdgeCondition,
  type EditorDocument,
  type EditorEdge,
  type EditorNode,
  type Position,
  type StepDraft,
} from '@/entities/workflow-graph';
import type { InspectorIssue } from './inspector';

export type Selection =
  | { kind: 'none' }
  | { kind: 'workflow' }
  | { kind: 'memory' }
  | { kind: 'start' }
  | { kind: 'draft' }
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string };

export type AddOrigin =
  | { kind: 'start' }
  | { kind: 'after'; id: string; when: EdgeCondition }
  | { kind: 'edge'; id: string };

export type Conflict = {
  kind: 'step' | 'workflow';
  name: string;
  response: WorkflowDefinitionConflict;
};

export type EditorDraftFields = Partial<
  Pick<EditorDocument, 'name' | 'description' | 'body' | 'scope'>
>;

type Params = {
  hostId: string;
  directory: string;
  workflowName: string | null;
  catalog: DefinitionCatalog;
  draft?: EditorDraftFields;
  api: Pick<WorkflowsApi, 'saveDefinition' | 'listDefinitions'>;
};

type DraftOptions = {
  type?: StepType;
  phase?: StepPhase;
  origin?: AddOrigin;
};

const NOTICE_MS = 5000;
const HISTORY_LIMIT = 100;

const fileStem = (path: string) =>
  (path.split(/[\\/]/).at(-1) ?? path).replace(/\.md$/i, '');

const hostIssue = (issue: DefinitionIssue, nodes: EditorNode[]) => {
  const stem = fileStem(issue.path);
  const named = nodes.some(node => node.id === stem)
    ? [stem]
    : nodes
        .map(node => node.id)
        .filter(id => issue.message.includes(`"${id}"`));
  return {
    severity: issue.severity,
    message: issue.message,
    steps: named,
    edgeId: null,
    field: null,
  } satisfies DocumentIssue;
};

const initialDocument = (
  catalog: DefinitionCatalog,
  workflowName: string | null,
  draft: EditorDraftFields | undefined,
) => {
  const workflow = catalog.workflows.find(item => item.name === workflowName);
  return workflow
    ? fromCatalog(workflow, catalog)
    : { ...newDocument(catalog), ...draft };
};

export const draftIssues = (draft: StepDraft): InspectorIssue[] => {
  const parsed = stepDefinitionSchema.safeParse(stepDefinitionOf(draft));
  if (parsed.success) return [];
  return parsed.error.issues.map(issue => ({
    severity: 'error',
    path: '',
    line: null,
    message: issue.message,
    field: String(issue.path[0] ?? ''),
  }));
};

const renameNode = (
  document: EditorDocument,
  from: string,
  to: string,
): EditorDocument => {
  const nodes = document.nodes.map(node =>
    node.id === from ? { ...node, id: to } : node,
  );
  const prefix = `steps.${from}.outputs.`;
  const edges = document.edges.map(edge =>
    editorEdge({
      from: edge.from === from ? to : edge.from,
      to: edge.to === from ? to : edge.to,
      when: edge.when,
      predicate: edge.predicate?.startsWith(prefix)
        ? `steps.${to}.outputs.${edge.predicate.slice(prefix.length)}`
        : edge.predicate,
    }),
  );
  return { ...document, edges, ...withLayout(nodes) };
};

const withDocumentNodes = (
  document: EditorDocument,
  nodes: EditorNode[],
): EditorDocument => ({ ...document, ...withLayout(nodes) });

const rehashed = (
  step: EditorNode['step'],
  hash: string | null,
): EditorNode['step'] => {
  if (isDraftStep(step)) return { ...step, hash };
  if (hash === null)
    return {
      ...stepDefinitionOf(step),
      draft: true,
      scope: step.source.scope,
      hash,
    };
  return { ...step, source: { ...step.source, contentHash: hash } };
};

const selectionIn = (
  document: EditorDocument,
  selection: Selection,
): Selection => {
  if (selection.kind === 'node')
    return document.nodes.some(node => node.id === selection.id)
      ? selection
      : { kind: 'none' };
  if (selection.kind === 'edge')
    return document.edges.some(edge => edge.id === selection.id)
      ? selection
      : { kind: 'none' };
  return selection;
};

const copyName = (base: string, taken: (name: string) => boolean) => {
  const stem = base.replace(/-copy(-\d+)?$/, '');
  let candidate = `${stem}-copy`;
  for (let index = 2; taken(candidate); index += 1)
    candidate = `${stem}-copy-${index}`;
  return candidate;
};

type Insertion = {
  document: EditorDocument;
  notice: string | null;
  selectEdge: string | null;
};

const insertNode = (
  document: EditorDocument,
  step: EditorNode['step'],
  origin: AddOrigin | undefined,
): Insertion => {
  const id = step.name;
  const sourceId =
    origin?.kind === 'after'
      ? origin.id
      : origin?.kind === 'edge'
        ? document.edges.find(edge => edge.id === origin.id)?.from
        : undefined;
  const source = document.nodes.find(node => node.id === sourceId);
  const splitEdge =
    origin?.kind === 'edge'
      ? document.edges.find(edge => edge.id === origin.id)
      : undefined;
  const target = splitEdge
    ? document.nodes.find(node => node.id === splitEdge.to)
    : undefined;
  const position: Position =
    source && target
      ? placeBetween(document.nodes, source, target)
      : source
        ? placeAfter(document.nodes, source)
        : placeAtPhaseEnd(document.nodes, step.phase);
  const node: EditorNode = { id, step, position, issues: [] };
  const base = withDocumentNodes(document, [...document.nodes, node]);
  if (!source) return { document: base, notice: null, selectEdge: null };
  const when =
    origin?.kind === 'after' ? origin.when : (splitEdge?.when ?? 'success');
  const incoming = {
    from: source.id,
    to: id,
    when,
    predicate: splitEdge?.predicate,
  };
  const refusal = connectionRefusal(base, incoming);
  if (refusal)
    return {
      document: base,
      notice: `Added "${id}" without a connection. ${refusal}`,
      selectEdge: null,
    };
  const first = editorEdge(incoming);
  let edges = [...base.edges, first];
  if (splitEdge && target) {
    edges = edges.filter(edge => edge.id !== splitEdge.id);
    const outgoing = { from: id, to: target.id, when: 'success' as const };
    if (!connectionRefusal({ ...base, edges }, outgoing))
      edges.push(editorEdge(outgoing));
  }
  return { document: { ...base, edges }, notice: null, selectEdge: null };
};

export function useEditorState({
  hostId,
  directory,
  workflowName,
  catalog: initialCatalog,
  draft,
  api,
}: Params) {
  const [catalog, setCatalog] = useState(initialCatalog);
  const [initial, setInitial] = useState(() =>
    initialDocument(initialCatalog, workflowName, draft),
  );
  const [document, setDocumentState] = useState(initial);
  const documentRef = useRef(initial);
  const history = useRef<{ past: EditorDocument[]; future: EditorDocument[] }>({
    past: [],
    future: [],
  });
  const [historySize, setHistorySize] = useState({ past: 0, future: 0 });
  const dragSnapshot = useRef<EditorDocument | null>(null);
  const lastMerge = useRef<string | null>(null);
  const [dirty, setDirty] = useState(!!draft?.name);
  const [selection, setSelection] = useState<Selection>(
    workflowName || draft?.name ? { kind: 'none' } : { kind: 'workflow' },
  );
  const [pendingDraft, setPendingDraft] = useState<StepDraft | null>(null);
  const [draftOrigin, setDraftOrigin] = useState<AddOrigin | undefined>();
  const [draftProblems, setDraftProblems] = useState<InspectorIssue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [hostIssues, setHostIssues] = useState<DocumentIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const savedRef = useRef({ dirty, name: initial.name });
  useEffect(() => {
    savedRef.current = { dirty, name: initial.name };
  }, [dirty, initial.name]);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const validation = useMemo(
    () =>
      validateDocument(
        document,
        catalog.workflows.map(workflow => workflow.name),
      ),
    [document, catalog],
  );
  const issues = useMemo(
    () => [...validation.issues, ...hostIssues],
    [validation.issues, hostIssues],
  );
  const nodeIssues = useMemo(() => {
    const map = new Map(validation.nodeIssues);
    for (const issue of hostIssues)
      for (const step of issue.steps)
        map.set(step, [
          ...(map.get(step) ?? []),
          { severity: issue.severity, message: issue.message },
        ]);
    return map;
  }, [validation.nodeIssues, hostIssues]);

  const showNotice = useCallback((message: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const syncHistorySize = () =>
    setHistorySize({
      past: history.current.past.length,
      future: history.current.future.length,
    });

  const replaceDocument = useCallback((next: EditorDocument) => {
    documentRef.current = next;
    setDocumentState(next);
  }, []);

  const resetHistory = () => {
    history.current = { past: [], future: [] };
    dragSnapshot.current = null;
    syncHistorySize();
  };

  const remember = (snapshot: EditorDocument) => {
    lastMerge.current = null;
    history.current.past.push(snapshot);
    if (history.current.past.length > HISTORY_LIMIT)
      history.current.past.shift();
    history.current.future = [];
    syncHistorySize();
  };

  const mutate = (
    update: (current: EditorDocument) => EditorDocument,
    options: { transient?: boolean; merge?: string } = {},
  ) => {
    const current = documentRef.current;
    const next = update(current);
    if (next === current) return;
    const merged = !!options.merge && lastMerge.current === options.merge;
    if (!options.transient && !merged) remember(current);
    lastMerge.current = options.transient ? null : (options.merge ?? null);
    replaceDocument(next);
    setDirty(true);
    setHostIssues([]);
  };

  const select = useCallback((next: Selection) => {
    setSelection(next);
    if (next.kind !== 'draft') {
      setPendingDraft(null);
      setDraftOrigin(undefined);
      setDraftProblems([]);
    }
  }, []);

  const setWorkflowFields = (
    fields: Partial<
      Pick<
        EditorDocument,
        'name' | 'description' | 'body' | 'lanes' | 'decisionMemory'
      >
    >,
  ) =>
    mutate(current => ({ ...current, ...fields }), {
      merge: `workflow:${Object.keys(fields).join(',')}`,
    });

  const applyInsertion = (insertion: Insertion, id: string) => {
    mutate(() => insertion.document);
    if (insertion.notice) showNotice(insertion.notice);
    setRevealId(id);
    setSelection({ kind: 'node', id });
  };

  const addCatalogStep = (step: ResolvedStep, origin?: AddOrigin) => {
    if (documentRef.current.nodes.some(node => node.id === step.name)) {
      showNotice(`Step "${step.name}" is already in this workflow.`);
      return;
    }
    applyInsertion(insertNode(documentRef.current, step, origin), step.name);
  };

  const startDraft = (options: DraftOptions = {}) => {
    const draft = newDraftStep(documentRef.current.scope);
    setPendingDraft({
      ...draft,
      type: options.type ?? draft.type,
      intent: options.type === 'check' ? 'tests' : undefined,
      phase: options.phase ?? draft.phase,
      skill: null,
    });
    setDraftOrigin(options.origin);
    setDraftProblems([]);
    setSelection({ kind: 'draft' });
  };

  const updateDraft = (draft: StepDraft) => {
    setPendingDraft(draft);
    if (draftProblems.length) setDraftProblems(draftIssues(draft));
  };

  const commitDraft = () => {
    if (!pendingDraft) return;
    const problems = draftIssues(pendingDraft);
    if (documentRef.current.nodes.some(node => node.id === pendingDraft.name))
      problems.push({
        severity: 'error',
        path: '',
        line: null,
        message: `Step "${pendingDraft.name}" is already in this workflow.`,
        field: 'name',
      });
    else if (
      catalog.steps.some(
        step =>
          step.name === pendingDraft.name &&
          (pendingDraft.scope === 'global' || step.source.scope === 'project'),
      )
    )
      problems.push({
        severity: 'error',
        path: '',
        line: null,
        message: `A step named "${pendingDraft.name}" already exists; add it from the node picker.`,
        field: 'name',
      });
    if (problems.length) {
      setDraftProblems(problems);
      return;
    }
    const step = {
      ...stepDefinitionOf(pendingDraft),
      draft: true as const,
      scope: pendingDraft.scope,
      hash: null,
    };
    const insertion = insertNode(documentRef.current, step, draftOrigin);
    setPendingDraft(null);
    setDraftOrigin(undefined);
    setDraftProblems([]);
    applyInsertion(insertion, step.name);
  };

  const cancelDraft = () => select({ kind: 'none' });

  const updateStep = (id: string, draft: StepDraft) => {
    const node = documentRef.current.nodes.find(item => item.id === id);
    if (!node) return;
    const wanted = isDraftStep(node.step) && draft.name !== id;
    const taken =
      wanted &&
      (documentRef.current.nodes.some(item => item.id === draft.name) ||
        catalog.steps.some(step => step.name === draft.name));
    const renamed = wanted && !taken;
    const nextId = renamed ? draft.name : id;
    const phaseChanged = draft.phase !== node.step.phase;
    const hadEdges = documentRef.current.edges.some(
      edge => edge.from === id || edge.to === id,
    );
    mutate(
      current => {
        const base = renamed ? renameNode(current, id, nextId) : current;
        const nodes = base.nodes.map(item =>
          item.id === nextId
            ? {
                ...item,
                step: applyDraft(item.step, {
                  ...draft,
                  name: isDraftStep(item.step) ? draft.name : item.step.name,
                }),
                position: phaseChanged
                  ? placeAtPhaseEnd(
                      base.nodes.filter(other => other.id !== nextId),
                      draft.phase,
                    )
                  : item.position,
              }
            : item,
        );
        const edges = phaseChanged
          ? base.edges.filter(
              edge => edge.from !== nextId && edge.to !== nextId,
            )
          : base.edges;
        return { ...base, edges, ...withLayout(nodes) };
      },
      { merge: phaseChanged ? undefined : `step:${nextId}` },
    );
    if (phaseChanged && hadEdges)
      showNotice(
        `Connections of "${nextId}" were removed because the step moved to another phase.`,
      );
    if (renamed) setSelection({ kind: 'node', id: nextId });
  };

  const removeNode = (id: string) => {
    mutate(current => ({
      ...current,
      edges: current.edges.filter(edge => edge.from !== id && edge.to !== id),
      ...withLayout(current.nodes.filter(node => node.id !== id)),
    }));
    setSelection(current =>
      current.kind === 'node' && current.id === id ? { kind: 'none' } : current,
    );
  };

  const duplicateNode = (id: string) => {
    const current = documentRef.current;
    const node = current.nodes.find(item => item.id === id);
    if (!node) return;
    const name = copyName(
      id,
      candidate =>
        current.nodes.some(item => item.id === candidate) ||
        catalog.steps.some(step => step.name === candidate),
    );
    const step = {
      ...stepDefinitionOf(node.step),
      name,
      draft: true as const,
      scope: stepScope(node.step),
      hash: null,
    };
    const copy: EditorNode = {
      id: name,
      step,
      position: placeBelow(current.nodes, node),
      issues: [],
    };
    mutate(doc => withDocumentNodes(doc, [...doc.nodes, copy]));
    setRevealId(name);
    setSelection({ kind: 'node', id: name });
  };

  const moveNode = (id: string, position: Position) => {
    if (!dragSnapshot.current) dragSnapshot.current = documentRef.current;
    mutate(
      current =>
        withDocumentNodes(
          current,
          current.nodes.map(node =>
            node.id === id ? { ...node, position } : node,
          ),
        ),
      { transient: true },
    );
  };

  const settleNode = (id: string, position: Position) => {
    const snapshot = dragSnapshot.current;
    dragSnapshot.current = null;
    if (snapshot) remember(snapshot);
    mutate(
      current =>
        withDocumentNodes(
          current,
          current.nodes.map(node =>
            node.id === id
              ? {
                  ...node,
                  position: {
                    x: Math.round(position.x),
                    y: Math.round(position.y),
                  },
                }
              : node,
          ),
        ),
      { transient: !!snapshot },
    );
  };

  const connect = (
    from: string,
    to: string,
    when: EdgeCondition = 'success',
  ) => {
    const edge = { from, to, when };
    const refusal = connectionRefusal(documentRef.current, edge);
    if (refusal) {
      showNotice(refusal);
      return;
    }
    const next = editorEdge(edge);
    mutate(current => ({ ...current, edges: [...current.edges, next] }));
    select({ kind: 'edge', id: next.id });
  };

  const updateEdge = (
    id: string,
    fields: Partial<Pick<EditorEdge, 'when' | 'predicate'>>,
  ) => {
    const edge = documentRef.current.edges.find(item => item.id === id);
    if (!edge) return;
    const next = editorEdge({ ...edge, ...fields });
    if (next.id === id) return;
    if (documentRef.current.edges.some(item => item.id === next.id)) {
      showNotice(`Edge "${next.id}" is already in this workflow.`);
      return;
    }
    mutate(current => ({
      ...current,
      edges: current.edges.map(item => (item.id === id ? next : item)),
    }));
    setSelection({ kind: 'edge', id: next.id });
  };

  const removeEdge = (id: string) => {
    mutate(current => ({
      ...current,
      edges: current.edges.filter(edge => edge.id !== id),
    }));
    setSelection(current =>
      current.kind === 'edge' && current.id === id ? { kind: 'none' } : current,
    );
  };

  const autoLayoutAll = () =>
    mutate(current => {
      const positions = autoLayout(current.nodes, current.edges);
      return withDocumentNodes(
        current,
        current.nodes.map(node => ({
          ...node,
          position: positions[node.id] ?? node.position,
        })),
      );
    });

  const restore = (next: EditorDocument) => {
    lastMerge.current = null;
    syncHistorySize();
    replaceDocument(next);
    setSelection(current => selectionIn(next, current));
    setDirty(true);
    setHostIssues([]);
  };

  const undo = () => {
    const previous = history.current.past.pop();
    if (!previous) return;
    history.current.future.push(documentRef.current);
    restore(previous);
  };

  const redo = () => {
    const next = history.current.future.pop();
    if (!next) return;
    history.current.past.push(documentRef.current);
    restore(next);
  };

  const discard = () => {
    replaceDocument(initial);
    resetHistory();
    setDirty(false);
    setHostIssues([]);
    setBanner(null);
    select({ kind: 'none' });
  };

  const adoptCatalog = (next: DefinitionCatalog, name: string) => {
    setCatalog(next);
    const workflow = next.workflows.find(item => item.name === name);
    if (!workflow) return;
    const rebuilt = fromCatalog(workflow, next);
    setInitial(rebuilt);
    replaceDocument(rebuilt);
    resetHistory();
    setDirty(false);
  };

  const reload = async () => {
    try {
      const next = await api.listDefinitions(hostId, { directory });
      const name = savedRef.current.name;
      if (!savedRef.current.dirty) {
        adoptCatalog(next, name);
        return;
      }
      setCatalog(next);
      const workflow = next.workflows.find(item => item.name === name);
      if (workflow) setInitial(fromCatalog(workflow, next));
      showNotice(
        'The change was written. Discard your unsaved edits to see it.',
      );
    } catch (error) {
      setBanner(`Could not reload the definitions. ${errorDetail(error)}`);
    }
  };

  const save = async () => {
    if (saving || validation.hasErrors) return;
    setSaving(true);
    setHostIssues([]);
    setBanner(null);
    try {
      let current = catalog;
      let snapshot = documentRef.current;
      for (const node of stepsToWrite(snapshot, current)) {
        const result = await api.saveDefinition(hostId, {
          directory,
          scope: stepScope(node.step),
          kind: 'step',
          name: node.id,
          document: stepFileText(stepDefinitionOf(node.step)),
          expectedHash: stepHash(node.step),
        });
        if ('type' in result) {
          setCatalog(current);
          if (result.type === 'workflow-definition-conflict')
            setConflict({ kind: 'step', name: node.id, response: result });
          else {
            setHostIssues(result.issues.map(i => hostIssue(i, snapshot.nodes)));
            setBanner(`The host refused step "${node.id}".`);
          }
          return;
        }
        current = result;
        const saved = result.steps.find(step => step.name === node.id);
        if (saved) {
          snapshot = withDocumentNodes(
            snapshot,
            snapshot.nodes.map(item =>
              item.id === node.id ? { ...item, step: saved } : item,
            ),
          );
          replaceDocument(
            withDocumentNodes(
              documentRef.current,
              documentRef.current.nodes.map(item =>
                item.id === node.id ? { ...item, step: saved } : item,
              ),
            ),
          );
        }
      }
      setCatalog(current);
      const result = await api.saveDefinition(hostId, {
        directory,
        scope: snapshot.scope,
        kind: 'workflow',
        name: snapshot.name,
        document: toFileText(snapshot),
        expectedHash: snapshot.hash,
      });
      if ('type' in result) {
        if (result.type === 'workflow-definition-conflict')
          setConflict({
            kind: 'workflow',
            name: snapshot.name,
            response: result,
          });
        else {
          setHostIssues(result.issues.map(i => hostIssue(i, snapshot.nodes)));
          setBanner('The host refused the workflow file.');
        }
        return;
      }
      adoptCatalog(result, snapshot.name);
      showNotice(`Saved ${snapshot.name}.`);
    } catch (error) {
      setBanner(`Could not save. ${errorDetail(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const resolveConflict = async (choice: 'reload' | 'keep') => {
    if (!conflict) return;
    const { kind, name, response } = conflict;
    setConflict(null);
    if (choice === 'keep') {
      if (response.currentHash === null)
        setCatalog(current => ({
          ...current,
          workflows:
            kind === 'workflow'
              ? current.workflows.filter(item => item.name !== name)
              : current.workflows,
          steps:
            kind === 'step'
              ? current.steps.filter(item => item.name !== name)
              : current.steps,
        }));
      const current = documentRef.current;
      if (kind === 'workflow')
        replaceDocument({ ...current, hash: response.currentHash });
      else
        replaceDocument(
          withDocumentNodes(
            current,
            current.nodes.map(node =>
              node.id === name
                ? { ...node, step: rehashed(node.step, response.currentHash) }
                : node,
            ),
          ),
        );
      setDirty(true);
      return;
    }
    try {
      const next = await api.listDefinitions(hostId, { directory });
      setCatalog(next);
      if (kind === 'workflow') {
        const workflow = next.workflows.find(item => item.name === name);
        if (workflow) {
          adoptCatalog(next, name);
          select({ kind: 'workflow' });
        } else {
          replaceDocument({ ...documentRef.current, hash: null });
          setDirty(true);
        }
        return;
      }
      const step = next.steps.find(item => item.name === name);
      const current = documentRef.current;
      replaceDocument(
        withDocumentNodes(
          current,
          current.nodes.map(node =>
            node.id === name
              ? { ...node, step: step ?? rehashed(node.step, null) }
              : node,
          ),
        ),
      );
      setDirty(true);
    } catch (error) {
      setBanner(`Could not reload. ${errorDetail(error)}`);
    }
  };

  const clearReveal = useCallback(() => setRevealId(null), []);

  return {
    catalog,
    document,
    revealId,
    clearReveal,
    dirty,
    saving,
    validation,
    issues,
    nodeIssues,
    selection,
    select,
    pendingDraft,
    draftProblems,
    startDraft,
    updateDraft,
    commitDraft,
    cancelDraft,
    setWorkflowFields,
    addCatalogStep,
    updateStep,
    removeNode,
    duplicateNode,
    moveNode,
    settleNode,
    connect,
    updateEdge,
    removeEdge,
    autoLayoutAll,
    undo,
    redo,
    canUndo: historySize.past > 0,
    canRedo: historySize.future > 0,
    discard,
    save,
    reload,
    notice,
    showNotice,
    banner,
    conflict,
    resolveConflict,
  };
}

export type EditorState = ReturnType<typeof useEditorState>;
