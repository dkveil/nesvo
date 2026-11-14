import type {
  DefinitionScope,
  EdgeCondition,
  GraphIssue,
  PipelineLayout,
  ResolvedStep,
  StepDefinition,
} from '@nesvo/contracts';

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
