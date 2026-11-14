import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DefinitionCatalog,
  DefinitionIssue,
  PipelineDefinitionConflict,
  PipelinesApi,
  ResolvedStep,
  StepPhase,
} from '@nesvo/contracts';
import { stepDefinitionSchema } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import {
  applyDraft,
  autoLayout,
  clampToLane,
  connectionRefusal,
  editorEdge,
  fromCatalog,
  isDraftStep,
  newDocument,
  newDraftStep,
  placeAtLaneEnd,
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
  type EditorNode,
  type StepDraft,
} from '@/entities/pipeline-graph';
import type { InspectorIssue } from './inspector';

export type Selection =
  | { kind: 'pipeline' }
  | { kind: 'start' }
  | { kind: 'draft' }
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string };

export type Conflict = {
  kind: 'step' | 'pipeline';
  name: string;
  response: PipelineDefinitionConflict;
};

type Params = {
  hostId: string;
  directory: string;
  pipelineName: string | null;
  catalog: DefinitionCatalog;
  api: Pick<PipelinesApi, 'saveDefinition' | 'listDefinitions'>;
};

const NOTICE_MS = 5000;

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
  pipelineName: string | null,
) => {
  const pipeline = catalog.pipelines.find(item => item.name === pipelineName);
  return pipeline ? fromCatalog(pipeline, catalog) : newDocument(catalog);
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
  const edges = document.edges.map(edge =>
    edge.from === from || edge.to === from
      ? editorEdge({
          from: edge.from === from ? to : edge.from,
          to: edge.to === from ? to : edge.to,
          when: edge.when,
        })
      : edge,
  );
  return { ...document, edges, ...withLayout(nodes) };
};

export function useEditorState({
  hostId,
  directory,
  pipelineName,
  catalog: initialCatalog,
  api,
}: Params) {
  const [catalog, setCatalog] = useState(initialCatalog);
  const [initial, setInitial] = useState(() =>
    initialDocument(initialCatalog, pipelineName),
  );
  const [document, setDocument] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [selection, setSelection] = useState<Selection>({ kind: 'pipeline' });
  const [pendingDraft, setPendingDraft] = useState<StepDraft | null>(null);
  const [draftProblems, setDraftProblems] = useState<InspectorIssue[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [hostIssues, setHostIssues] = useState<DocumentIssue[]>([]);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const validation = useMemo(
    () =>
      validateDocument(
        document,
        catalog.pipelines.map(pipeline => pipeline.name),
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

  const mutate = useCallback(
    (update: (current: EditorDocument) => EditorDocument) => {
      setDocument(update);
      setDirty(true);
      setHostIssues([]);
    },
    [],
  );

  const select = useCallback((next: Selection) => {
    setSelection(next);
    if (next.kind !== 'draft') {
      setPendingDraft(null);
      setDraftProblems([]);
    }
  }, []);

  const setPipelineFields = (fields: {
    name: string;
    description: string;
    body: string;
  }) => mutate(current => ({ ...current, ...fields }));

  const addCatalogStep = (step: ResolvedStep) => {
    if (document.nodes.some(node => node.id === step.name)) {
      showNotice(`Step "${step.name}" is already in this pipeline.`);
      return;
    }
    mutate(current =>
      withDocumentNodes(current, [
        ...current.nodes,
        {
          id: step.name,
          step,
          position: placeAtLaneEnd(current.nodes, step.phase),
          issues: [],
        },
      ]),
    );
    select({ kind: 'node', id: step.name });
  };

  const startDraft = () => {
    setPendingDraft(newDraftStep(document.scope));
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
    if (document.nodes.some(node => node.id === pendingDraft.name))
      problems.push({
        severity: 'error',
        path: '',
        line: null,
        message: `Step "${pendingDraft.name}" is already in this pipeline.`,
        field: 'name',
      });
    else if (catalog.steps.some(step => step.name === pendingDraft.name))
      problems.push({
        severity: 'error',
        path: '',
        line: null,
        message: `A step named "${pendingDraft.name}" already exists; add it from the palette.`,
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
    mutate(current =>
      withDocumentNodes(current, [
        ...current.nodes,
        {
          id: step.name,
          step,
          position: placeAtLaneEnd(current.nodes, step.phase),
          issues: [],
        },
      ]),
    );
    setPendingDraft(null);
    setDraftProblems([]);
    setSelection({ kind: 'node', id: step.name });
  };

  const cancelDraft = () => select({ kind: 'pipeline' });

  const updateStep = (id: string, draft: StepDraft) => {
    const node = document.nodes.find(item => item.id === id);
    if (!node) return;
    const wanted = isDraftStep(node.step) && draft.name !== id;
    const taken =
      wanted &&
      (document.nodes.some(item => item.id === draft.name) ||
        catalog.steps.some(step => step.name === draft.name));
    const renamed = wanted && !taken;
    const nextId = renamed ? draft.name : id;
    const phaseChanged = draft.phase !== node.step.phase;
    mutate(current => {
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
                ? placeAtLaneEnd(
                    base.nodes.filter(other => other.id !== nextId),
                    draft.phase,
                  )
                : item.position,
            }
          : item,
      );
      const edges = phaseChanged
        ? base.edges.filter(edge => edge.from !== nextId && edge.to !== nextId)
        : base.edges;
      return { ...base, edges, ...withLayout(nodes) };
    });
    if (phaseChanged && document.edges.some(e => e.from === id || e.to === id))
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
      current.kind === 'node' && current.id === id
        ? { kind: 'pipeline' }
        : current,
    );
  };

  const moveNode = (id: string, position: { x: number; y: number }) =>
    mutate(current =>
      withDocumentNodes(
        current,
        current.nodes.map(node =>
          node.id === id ? { ...node, position } : node,
        ),
      ),
    );

  const settleNode = (id: string, position: { x: number; y: number }) => {
    const node = document.nodes.find(item => item.id === id);
    if (!node) return;
    const phase: StepPhase = node.step.phase;
    const y = clampToLane(phase, position.y);
    if (y !== position.y)
      showNotice(
        'Steps stay in their phase lane. Change the phase in the step inspector.',
      );
    moveNode(id, { x: Math.round(position.x), y: Math.round(y) });
  };

  const connect = (from: string, to: string) => {
    const edge = { from, to, when: 'success' as const };
    const refusal = connectionRefusal(document, edge);
    if (refusal) {
      showNotice(refusal);
      return;
    }
    const next = editorEdge(edge);
    mutate(current => ({ ...current, edges: [...current.edges, next] }));
    select({ kind: 'edge', id: next.id });
  };

  const setEdgeWhen = (id: string, when: EdgeCondition) => {
    const edge = document.edges.find(item => item.id === id);
    if (!edge || edge.when === when) return;
    const next = editorEdge({ from: edge.from, to: edge.to, when });
    if (document.edges.some(item => item.id === next.id)) {
      showNotice(`Edge "${next.id}" is already in this pipeline.`);
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
      current.kind === 'edge' && current.id === id
        ? { kind: 'pipeline' }
        : current,
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

  const discard = () => {
    setDocument(initial);
    setDirty(false);
    setHostIssues([]);
    setBanner(null);
    select({ kind: 'pipeline' });
  };

  const adoptCatalog = (next: DefinitionCatalog, name: string) => {
    setCatalog(next);
    const pipeline = next.pipelines.find(item => item.name === name);
    if (!pipeline) return;
    const rebuilt = fromCatalog(pipeline, next);
    setInitial(rebuilt);
    setDocument(rebuilt);
    setDirty(false);
  };

  const save = async () => {
    if (saving || validation.hasErrors) return;
    setSaving(true);
    setHostIssues([]);
    setBanner(null);
    try {
      let current = catalog;
      let snapshot = document;
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
          if (result.type === 'pipeline-definition-conflict')
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
          setDocument(doc =>
            withDocumentNodes(
              doc,
              doc.nodes.map(item =>
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
        kind: 'pipeline',
        name: snapshot.name,
        document: toFileText(snapshot),
        expectedHash: snapshot.hash,
      });
      if ('type' in result) {
        if (result.type === 'pipeline-definition-conflict')
          setConflict({
            kind: 'pipeline',
            name: snapshot.name,
            response: result,
          });
        else {
          setHostIssues(result.issues.map(i => hostIssue(i, snapshot.nodes)));
          setBanner('The host refused the pipeline file.');
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
      if (kind === 'pipeline')
        setDocument(current => ({ ...current, hash: response.currentHash }));
      else
        setDocument(current =>
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
      if (kind === 'pipeline') {
        const pipeline = next.pipelines.find(item => item.name === name);
        if (pipeline) {
          adoptCatalog(next, name);
          select({ kind: 'pipeline' });
        } else {
          setDocument(current => ({ ...current, hash: null }));
          setDirty(true);
        }
        return;
      }
      const step = next.steps.find(item => item.name === name);
      setDocument(current =>
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

  return {
    catalog,
    document,
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
    setPipelineFields,
    addCatalogStep,
    updateStep,
    removeNode,
    moveNode,
    settleNode,
    connect,
    setEdgeWhen,
    removeEdge,
    autoLayoutAll,
    discard,
    save,
    notice,
    showNotice,
    banner,
    conflict,
    resolveConflict,
  };
}

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

export type EditorState = ReturnType<typeof useEditorState>;
