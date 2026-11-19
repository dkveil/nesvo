import type { ReactNode } from 'react';
import type { ComponentType } from 'react';
import type {
  Computer,
  DefinitionIssue,
  DefinitionScope,
  EdgeCondition,
  SaveScheduledJobInput,
  ScheduledJob,
  StepType,
  TaskSpecSummary,
} from '@nesvo/contracts';
import type { ProviderStates } from '@/entities/session';
import type { EditorEdge, StepDraft } from '@/entities/workflow-graph';
import { EdgeInspectorForm } from './edge-inspector';
import { WorkflowInspectorForm } from './workflow-inspector';
import { StartInspectorForm } from './start-inspector';
import { StepInspectorForm } from './step-inspector';

export type InspectorMode = 'create' | 'edit';

export type InspectorIssue = DefinitionIssue & { field?: string };

export type EdgeWhen = EdgeCondition;

export type WorkflowFields = {
  name: string;
  description: string;
  body: string;
};

export type AutomationInput = Omit<SaveScheduledJobInput, 'expectedRevision'>;

export type StepInspectorProps = {
  step: StepDraft;
  mode: InspectorMode;
  renamable?: boolean;
  beforeFields?: ReactNode;
  usedBy: string[];
  hostId: string;
  directory: string;
  issues: InspectorIssue[];
  onChange: (step: StepDraft) => void;
  onSave: () => void;
  onDelete?: () => void;
};

export type WorkflowInspectorProps = {
  name: string;
  description: string;
  body: string;
  scope: DefinitionScope;
  mode: InspectorMode;
  issues: InspectorIssue[];
  onChange: (fields: WorkflowFields) => void;
};

export type EdgeInspectorProps = {
  edge: EditorEdge;
  sourceType: StepType;
  onChange: (when: EdgeWhen) => void;
  onDelete: () => void;
};

export type StartInspectorProps = {
  hostId: string;
  directory: string;
  workflowName: string;
  specs: TaskSpecSummary[];
  automations: ScheduledJob[];
  computers: Computer[];
  statuses: ProviderStates;
  onSaveAutomation: (
    input: AutomationInput,
    expectedRevision: number | null,
  ) => Promise<void>;
  onRefresh: () => void;
};

export const StepInspector: ComponentType<StepInspectorProps> =
  StepInspectorForm;
export const WorkflowInspector: ComponentType<WorkflowInspectorProps> =
  WorkflowInspectorForm;
export const EdgeInspector: ComponentType<EdgeInspectorProps> =
  EdgeInspectorForm;
export const StartInspector: ComponentType<StartInspectorProps> =
  StartInspectorForm;
