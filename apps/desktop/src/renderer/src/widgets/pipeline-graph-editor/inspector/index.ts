import type { ComponentType } from 'react';
import type {
  Computer,
  DefinitionIssue,
  DefinitionScope,
  EdgeCondition,
  SaveScheduledJobInput,
  ScheduledJob,
  SkillEntry,
  StepType,
  TaskSpecSummary,
} from '@nesvo/contracts';
import type { ProviderStates } from '@/entities/session';
import type { EditorEdge, StepDraft } from '@/entities/pipeline-graph';
import { EdgeInspectorForm } from './edge-inspector';
import { PipelineInspectorForm } from './pipeline-inspector';
import { StartInspectorPlaceholder } from './start-inspector';
import { StepInspectorForm } from './step-inspector';

export type InspectorMode = 'create' | 'edit';

export type InspectorIssue = DefinitionIssue & { field?: string };

export type EdgeWhen = EdgeCondition;

export type SkillSummary = Pick<
  SkillEntry,
  'id' | 'name' | 'description' | 'source'
>;

export type PipelineFields = {
  name: string;
  description: string;
  body: string;
};

export type AutomationInput = Omit<SaveScheduledJobInput, 'expectedRevision'>;

export type StepInspectorProps = {
  step: StepDraft;
  mode: InspectorMode;
  usedBy: string[];
  skills: SkillSummary[];
  issues: InspectorIssue[];
  onChange: (step: StepDraft) => void;
  onSave: () => void;
  onDelete?: () => void;
};

export type PipelineInspectorProps = {
  name: string;
  description: string;
  body: string;
  scope: DefinitionScope;
  mode: InspectorMode;
  issues: InspectorIssue[];
  onChange: (fields: PipelineFields) => void;
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
  pipelineName: string;
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
export const PipelineInspector: ComponentType<PipelineInspectorProps> =
  PipelineInspectorForm;
export const EdgeInspector: ComponentType<EdgeInspectorProps> =
  EdgeInspectorForm;
export const StartInspector: ComponentType<StartInspectorProps> =
  StartInspectorPlaceholder;
