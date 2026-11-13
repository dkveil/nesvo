import { z } from 'zod';
import type { MobileGatewayStatus, MobilePairing } from './mobile';
import type { AppliedColorScheme, ColorScheme } from './appearance';
import {
  providerUsageInputSchema,
  providerUsageSchema,
  type ProviderUsageInput,
  type ProviderUsage,
} from './provider-usage';
import {
  hostCapabilitySchema,
  type Computer,
  type DesktopReview,
  type DesktopScheduledJob,
  type DesktopScheduledJobRun,
  type DesktopScheduledJobRunPage,
  type DesktopPipelineRun,
  type DesktopPipelineRunDetail,
  type DesktopPipelineRunPage,
  type DesktopSession,
  type HostId,
  type SshComputerInput,
  type WorkspaceEvent,
} from './computers';
import {
  claudeStatusSchema,
  codexStatusSchema,
  createSessionSchema,
  sendMessageSchema,
  sessionSchema,
  stopRunSchema,
  respondApprovalSchema,
  decideDelegationSchema,
  type ClaudeStatus,
  type CodexStatus,
  type CreateSessionInput,
  type SendMessageInput,
  type StopRunInput,
  type RespondApprovalInput,
  type DecideDelegationInput,
} from './sessions';
import {
  reviewSchema,
  decideReviewSchema,
  type DecideReviewInput,
} from './reviews';
import {
  listWorkspaceDirectorySchema,
  searchWorkspaceFilesSchema,
  readWorkspaceFileSchema,
  workspaceDirectorySchema,
  workspaceSearchSchema,
  workspaceFileSchema,
  type ListWorkspaceDirectoryInput,
  type SearchWorkspaceFilesInput,
  type ReadWorkspaceFileInput,
  type WorkspaceDirectory,
  type WorkspaceSearch,
  type WorkspaceFile,
} from './workspace';
import {
  deleteScheduledJobSchema,
  listScheduledJobRunsSchema,
  listScheduledJobsSchema,
  runScheduledJobNowSchema,
  saveScheduledJobSchema,
  scheduledJobListSchema,
  scheduledJobRunPageSchema,
  scheduledJobRunSchema,
  scheduledJobSchema,
  setScheduledJobActiveSchema,
  type SaveScheduledJobInput,
} from './scheduled-jobs';
import {
  discoverSkillsSchema,
  skillCatalogSchema,
  type DiscoverSkillsInput,
  type SkillCatalog,
} from './skills';
import {
  decidePipelineGateSchema,
  definitionCatalogSchema,
  deletePipelineDefinitionSchema,
  getPipelineRunSchema,
  listPipelineDefinitionsSchema,
  listPipelineRunsSchema,
  pipelineDefinitionConflictSchema,
  pipelineDefinitionRefusedSchema,
  pipelineEvidenceSchema,
  pipelineMetricsInputSchema,
  pipelineMetricsSchema,
  pipelineRunDetailSchema,
  pipelineRunPageSchema,
  pipelineRunSchema,
  pipelineStepRecordSchema,
  readPipelineEvidenceSchema,
  removePipelineWorktreeSchema,
  resumePipelineRunSchema,
  runPipelineStepsSchema,
  savePipelineDefinitionSchema,
  skipPipelineStepSchema,
  startPipelineTaskSchema,
  stopPipelineRunSchema,
  validatePipelineDefinitionsSchema,
  type DecidePipelineGateInput,
  type DefinitionCatalog,
  type DefinitionWriteResult,
  type DeletePipelineDefinitionInput,
  type ListPipelineDefinitionsInput,
  type ListPipelineRunsInput,
  type PipelineEvidence,
  type PipelineMetrics,
  type PipelineMetricsInput,
  type ReadPipelineEvidenceInput,
  type RunPipelineStepsInput,
  type SavePipelineDefinitionInput,
  type SkipPipelineStepInput,
  type StartPipelineTaskInput,
  type ValidatePipelineDefinitionsInput,
} from './pipelines';

export * from './sessions';
export * from './reasoning-effort';
export * from './activities';
export * from './reviews';
export * from './workspace';
export * from './skills';
export * from './computers';
export * from './provider-usage';
export * from './mobile';
export * from './scheduled-jobs';
export * from './appearance';
export * from './pipelines';

export const desktopEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('session-changed'),
    session: sessionSchema,
  }),
  z.strictObject({ type: z.literal('review-changed'), review: reviewSchema }),
  z.strictObject({ type: z.literal('host-disconnected') }),
  z.strictObject({
    type: z.literal('scheduled-job-changed'),
    scheduledJob: scheduledJobSchema,
  }),
  z.strictObject({
    type: z.literal('scheduled-job-removed'),
    scheduledJobId: z.uuid(),
    revision: z.number().int().positive(),
  }),
  z.strictObject({
    type: z.literal('scheduled-job-run-changed'),
    run: scheduledJobRunSchema,
  }),
  z.strictObject({
    type: z.literal('pipeline-run-changed'),
    run: pipelineRunSchema,
  }),
  z.strictObject({
    type: z.literal('pipeline-step-changed'),
    step: pipelineStepRecordSchema,
  }),
]);
export type DesktopEvent = z.infer<typeof desktopEventSchema>;

export const hostRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ id: z.uuid(), method: z.literal('health') }),
  z.strictObject({ id: z.uuid(), method: z.literal('shutdown') }),
  z.strictObject({ id: z.uuid(), method: z.literal('claude-status') }),
  z.strictObject({ id: z.uuid(), method: z.literal('codex-status') }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('provider-usage'),
    input: providerUsageInputSchema,
  }),
  z.strictObject({ id: z.uuid(), method: z.literal('list-sessions') }),
  z.strictObject({ id: z.uuid(), method: z.literal('list-reviews') }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('discover-skills'),
    input: discoverSkillsSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('list-workspace-directory'),
    input: listWorkspaceDirectorySchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('search-workspace-files'),
    input: searchWorkspaceFilesSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-workspace-file'),
    input: readWorkspaceFileSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('decide-review'),
    input: decideReviewSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('create-session'),
    input: createSessionSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('send-message'),
    input: sendMessageSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('stop-run'),
    input: stopRunSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('respond-approval'),
    input: respondApprovalSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('decide-delegation'),
    input: decideDelegationSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('list-scheduled-jobs'),
    input: listScheduledJobsSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('save-scheduled-job'),
    input: saveScheduledJobSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('set-scheduled-job-active'),
    input: setScheduledJobActiveSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('delete-scheduled-job'),
    input: deleteScheduledJobSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('list-scheduled-job-runs'),
    input: listScheduledJobRunsSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('run-scheduled-job-now'),
    input: runScheduledJobNowSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('list-pipeline-definitions'),
    input: listPipelineDefinitionsSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('validate-pipeline-definitions'),
    input: validatePipelineDefinitionsSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('start-pipeline-task'),
    input: startPipelineTaskSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('run-pipeline-steps'),
    input: runPipelineStepsSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('list-pipeline-runs'),
    input: listPipelineRunsSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('get-pipeline-run'),
    input: getPipelineRunSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('decide-pipeline-gate'),
    input: decidePipelineGateSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('skip-pipeline-step'),
    input: skipPipelineStepSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('resume-pipeline-run'),
    input: resumePipelineRunSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('stop-pipeline-run'),
    input: stopPipelineRunSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('save-pipeline-definition'),
    input: savePipelineDefinitionSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('delete-pipeline-definition'),
    input: deletePipelineDefinitionSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('remove-pipeline-worktree'),
    input: removePipelineWorktreeSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-pipeline-evidence'),
    input: readPipelineEvidenceSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('pipeline-metrics'),
    input: pipelineMetricsInputSchema,
  }),
]);

export const hostHealthSchema = z.strictObject({
  status: z.literal('ready'),
  instanceId: z.uuid(),
  protocolVersion: z.literal(1),
  capabilities: z.array(hostCapabilitySchema).max(16).optional(),
});

export const hostConnectSchema = z.strictObject({
  type: z.literal('connect'),
  protocolVersion: z.literal(1),
  expectedInstanceId: z.uuid().optional(),
});

export const hostConnectionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('connected'),
    health: hostHealthSchema,
  }),
  z.strictObject({
    type: z.literal('connection-error'),
    code: z.enum([
      'invalid-handshake',
      'incompatible-protocol',
      'identity-mismatch',
      'invalid-frame',
      'busy',
    ]),
  }),
]);

export type HostConnect = z.infer<typeof hostConnectSchema>;
export type HostConnection = z.infer<typeof hostConnectionSchema>;

export const hostResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('provider-usage'),
    id: z.uuid(),
    usage: providerUsageSchema,
  }),
  z.strictObject({
    type: z.literal('skills'),
    id: z.uuid(),
    catalog: skillCatalogSchema,
  }),
  z.strictObject({
    type: z.literal('workspace-directory'),
    id: z.uuid(),
    directory: workspaceDirectorySchema,
  }),
  z.strictObject({
    type: z.literal('workspace-search'),
    id: z.uuid(),
    search: workspaceSearchSchema,
  }),
  z.strictObject({
    type: z.literal('workspace-file'),
    id: z.uuid(),
    file: workspaceFileSchema,
  }),
  z.strictObject({
    type: z.literal('reviews'),
    id: z.uuid(),
    reviews: z.array(reviewSchema),
  }),
  z.strictObject({
    type: z.literal('review'),
    id: z.uuid(),
    review: reviewSchema,
  }),
  z.strictObject({
    type: z.literal('health'),
    id: z.uuid(),
    health: hostHealthSchema,
  }),
  z.strictObject({ type: z.literal('shutdown'), id: z.uuid() }),
  z.strictObject({
    type: z.literal('claude-status'),
    id: z.uuid(),
    status: claudeStatusSchema,
  }),
  z.strictObject({
    type: z.literal('codex-status'),
    id: z.uuid(),
    status: codexStatusSchema,
  }),
  z.strictObject({
    type: z.literal('sessions'),
    id: z.uuid(),
    sessions: z.array(sessionSchema),
  }),
  z.strictObject({
    type: z.literal('session'),
    id: z.uuid(),
    session: sessionSchema,
  }),
  z.strictObject({
    type: z.literal('scheduled-jobs'),
    id: z.uuid(),
    list: scheduledJobListSchema,
  }),
  z.strictObject({
    type: z.literal('scheduled-job'),
    id: z.uuid(),
    scheduledJob: scheduledJobSchema,
  }),
  z.strictObject({
    type: z.literal('scheduled-job-deleted'),
    id: z.uuid(),
    scheduledJobId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal('scheduled-job-runs'),
    id: z.uuid(),
    page: scheduledJobRunPageSchema,
  }),
  z.strictObject({
    type: z.literal('scheduled-job-run'),
    id: z.uuid(),
    run: scheduledJobRunSchema,
  }),
  z.strictObject({
    type: z.literal('pipeline-definitions'),
    id: z.uuid(),
    catalog: definitionCatalogSchema,
  }),
  pipelineDefinitionConflictSchema.extend({ id: z.uuid() }),
  pipelineDefinitionRefusedSchema.extend({ id: z.uuid() }),
  z.strictObject({
    type: z.literal('pipeline-run'),
    id: z.uuid(),
    run: pipelineRunSchema,
  }),
  z.strictObject({
    type: z.literal('pipeline-runs'),
    id: z.uuid(),
    page: pipelineRunPageSchema,
  }),
  z.strictObject({
    type: z.literal('pipeline-run-detail'),
    id: z.uuid(),
    detail: pipelineRunDetailSchema,
  }),
  z.strictObject({
    type: z.literal('pipeline-evidence'),
    id: z.uuid(),
    evidence: pipelineEvidenceSchema,
  }),
  z.strictObject({
    type: z.literal('pipeline-metrics'),
    id: z.uuid(),
    metrics: pipelineMetricsSchema,
  }),
  z.strictObject({
    type: z.literal('error'),
    id: z.uuid().nullable(),
    code: z.enum([
      'invalid-request',
      'unavailable',
      'busy',
      'not-found',
      'invalid-directory',
    ]),
    message: z.string().optional(),
  }),
]);

export type HostRequest = z.infer<typeof hostRequestSchema>;
export type HostHealth = z.infer<typeof hostHealthSchema>;
export type HostResponse = z.infer<typeof hostResponseSchema>;
export const hostMessageSchema = z.union([
  hostResponseSchema,
  desktopEventSchema,
]);
export type HostMessage = z.infer<typeof hostMessageSchema>;
export type ScheduledJobsApi = {
  list: (hostId: HostId) => Promise<DesktopScheduledJob[]>;
  save: (
    hostId: HostId,
    input: Omit<SaveScheduledJobInput, 'expectedRevision'>,
    expectedRevision: number | null,
  ) => Promise<DesktopScheduledJob>;
  setActive: (
    hostId: HostId,
    id: string,
    active: boolean,
    expectedRevision: number,
  ) => Promise<DesktopScheduledJob>;
  delete: (
    hostId: HostId,
    id: string,
    expectedRevision: number,
  ) => Promise<void>;
  runNow: (
    hostId: HostId,
    id: string,
    requestId: string,
  ) => Promise<DesktopScheduledJobRun>;
  listRuns: (
    hostId: HostId,
    id: string,
    cursor: string | null,
  ) => Promise<DesktopScheduledJobRunPage>;
};
export type PipelineMethod = Extract<
  HostRequest['method'],
  `${string}pipeline${string}`
>;
export const isPipelineMethod = (
  method: HostRequest['method'],
): method is PipelineMethod => method.includes('pipeline');
export type PipelinesApi = {
  listDefinitions: (
    hostId: HostId,
    input: ListPipelineDefinitionsInput,
  ) => Promise<DefinitionCatalog>;
  validateDefinitions: (
    hostId: HostId,
    input: ValidatePipelineDefinitionsInput,
  ) => Promise<DefinitionCatalog>;
  startTask: (
    hostId: HostId,
    input: StartPipelineTaskInput,
  ) => Promise<DesktopPipelineRun>;
  runSteps: (
    hostId: HostId,
    input: RunPipelineStepsInput,
  ) => Promise<DesktopPipelineRun>;
  listRuns: (
    hostId: HostId,
    input: ListPipelineRunsInput,
  ) => Promise<DesktopPipelineRunPage>;
  getRun: (hostId: HostId, runId: string) => Promise<DesktopPipelineRunDetail>;
  decideGate: (
    hostId: HostId,
    input: DecidePipelineGateInput,
  ) => Promise<DesktopPipelineRun>;
  skipStep: (
    hostId: HostId,
    input: SkipPipelineStepInput,
  ) => Promise<DesktopPipelineRun>;
  resumeRun: (hostId: HostId, runId: string) => Promise<DesktopPipelineRun>;
  stopRun: (hostId: HostId, runId: string) => Promise<DesktopPipelineRun>;
  saveDefinition: (
    hostId: HostId,
    input: SavePipelineDefinitionInput,
  ) => Promise<DefinitionWriteResult>;
  deleteDefinition: (
    hostId: HostId,
    input: DeletePipelineDefinitionInput,
  ) => Promise<DefinitionWriteResult>;
  removeWorktree: (
    hostId: HostId,
    runId: string,
  ) => Promise<DesktopPipelineRun>;
  readEvidence: (
    hostId: HostId,
    input: ReadPipelineEvidenceInput,
  ) => Promise<PipelineEvidence>;
  metrics: (
    hostId: HostId,
    input: PipelineMetricsInput,
  ) => Promise<PipelineMetrics>;
};
export type DesktopApi = {
  scheduledJobs: ScheduledJobsApi;
  pipelines: PipelinesApi;
  colorScheme: () => Promise<ColorScheme>;
  setColorScheme: (scheme: ColorScheme) => Promise<ColorScheme>;
  onAppliedColorScheme: (
    listener: (scheme: AppliedColorScheme) => void,
  ) => () => void;
  mobileStatus: () => Promise<MobileGatewayStatus>;
  enableMobile: () => Promise<MobileGatewayStatus>;
  disableMobile: () => Promise<MobileGatewayStatus>;
  pairMobile: () => Promise<MobilePairing>;
  revokeMobile: (deviceId: string) => Promise<MobileGatewayStatus>;
  providerUsage: (
    input: ProviderUsageInput,
    hostId?: HostId,
  ) => Promise<ProviderUsage>;
  listComputers: () => Promise<Computer[]>;
  addComputer: (input: SshComputerInput) => Promise<Computer>;
  connectComputer: (hostId: HostId) => Promise<Computer>;
  disconnectComputer: (hostId: HostId) => Promise<Computer>;
  removeComputer: (hostId: HostId) => Promise<void>;
  health: (hostId?: HostId) => Promise<HostHealth>;
  claudeStatus: (hostId?: HostId) => Promise<ClaudeStatus>;
  codexStatus: (hostId?: HostId) => Promise<CodexStatus>;
  listSessions: (hostId?: HostId) => Promise<DesktopSession[]>;
  listReviews: (hostId?: HostId) => Promise<DesktopReview[]>;
  discoverSkills: (
    input: DiscoverSkillsInput,
    hostId?: HostId,
  ) => Promise<SkillCatalog>;
  listWorkspaceDirectory: (
    input: ListWorkspaceDirectoryInput,
    hostId?: HostId,
  ) => Promise<WorkspaceDirectory>;
  searchWorkspaceFiles: (
    input: SearchWorkspaceFilesInput,
    hostId?: HostId,
  ) => Promise<WorkspaceSearch>;
  readWorkspaceFile: (
    input: ReadWorkspaceFileInput,
    hostId?: HostId,
  ) => Promise<WorkspaceFile>;
  decideReview: (
    input: DecideReviewInput,
    hostId?: HostId,
  ) => Promise<DesktopReview>;
  createSession: (
    input: CreateSessionInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  sendMessage: (
    input: SendMessageInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  stopRun: (input: StopRunInput, hostId?: HostId) => Promise<DesktopSession>;
  respondApproval: (
    input: RespondApprovalInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  decideDelegation: (
    input: DecideDelegationInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  subscribe: (listener: (event: WorkspaceEvent) => void) => () => void;
};
