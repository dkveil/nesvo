import { z } from 'zod';
import {
  retentionDaysSchema,
  transcriptRetentionSchema,
  type TranscriptRetention,
  type WorkLaptopPolicy,
} from './data-policy';
export * from './data-policy';
import {
  createProviderProfileSchema,
  providerProfileListSchema,
  providerProfileSelectionSchema,
  removeProviderProfileSchema,
  renameProviderProfileSchema,
  type CreateProviderProfileInput,
  type ProviderProfile,
  type ProviderProfileSelection,
  type RenameProviderProfileInput,
} from './provider-profiles';
import {
  adoptConversationSchema,
  conversationImportCatalogSchema,
  listConversationsSchema,
  type AdoptConversationInput,
  type ConversationImportCatalog,
  type ListConversationsInput,
} from './conversation-import';
import {
  setSessionTerminalSchema,
  type OpenSessionTerminalInput,
  type SetSessionTerminalInput,
} from './terminal-handoff';
import {
  transcriptSearchInputSchema,
  transcriptSearchPageSchema,
  type TranscriptSearchInput,
  type TranscriptSearchPage,
} from './transcript-search';
import {
  costBudgetListSchema,
  costBudgetSchema,
  costReportSchema,
  createCostBudgetSchema,
  deleteCostBudgetSchema,
  readCostsSchema,
  type CostBudget,
  type CostBudgetList,
  type CostReport,
  type CreateCostBudgetInput,
  type ReadCostsInput,
} from './costs';
import type { MobileGatewayStatus, MobilePairing } from './mobile';
import type { AppliedColorScheme, ColorScheme } from './appearance';
import type { AttentionSession, DesktopAttention } from './attention';
import {
  databaseBackupSchema,
  type AboutInfo,
  type DatabaseBackup,
  type RendererErrorReport,
  type SaveTextFileInput,
  type SavedTextFile,
} from './diagnostics';
import {
  getSessionSchema,
  readSessionMessagesSchema,
  sessionMessagePageSchema,
  sessionMessageUpsertSchema,
  sessionWindowSchema,
  type GetSessionInput,
  type ReadSessionMessagesInput,
  type SessionMessagePage,
} from './session-history';
import {
  historySearchInputSchema,
  historySearchPageSchema,
  type HistorySearchInput,
  type HistorySearchPage,
} from './history-search';
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
  type DesktopReviewDraft,
  type DesktopReviewPublishResult,
  type DesktopScheduledJob,
  type DesktopScheduledJobRun,
  type DesktopScheduledJobRunPage,
  type DesktopWorkflowRun,
  type DesktopWorkflowRunDetail,
  type DesktopWorkflowRunPage,
  type DesktopSession,
  type HostId,
  type OpenedSessionTerminal,
  type SshComputerInput,
  type WorkspaceEvent,
} from './computers';
import {
  claudeStatusSchema,
  codexStatusSchema,
  createSessionSchema,
  readSessionWorktreeSchema,
  sessionWorktreeStatusSchema,
  finishSessionWorktreeSchema,
  runSessionWorktreeSetupSchema,
  removeOrphanedSessionWorktreeSchema,
  sessionWorktreeSetupSchema,
  sessionWorktreeSetupResultSchema,
  orphanedSessionWorktreesSchema,
  orphanedSessionWorktreeRemovalSchema,
  type SessionWorktreeSetup,
  type SessionWorktreeSetupResult,
  type OrphanedSessionWorktrees,
  type OrphanedSessionWorktreeRemoval,
  type RunSessionWorktreeSetupInput,
  type RemoveOrphanedSessionWorktreeInput,
  sendMessageSchema,
  assignSessionWorkflowSchema,
  forkSessionSchema,
  restartSessionSchema,
  compactSessionSchema,
  queuedMessageRefSchema,
  stopRunSchema,
  respondApprovalSchema,
  decideDelegationSchema,
  decideWorkerPlanSchema,
  type ClaudeStatus,
  type CodexStatus,
  type CreateSessionInput,
  type ReadSessionWorktreeInput,
  type SessionWorktreeStatus,
  type FinishSessionWorktreeInput,
  type SendMessageInput,
  type AssignSessionWorkflowInput,
  type ForkSessionInput,
  type RestartSessionInput,
  type CompactSessionInput,
  type QueuedMessageRefInput,
  type StopRunInput,
  type RespondApprovalInput,
  type DecideDelegationInput,
  type DecideWorkerPlanInput,
} from './sessions';
import {
  createSessionGroupSchema,
  deleteSessionGroupSchema,
  moveSessionGroupSchema,
  moveSessionSchema,
  renameSessionSchema,
  sessionGroupListSchema,
  setSessionArchivedSchema,
  setSessionPinnedSchema,
  updateSessionGroupSchema,
  type CreateSessionGroupInput,
  type DeleteSessionGroupInput,
  type MoveSessionGroupInput,
  type MoveSessionInput,
  type RenameSessionInput,
  type SessionGroupList,
  type SetSessionArchivedInput,
  type SetSessionPinnedInput,
  type UpdateSessionGroupInput,
} from './session-groups';
import {
  attachmentContentSchema,
  attachmentUploadSchema,
  readAttachmentSchema,
  stageAttachmentSchema,
  locateAttachmentSchema,
  attachmentLocationSchema,
  type AttachmentContent,
  type OpenAttachmentInput,
  type AttachmentUpload,
  type ReadAttachmentInput,
  type StageAttachmentInput,
} from './attachments';
import {
  SESSION_DELETE_BATCH_LIMIT,
  deleteSessionSchema,
  restoreSessionSchema,
  sessionDeletionSchema,
  type DeleteSessionInput,
  type DesktopSessionDeletion,
  type RestoreSessionInput,
} from './session-deletion';
import {
  reviewSchema,
  decideReviewSchema,
  type DecideReviewInput,
} from './reviews';
import {
  gitBranchSchema,
  readGitBranchSchema,
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
  type ReadGitBranchInput,
  type GitBranch,
} from './workspace';
import {
  readSessionChangePatchSchema,
  readSessionChangesSchema,
  sessionChangePatchSchema,
  sessionChangesSchema,
  type ReadSessionChangePatchInput,
  type ReadSessionChangesInput,
  type SessionChangePatch,
  type SessionChanges,
} from './session-changes';
import {
  decideScheduledJobStartSchema,
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
  type DecideScheduledJobStartInput,
} from './scheduled-jobs';
import {
  listMcpServersSchema,
  trustRepositoryMcpSchema,
  type TrustRepositoryMcpInput,
  mcpServerListSchema,
  type ListMcpServersInput,
  type McpServerList,
} from './mcp';
import { setSessionMcpSchema, type SetSessionMcpInput } from './mcp-selection';
import {
  discoverSkillsSchema,
  skillCatalogSchema,
  type DiscoverSkillsInput,
  type SkillCatalog,
} from './skills';
import {
  decideWorkflowGateSchema,
  definitionCatalogSchema,
  deleteWorkflowDefinitionSchema,
  getWorkflowRunSchema,
  listWorkflowDefinitionsSchema,
  listWorkflowRunsSchema,
  workflowDefinitionConflictSchema,
  workflowDefinitionRefusedSchema,
  workflowEvidenceSchema,
  workflowMetricsInputSchema,
  workflowMetricsSchema,
  workflowRunDetailSchema,
  workflowRunPageSchema,
  workflowRunSchema,
  workflowStepRecordSchema,
  readWorkflowEvidenceSchema,
  removeWorkflowWorktreeSchema,
  resolveWorkflowStepSchema,
  resumeWorkflowRunSchema,
  runWorkflowStepsSchema,
  saveWorkflowDefinitionSchema,
  skipWorkflowStepSchema,
  startWorkflowTaskSchema,
  stopWorkflowRunSchema,
  validateWorkflowDefinitionsSchema,
  workflowAssistantProposalEventSchema,
  workflowAssistantSendSchema,
  workflowAssistantTurnSchema,
  assistantChangeEventSchema,
  assistantChangeHistorySchema,
  assistantChangeRefusedEventSchema,
  assistantUndoResultSchema,
  assistantUndoSchema,
  listAssistantChangesSchema,
  type AssistantChangeHistory,
  type AssistantUndoInput,
  type AssistantUndoResult,
  type DecideWorkflowGateInput,
  type DefinitionCatalog,
  type DefinitionWriteResult,
  type DeleteWorkflowDefinitionInput,
  type ListWorkflowDefinitionsInput,
  type ListWorkflowRunsInput,
  type WorkflowEvidence,
  type WorkflowMetrics,
  type WorkflowMetricsInput,
  type ReadWorkflowEvidenceInput,
  type ResolveWorkflowStepInput,
  type RunWorkflowStepsInput,
  type SaveWorkflowDefinitionInput,
  type SkipWorkflowStepInput,
  type StartWorkflowTaskInput,
  type ValidateWorkflowDefinitionsInput,
  type WorkflowAssistantSendInput,
  type WorkflowAssistantTurn,
} from './workflows';
import {
  actOnPullRequestSchema,
  findSessionPullRequestSchema,
  linkSessionPullRequestSchema,
  listPullRequestsSchema,
  pullRequestActionResultSchema,
  pullRequestFilesSchema,
  pullRequestListSchema,
  pullRequestReferenceSchema,
  pullRequestSchema,
  pullRequestThreadsSchema,
  readPullRequestSchema,
  type ActOnPullRequestInput,
  type FindSessionPullRequestInput,
  type LinkSessionPullRequestInput,
  type ListPullRequestsInput,
  type PullRequest,
  type PullRequestActionResult,
  type PullRequestFiles,
  type PullRequestList,
  type PullRequestReference,
  type PullRequestThreads,
  type ReadPullRequestInput,
} from './pull-requests';
import {
  codeReviewSettingsSchema,
  deleteReviewConventionSchema,
  deleteReviewerProfileSchema,
  discardPullRequestReviewSchema,
  listPullRequestReviewsSchema,
  publishPullRequestReviewResultSchema,
  publishPullRequestReviewSchema,
  reviewDraftEventSchema,
  reviewDraftListSchema,
  reviewDraftSchema,
  saveReviewConventionSchema,
  saveReviewerProfileSchema,
  startPullRequestReviewSchema,
  updateReviewFindingSchema,
  type CodeReviewSettings,
  type DeleteReviewConventionInput,
  type DeleteReviewerProfileInput,
  type DiscardPullRequestReviewInput,
  type ListPullRequestReviewsInput,
  type PublishPullRequestReviewInput,
  type SaveReviewConventionInput,
  type SaveReviewerProfileInput,
  type StartPullRequestReviewInput,
  type UpdateReviewFindingInput,
} from './code-review';
import {
  addTrackedRepositorySchema,
  listTrackedPullRequestsSchema,
  removeTrackedRepositorySchema,
  reorderTrackedRepositoriesSchema,
  trackedPullRequestListsSchema,
  trackedRepositoryListSchema,
  trackedRepositorySuggestionListSchema,
  type AddTrackedRepositoryInput,
  type ListTrackedPullRequestsInput,
  type RemoveTrackedRepositoryInput,
  type ReorderTrackedRepositoriesInput,
  type TrackedPullRequestList,
  type TrackedRepository,
  type TrackedRepositorySuggestion,
} from './tracked-repositories';
import { runningAppListSchema, type RunningAppList } from './running-apps';
import {
  defaultSessionFolderSchema,
  setDefaultSessionFolderSchema,
  type DefaultSessionFolder,
} from './default-session-folder';
import {
  decideSessionWorktreeRecipeSchema,
  deleteWorktreeRecipeSchema,
  matchWorktreeRecipeSchema,
  readSessionWorktreeRecipeSchema,
  saveWorktreeRecipeSchema,
  startWorktreeRecipeTrialSchema,
  worktreeRecipeListSchema,
  worktreeRecipeMatchSchema,
  worktreeRecipeRunSchema,
  worktreeRecipeTrialRefSchema,
  type DecideSessionWorktreeRecipeInput,
  type DeleteWorktreeRecipeInput,
  type MatchWorktreeRecipeInput,
  type ReadSessionWorktreeRecipeInput,
  type SaveWorktreeRecipeInput,
  type StartWorktreeRecipeTrialInput,
  type WorktreeRecipe,
  type WorktreeRecipeMatch,
  type WorktreeRecipeRun,
  type WorktreeRecipeTrialRefInput,
} from './worktree-recipes';

export * from './sessions';
export * from './session-history';
export * from './attachments';
export * from './session-groups';
export * from './session-deletion';
export * from './session-subsessions';
export * from './pull-requests';
export * from './code-review';
export * from './tracked-repositories';
export * from './running-apps';
export * from './default-session-folder';
export * from './worktree-recipes';
export * from './reasoning-effort';
export * from './activities';
export * from './reviews';
export * from './workspace';
export * from './session-changes';
export * from './code-comments';
export * from './history-search';
export * from './conversation-import';
export * from './terminal-handoff';
export * from './transcript-search';
export * from './skills';
export * from './mcp';
export * from './mcp-selection';
export * from './computers';
export * from './provider-usage';
export * from './provider-profiles';
export * from './costs';
export * from './mobile';
export * from './scheduled-jobs';
export * from './appearance';
export * from './attention';
export * from './diagnostics';
export * from './workflows';

export const desktopEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('session-changed'),
    session: sessionWindowSchema,
  }),
  sessionMessageUpsertSchema.extend({
    type: z.literal('session-message-upserted'),
  }),
  z.strictObject({ type: z.literal('review-changed'), review: reviewSchema }),
  z.strictObject({ type: z.literal('host-disconnected') }),
  z.strictObject({
    type: z.literal('sessions-removed'),
    sessionIds: z.array(z.uuid()).min(1).max(SESSION_DELETE_BATCH_LIMIT),
  }),
  z.strictObject({
    type: z.literal('session-groups-changed'),
    list: sessionGroupListSchema,
  }),
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
    type: z.literal('workflow-run-changed'),
    run: workflowRunSchema,
  }),
  z.strictObject({
    type: z.literal('workflow-step-changed'),
    step: workflowStepRecordSchema,
  }),
  workflowAssistantProposalEventSchema.extend({
    type: z.literal('workflow-assistant-proposal'),
  }),
  assistantChangeEventSchema.extend({
    type: z.literal('workflow-assistant-change'),
  }),
  assistantChangeRefusedEventSchema.extend({
    type: z.literal('workflow-assistant-change-refused'),
  }),
  reviewDraftEventSchema.extend({
    type: z.literal('pull-request-review-changed'),
  }),
]);
export type DesktopEvent = z.infer<typeof desktopEventSchema>;

export const hostRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-costs'),
    input: readCostsSchema,
  }),
  z.strictObject({ id: z.uuid(), method: z.literal('list-cost-budgets') }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('create-cost-budget'),
    input: createCostBudgetSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('update-cost-budget'),
    input: costBudgetSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('delete-cost-budget'),
    input: deleteCostBudgetSchema,
  }),
  z.strictObject({ id: z.uuid(), method: z.literal('health') }),
  z.strictObject({ id: z.uuid(), method: z.literal('shutdown') }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('claude-status'),
    input: providerProfileSelectionSchema.optional(),
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('codex-status'),
    input: providerProfileSelectionSchema.optional(),
  }),
  z.strictObject({ id: z.uuid(), method: z.literal('list-provider-profiles') }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('create-provider-profile'),
    input: createProviderProfileSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('rename-provider-profile'),
    input: renameProviderProfileSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('remove-provider-profile'),
    input: removeProviderProfileSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('provider-usage'),
    input: providerUsageInputSchema,
  }),
  z.strictObject({ id: z.uuid(), method: z.literal('list-sessions') }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('get-session'),
    input: getSessionSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-session-messages'),
    input: readSessionMessagesSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('search-history'),
    input: historySearchInputSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('list-conversations'),
    input: listConversationsSchema.optional(),
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('adopt-conversation'),
    input: adoptConversationSchema,
  }),
  z.strictObject({ id: z.uuid(), method: z.literal('list-reviews') }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('discover-skills'),
    input: discoverSkillsSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('list-mcp-servers'),
    input: listMcpServersSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('trust-repository-mcp'),
    input: trustRepositoryMcpSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('set-session-mcp'),
    input: setSessionMcpSchema,
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
    method: z.literal('stage-attachment'),
    input: stageAttachmentSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-attachment'),
    input: readAttachmentSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('locate-attachment'),
    input: locateAttachmentSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-git-branch'),
    input: readGitBranchSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-session-changes'),
    input: readSessionChangesSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-session-change-patch'),
    input: readSessionChangePatchSchema,
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
    method: z.literal('read-session-worktree'),
    input: readSessionWorktreeSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('finish-session-worktree'),
    input: finishSessionWorktreeSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-session-worktree-setup'),
    input: readSessionWorktreeSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('run-session-worktree-setup'),
    input: runSessionWorktreeSetupSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('list-orphaned-session-worktrees'),
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('remove-orphaned-session-worktree'),
    input: removeOrphanedSessionWorktreeSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('send-message'),
    input: sendMessageSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('queue-message'),
    input: sendMessageSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('assign-session-workflow'),
    input: assignSessionWorkflowSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('fork-session'),
    input: forkSessionSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('restart-session'),
    input: restartSessionSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('compact-session'),
    input: compactSessionSchema,
  }),
  z.strictObject({ id: z.uuid(), method: z.literal('list-session-groups') }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('get-transcript-retention'),
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('set-transcript-retention'),
    input: retentionDaysSchema,
  }),
  z.strictObject({ id: z.uuid(), method: z.literal('purge-transcripts') }),
  z.strictObject({ id: z.uuid(), method: z.literal('backup-database') }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('create-session-group'),
    input: createSessionGroupSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('update-session-group'),
    input: updateSessionGroupSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('move-session-group'),
    input: moveSessionGroupSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('delete-session-group'),
    input: deleteSessionGroupSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('move-session'),
    input: moveSessionSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('rename-session'),
    input: renameSessionSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('set-session-pinned'),
    input: setSessionPinnedSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('set-session-archived'),
    input: setSessionArchivedSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('set-session-terminal'),
    input: setSessionTerminalSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('search-transcripts'),
    input: transcriptSearchInputSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('delete-session'),
    input: deleteSessionSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('restore-session'),
    input: restoreSessionSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('list-pull-requests'),
    input: listPullRequestsSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-pull-request'),
    input: readPullRequestSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-pull-request-files'),
    input: readPullRequestSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-pull-request-threads'),
    input: readPullRequestSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('act-on-pull-request'),
    input: actOnPullRequestSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('link-session-pull-request'),
    input: linkSessionPullRequestSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('find-session-pull-request'),
    input: findSessionPullRequestSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('list-tracked-repositories'),
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('list-running-apps'),
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-default-session-folder'),
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('set-default-session-folder'),
    input: setDefaultSessionFolderSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('list-worktree-recipes'),
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('save-worktree-recipe'),
    input: saveWorktreeRecipeSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('delete-worktree-recipe'),
    input: deleteWorktreeRecipeSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('match-worktree-recipe'),
    input: matchWorktreeRecipeSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('start-worktree-recipe-trial'),
    input: startWorktreeRecipeTrialSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-worktree-recipe-trial'),
    input: worktreeRecipeTrialRefSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('stop-worktree-recipe-trial'),
    input: worktreeRecipeTrialRefSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-session-worktree-recipe'),
    input: readSessionWorktreeRecipeSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('decide-session-worktree-recipe'),
    input: decideSessionWorktreeRecipeSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('add-tracked-repository'),
    input: addTrackedRepositorySchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('remove-tracked-repository'),
    input: removeTrackedRepositorySchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('reorder-tracked-repositories'),
    input: reorderTrackedRepositoriesSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('suggest-tracked-repositories'),
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('list-tracked-pull-requests'),
    input: listTrackedPullRequestsSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-code-review-settings'),
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('save-reviewer-profile'),
    input: saveReviewerProfileSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('delete-reviewer-profile'),
    input: deleteReviewerProfileSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('save-review-convention'),
    input: saveReviewConventionSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('delete-review-convention'),
    input: deleteReviewConventionSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('start-pull-request-review'),
    input: startPullRequestReviewSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('list-pull-request-reviews'),
    input: listPullRequestReviewsSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('update-review-finding'),
    input: updateReviewFindingSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('discard-pull-request-review'),
    input: discardPullRequestReviewSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('publish-pull-request-review'),
    input: publishPullRequestReviewSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('cancel-queued'),
    input: queuedMessageRefSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('start-queued'),
    input: queuedMessageRefSchema,
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
    method: z.literal('decide-worker-plan'),
    input: decideWorkerPlanSchema,
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
    method: z.literal('decide-scheduled-job-start'),
    input: decideScheduledJobStartSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('list-workflow-definitions'),
    input: listWorkflowDefinitionsSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('validate-workflow-definitions'),
    input: validateWorkflowDefinitionsSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('start-workflow-task'),
    input: startWorkflowTaskSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('run-workflow-steps'),
    input: runWorkflowStepsSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('list-workflow-runs'),
    input: listWorkflowRunsSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('get-workflow-run'),
    input: getWorkflowRunSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('decide-workflow-gate'),
    input: decideWorkflowGateSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('skip-workflow-step'),
    input: skipWorkflowStepSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('resume-workflow-run'),
    input: resumeWorkflowRunSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('resolve-workflow-step'),
    input: resolveWorkflowStepSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('stop-workflow-run'),
    input: stopWorkflowRunSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('save-workflow-definition'),
    input: saveWorkflowDefinitionSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('delete-workflow-definition'),
    input: deleteWorkflowDefinitionSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('remove-workflow-worktree'),
    input: removeWorkflowWorktreeSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('read-workflow-evidence'),
    input: readWorkflowEvidenceSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('workflow-metrics'),
    input: workflowMetricsInputSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('workflow-assistant-send'),
    input: workflowAssistantSendSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('workflow-assistant-undo'),
    input: assistantUndoSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('workflow-assistant-changes'),
    input: listAssistantChangesSchema,
  }),
]);

export const hostHealthSchema = z.strictObject({
  quarantinedSessionCount: z.number().int().nonnegative().optional(),
  status: z.literal('ready'),
  instanceId: z.uuid(),
  protocolVersion: z.literal(1),
  contractRevision: z.number().int().min(1).max(1_000_000).optional(),
  capabilities: z.array(hostCapabilitySchema).max(64).optional(),
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
    type: z.literal('costs'),
    id: z.uuid(),
    report: costReportSchema,
  }),
  z.strictObject({
    type: z.literal('cost-budgets'),
    id: z.uuid(),
    list: costBudgetListSchema,
  }),
  z.strictObject({
    type: z.literal('cost-budget'),
    id: z.uuid(),
    budget: costBudgetSchema,
  }),
  z.strictObject({
    type: z.literal('cost-budget-deleted'),
    id: z.uuid(),
    deleted: deleteCostBudgetSchema,
  }),
  z.strictObject({
    type: z.literal('provider-profiles'),
    id: z.uuid(),
    profiles: providerProfileListSchema,
  }),
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
    type: z.literal('mcp-servers'),
    id: z.uuid(),
    list: mcpServerListSchema,
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
    type: z.literal('attachment-upload'),
    id: z.uuid(),
    upload: attachmentUploadSchema,
  }),
  z.strictObject({
    type: z.literal('attachment-content'),
    id: z.uuid(),
    content: attachmentContentSchema,
  }),
  z.strictObject({
    type: z.literal('attachment-location'),
    id: z.uuid(),
    location: attachmentLocationSchema,
  }),
  z.strictObject({
    type: z.literal('history-search'),
    id: z.uuid(),
    search: historySearchPageSchema,
  }),
  z.strictObject({
    type: z.literal('conversation-import-catalog'),
    id: z.uuid(),
    catalog: conversationImportCatalogSchema,
  }),
  z.strictObject({
    type: z.literal('transcript-search'),
    id: z.uuid(),
    search: transcriptSearchPageSchema,
  }),
  z.strictObject({
    type: z.literal('git-branch'),
    id: z.uuid(),
    branch: gitBranchSchema,
  }),
  z.strictObject({
    type: z.literal('session-changes'),
    id: z.uuid(),
    changes: sessionChangesSchema,
  }),
  z.strictObject({
    type: z.literal('session-change-patch'),
    id: z.uuid(),
    patch: sessionChangePatchSchema,
  }),
  z.strictObject({
    type: z.literal('session-worktree-status'),
    id: z.uuid(),
    worktree: sessionWorktreeStatusSchema,
  }),
  z.strictObject({
    type: z.literal('session-worktree-setup'),
    id: z.uuid(),
    setup: sessionWorktreeSetupSchema,
  }),
  z.strictObject({
    type: z.literal('session-worktree-setup-result'),
    id: z.uuid(),
    result: sessionWorktreeSetupResultSchema,
  }),
  z.strictObject({
    type: z.literal('orphaned-session-worktrees'),
    id: z.uuid(),
    worktrees: orphanedSessionWorktreesSchema,
  }),
  z.strictObject({
    type: z.literal('orphaned-session-worktree-removal'),
    id: z.uuid(),
    removal: orphanedSessionWorktreeRemovalSchema,
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
    sessions: z.array(sessionWindowSchema),
  }),
  z.strictObject({
    type: z.literal('session'),
    id: z.uuid(),
    session: sessionWindowSchema,
  }),
  z.strictObject({
    type: z.literal('session-messages'),
    id: z.uuid(),
    page: sessionMessagePageSchema,
  }),
  z.strictObject({
    type: z.literal('session-groups'),
    id: z.uuid(),
    list: sessionGroupListSchema,
  }),
  z.strictObject({
    type: z.literal('session-deletion'),
    id: z.uuid(),
    deletion: sessionDeletionSchema,
  }),
  z.strictObject({
    type: z.literal('transcript-retention'),
    id: z.uuid(),
    retention: transcriptRetentionSchema,
  }),
  z.strictObject({
    type: z.literal('database-backup'),
    id: z.uuid(),
    backup: databaseBackupSchema,
  }),
  z.strictObject({
    type: z.literal('pull-request-list'),
    id: z.uuid(),
    list: pullRequestListSchema,
  }),
  z.strictObject({
    type: z.literal('pull-request'),
    id: z.uuid(),
    pullRequest: pullRequestSchema,
  }),
  z.strictObject({
    type: z.literal('pull-request-files'),
    id: z.uuid(),
    files: pullRequestFilesSchema,
  }),
  z.strictObject({
    type: z.literal('pull-request-threads'),
    id: z.uuid(),
    threads: pullRequestThreadsSchema,
  }),
  z.strictObject({
    type: z.literal('pull-request-action'),
    id: z.uuid(),
    result: pullRequestActionResultSchema,
  }),
  z.strictObject({
    type: z.literal('pull-request-reference'),
    id: z.uuid(),
    reference: pullRequestReferenceSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal('tracked-repositories'),
    id: z.uuid(),
    repositories: trackedRepositoryListSchema,
  }),
  z.strictObject({
    type: z.literal('running-apps'),
    id: z.uuid(),
    list: runningAppListSchema,
  }),
  z.strictObject({
    type: z.literal('default-session-folder'),
    id: z.uuid(),
    directory: defaultSessionFolderSchema,
  }),
  z.strictObject({
    type: z.literal('worktree-recipes'),
    id: z.uuid(),
    recipes: worktreeRecipeListSchema,
  }),
  z.strictObject({
    type: z.literal('worktree-recipe-match'),
    id: z.uuid(),
    match: worktreeRecipeMatchSchema,
  }),
  z.strictObject({
    type: z.literal('worktree-recipe-trial'),
    id: z.uuid(),
    trial: worktreeRecipeRunSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal('session-worktree-recipe'),
    id: z.uuid(),
    run: worktreeRecipeRunSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal('tracked-repository-suggestions'),
    id: z.uuid(),
    suggestions: trackedRepositorySuggestionListSchema,
  }),
  z.strictObject({
    type: z.literal('tracked-pull-request-lists'),
    id: z.uuid(),
    lists: trackedPullRequestListsSchema,
  }),
  z.strictObject({
    type: z.literal('code-review-settings'),
    id: z.uuid(),
    settings: codeReviewSettingsSchema,
  }),
  z.strictObject({
    type: z.literal('pull-request-review'),
    id: z.uuid(),
    draft: reviewDraftSchema,
  }),
  z.strictObject({
    type: z.literal('pull-request-reviews'),
    id: z.uuid(),
    drafts: reviewDraftListSchema,
  }),
  z.strictObject({
    type: z.literal('pull-request-review-publish'),
    id: z.uuid(),
    result: publishPullRequestReviewResultSchema,
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
    type: z.literal('workflow-definitions'),
    id: z.uuid(),
    catalog: definitionCatalogSchema,
  }),
  workflowDefinitionConflictSchema.extend({ id: z.uuid() }),
  workflowDefinitionRefusedSchema.extend({ id: z.uuid() }),
  z.strictObject({
    type: z.literal('workflow-run'),
    id: z.uuid(),
    run: workflowRunSchema,
  }),
  z.strictObject({
    type: z.literal('workflow-runs'),
    id: z.uuid(),
    page: workflowRunPageSchema,
  }),
  z.strictObject({
    type: z.literal('workflow-run-detail'),
    id: z.uuid(),
    detail: workflowRunDetailSchema,
  }),
  z.strictObject({
    type: z.literal('workflow-evidence'),
    id: z.uuid(),
    evidence: workflowEvidenceSchema,
  }),
  z.strictObject({
    type: z.literal('workflow-metrics'),
    id: z.uuid(),
    metrics: workflowMetricsSchema,
  }),
  z.strictObject({
    type: z.literal('workflow-assistant-turn'),
    id: z.uuid(),
    turn: workflowAssistantTurnSchema,
  }),
  z.strictObject({
    type: z.literal('workflow-assistant-undo'),
    id: z.uuid(),
    result: assistantUndoResultSchema,
  }),
  z.strictObject({
    type: z.literal('workflow-assistant-changes'),
    id: z.uuid(),
    history: assistantChangeHistorySchema,
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
  decideStart: (
    hostId: HostId,
    input: DecideScheduledJobStartInput,
  ) => Promise<DesktopScheduledJob>;
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
export type WorkflowMethod = Extract<
  HostRequest['method'],
  `${string}workflow${string}`
>;
export const isWorkflowMethod = (
  method: HostRequest['method'],
): method is WorkflowMethod => method.includes('workflow');
export type WorkflowsApi = {
  listDefinitions: (
    hostId: HostId,
    input: ListWorkflowDefinitionsInput,
  ) => Promise<DefinitionCatalog>;
  validateDefinitions: (
    hostId: HostId,
    input: ValidateWorkflowDefinitionsInput,
  ) => Promise<DefinitionCatalog>;
  startTask: (
    hostId: HostId,
    input: StartWorkflowTaskInput,
  ) => Promise<DesktopWorkflowRun>;
  runSteps: (
    hostId: HostId,
    input: RunWorkflowStepsInput,
  ) => Promise<DesktopWorkflowRun>;
  listRuns: (
    hostId: HostId,
    input: ListWorkflowRunsInput,
  ) => Promise<DesktopWorkflowRunPage>;
  getRun: (hostId: HostId, runId: string) => Promise<DesktopWorkflowRunDetail>;
  decideGate: (
    hostId: HostId,
    input: DecideWorkflowGateInput,
  ) => Promise<DesktopWorkflowRun>;
  skipStep: (
    hostId: HostId,
    input: SkipWorkflowStepInput,
  ) => Promise<DesktopWorkflowRun>;
  resolveStep: (
    hostId: HostId,
    input: ResolveWorkflowStepInput,
  ) => Promise<DesktopWorkflowRun>;
  resumeRun: (hostId: HostId, runId: string) => Promise<DesktopWorkflowRun>;
  stopRun: (hostId: HostId, runId: string) => Promise<DesktopWorkflowRun>;
  saveDefinition: (
    hostId: HostId,
    input: SaveWorkflowDefinitionInput,
  ) => Promise<DefinitionWriteResult>;
  deleteDefinition: (
    hostId: HostId,
    input: DeleteWorkflowDefinitionInput,
  ) => Promise<DefinitionWriteResult>;
  removeWorktree: (
    hostId: HostId,
    runId: string,
  ) => Promise<DesktopWorkflowRun>;
  readEvidence: (
    hostId: HostId,
    input: ReadWorkflowEvidenceInput,
  ) => Promise<WorkflowEvidence>;
  metrics: (
    hostId: HostId,
    input: WorkflowMetricsInput,
  ) => Promise<WorkflowMetrics>;
  assistantSend: (
    hostId: HostId,
    input: WorkflowAssistantSendInput,
  ) => Promise<WorkflowAssistantTurn>;
  assistantUndo: (
    hostId: HostId,
    input: AssistantUndoInput,
  ) => Promise<AssistantUndoResult>;
  assistantChanges: (
    hostId: HostId,
    conversationId: string,
  ) => Promise<AssistantChangeHistory>;
};
export type DesktopApi = {
  scheduledJobs: ScheduledJobsApi;
  workflows: WorkflowsApi;
  colorScheme: () => Promise<ColorScheme>;
  showsOnboardingOnLaunch: () => boolean;
  setColorScheme: (scheme: ColorScheme) => Promise<ColorScheme>;
  onAppliedColorScheme: (
    listener: (scheme: AppliedColorScheme) => void,
  ) => () => void;
  openExternal: (url: string) => Promise<void>;
  openLogs: () => Promise<void>;
  about: () => Promise<AboutInfo>;
  showDataDirectory: () => Promise<void>;
  showBackup: (path: string) => Promise<void>;
  openLicenses: () => Promise<void>;
  saveTextFile: (input: SaveTextFileInput) => Promise<SavedTextFile>;
  transcriptRetention: () => Promise<TranscriptRetention>;
  setTranscriptRetention: (days: number | null) => Promise<TranscriptRetention>;
  purgeTranscripts: () => Promise<TranscriptRetention>;
  deleteLocalData: (confirmation: string) => Promise<void>;
  workLaptopPolicy: () => Promise<WorkLaptopPolicy>;
  setWorkLaptopPolicy: (enabled: boolean) => Promise<WorkLaptopPolicy>;
  backupDatabase: (hostId?: HostId) => Promise<DatabaseBackup>;
  focusWindow: () => Promise<void>;
  requestAttention: () => Promise<void>;
  setAttention: (attention: DesktopAttention) => Promise<void>;
  onOpenSession: (listener: (target: AttentionSession) => void) => () => void;
  keepRunningInBackground: () => Promise<boolean>;
  setKeepRunningInBackground: (enabled: boolean) => Promise<boolean>;
  reportError: (report: RendererErrorReport) => void;
  mobileStatus: () => Promise<MobileGatewayStatus>;
  enableMobile: () => Promise<MobileGatewayStatus>;
  disableMobile: () => Promise<MobileGatewayStatus>;
  pairMobile: () => Promise<MobilePairing>;
  revokeMobile: (deviceId: string) => Promise<MobileGatewayStatus>;
  listProviderProfiles: (hostId?: HostId) => Promise<ProviderProfile[]>;
  createProviderProfile: (
    input: CreateProviderProfileInput,
    hostId?: HostId,
  ) => Promise<ProviderProfile[]>;
  renameProviderProfile: (
    input: RenameProviderProfileInput,
    hostId?: HostId,
  ) => Promise<ProviderProfile[]>;
  removeProviderProfile: (
    input: { profileId: string },
    hostId?: HostId,
  ) => Promise<ProviderProfile[]>;
  providerUsage: (
    input: ProviderUsageInput,
    hostId?: HostId,
  ) => Promise<ProviderUsage>;
  readCosts: (input: ReadCostsInput, hostId?: HostId) => Promise<CostReport>;
  listCostBudgets: (hostId?: HostId) => Promise<CostBudgetList>;
  createCostBudget: (
    input: CreateCostBudgetInput,
    hostId?: HostId,
  ) => Promise<CostBudget>;
  updateCostBudget: (input: CostBudget, hostId?: HostId) => Promise<CostBudget>;
  deleteCostBudget: (
    input: { id: string },
    hostId?: HostId,
  ) => Promise<{ id: string }>;
  listComputers: () => Promise<Computer[]>;
  addComputer: (input: SshComputerInput) => Promise<Computer>;
  connectComputer: (hostId: HostId) => Promise<Computer>;
  disconnectComputer: (hostId: HostId) => Promise<Computer>;
  removeComputer: (hostId: HostId) => Promise<void>;
  health: (hostId?: HostId) => Promise<HostHealth>;
  claudeStatus: (
    hostId?: HostId,
    input?: ProviderProfileSelection,
  ) => Promise<ClaudeStatus>;
  codexStatus: (
    hostId?: HostId,
    input?: ProviderProfileSelection,
  ) => Promise<CodexStatus>;
  listSessions: (hostId?: HostId) => Promise<DesktopSession[]>;
  getSession: (
    input: GetSessionInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  readSessionMessages: (
    input: ReadSessionMessagesInput,
    hostId?: HostId,
  ) => Promise<SessionMessagePage>;
  listReviews: (hostId?: HostId) => Promise<DesktopReview[]>;
  discoverSkills: (
    input: DiscoverSkillsInput,
    hostId?: HostId,
  ) => Promise<SkillCatalog>;
  readGitBranch: (
    input: ReadGitBranchInput,
    hostId?: HostId,
  ) => Promise<GitBranch>;
  searchHistory: (
    input: HistorySearchInput,
    hostId?: HostId,
  ) => Promise<HistorySearchPage>;
  searchTranscripts: (
    input: TranscriptSearchInput,
    hostId?: HostId,
  ) => Promise<TranscriptSearchPage>;
  listConversations: (
    input?: ListConversationsInput,
    hostId?: HostId,
  ) => Promise<ConversationImportCatalog>;
  adoptConversation: (
    input: AdoptConversationInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  trustRepositoryMcp: (
    input: TrustRepositoryMcpInput,
    hostId?: HostId,
  ) => Promise<McpServerList>;
  listMcpServers: (
    input: ListMcpServersInput,
    hostId?: HostId,
  ) => Promise<McpServerList>;
  setSessionMcp: (
    input: SetSessionMcpInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  readSessionWorktree: (
    input: ReadSessionWorktreeInput,
    hostId?: HostId,
  ) => Promise<SessionWorktreeStatus>;
  finishSessionWorktree: (
    input: FinishSessionWorktreeInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  readSessionWorktreeSetup: (
    input: ReadSessionWorktreeInput,
    hostId?: HostId,
  ) => Promise<SessionWorktreeSetup>;
  runSessionWorktreeSetup: (
    input: RunSessionWorktreeSetupInput,
    hostId?: HostId,
  ) => Promise<SessionWorktreeSetupResult>;
  listOrphanedSessionWorktrees: (
    hostId?: HostId,
  ) => Promise<OrphanedSessionWorktrees>;
  removeOrphanedSessionWorktree: (
    input: RemoveOrphanedSessionWorktreeInput,
    hostId?: HostId,
  ) => Promise<OrphanedSessionWorktreeRemoval>;
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
  readSessionChanges: (
    input: ReadSessionChangesInput,
    hostId?: HostId,
  ) => Promise<SessionChanges>;
  readSessionChangePatch: (
    input: ReadSessionChangePatchInput,
    hostId?: HostId,
  ) => Promise<SessionChangePatch>;
  stageAttachment: (
    input: StageAttachmentInput,
    hostId?: HostId,
  ) => Promise<AttachmentUpload>;
  readAttachment: (
    input: ReadAttachmentInput,
    hostId?: HostId,
  ) => Promise<AttachmentContent>;
  openAttachment: (
    input: OpenAttachmentInput,
    hostId?: HostId,
  ) => Promise<void>;
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
  assignSessionWorkflow: (
    input: AssignSessionWorkflowInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  forkSession: (
    input: ForkSessionInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  restartSession: (
    input: RestartSessionInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  compactSession: (
    input: CompactSessionInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  listSessionGroups: (hostId?: HostId) => Promise<SessionGroupList>;
  createSessionGroup: (
    input: CreateSessionGroupInput,
    hostId?: HostId,
  ) => Promise<SessionGroupList>;
  updateSessionGroup: (
    input: UpdateSessionGroupInput,
    hostId?: HostId,
  ) => Promise<SessionGroupList>;
  moveSessionGroup: (
    input: MoveSessionGroupInput,
    hostId?: HostId,
  ) => Promise<SessionGroupList>;
  deleteSessionGroup: (
    input: DeleteSessionGroupInput,
    hostId?: HostId,
  ) => Promise<SessionGroupList>;
  moveSession: (
    input: MoveSessionInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  renameSession: (
    input: RenameSessionInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  openSessionInTerminal: (
    input: OpenSessionTerminalInput,
    hostId?: HostId,
  ) => Promise<OpenedSessionTerminal>;
  setSessionTerminal: (
    input: SetSessionTerminalInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  setSessionPinned: (
    input: SetSessionPinnedInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  setSessionArchived: (
    input: SetSessionArchivedInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  deleteSession: (
    input: DeleteSessionInput,
    hostId?: HostId,
  ) => Promise<DesktopSessionDeletion>;
  restoreSession: (
    input: RestoreSessionInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  listPullRequests: (
    input: ListPullRequestsInput,
    hostId?: HostId,
  ) => Promise<PullRequestList>;
  readPullRequest: (
    input: ReadPullRequestInput,
    hostId?: HostId,
  ) => Promise<PullRequest>;
  readPullRequestFiles: (
    input: ReadPullRequestInput,
    hostId?: HostId,
  ) => Promise<PullRequestFiles>;
  readPullRequestThreads: (
    input: ReadPullRequestInput,
    hostId?: HostId,
  ) => Promise<PullRequestThreads>;
  actOnPullRequest: (
    input: ActOnPullRequestInput,
    hostId?: HostId,
  ) => Promise<PullRequestActionResult>;
  linkSessionPullRequest: (
    input: LinkSessionPullRequestInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  findSessionPullRequest: (
    input: FindSessionPullRequestInput,
    hostId?: HostId,
  ) => Promise<PullRequestReference | null>;
  listTrackedRepositories: (hostId?: HostId) => Promise<TrackedRepository[]>;
  listRunningApps: (hostId?: HostId) => Promise<RunningAppList>;
  readDefaultSessionFolder: (hostId?: HostId) => Promise<DefaultSessionFolder>;
  setDefaultSessionFolder: (
    directory: string | null,
    hostId?: HostId,
  ) => Promise<DefaultSessionFolder>;
  listWorktreeRecipes: (hostId?: HostId) => Promise<WorktreeRecipe[]>;
  saveWorktreeRecipe: (
    input: SaveWorktreeRecipeInput,
    hostId?: HostId,
  ) => Promise<WorktreeRecipe[]>;
  deleteWorktreeRecipe: (
    input: DeleteWorktreeRecipeInput,
    hostId?: HostId,
  ) => Promise<WorktreeRecipe[]>;
  matchWorktreeRecipe: (
    input: MatchWorktreeRecipeInput,
    hostId?: HostId,
  ) => Promise<WorktreeRecipeMatch>;
  startWorktreeRecipeTrial: (
    input: StartWorktreeRecipeTrialInput,
    hostId?: HostId,
  ) => Promise<WorktreeRecipeRun | null>;
  readWorktreeRecipeTrial: (
    input: WorktreeRecipeTrialRefInput,
    hostId?: HostId,
  ) => Promise<WorktreeRecipeRun | null>;
  stopWorktreeRecipeTrial: (
    input: WorktreeRecipeTrialRefInput,
    hostId?: HostId,
  ) => Promise<WorktreeRecipeRun | null>;
  readSessionWorktreeRecipe: (
    input: ReadSessionWorktreeRecipeInput,
    hostId?: HostId,
  ) => Promise<WorktreeRecipeRun | null>;
  decideSessionWorktreeRecipe: (
    input: DecideSessionWorktreeRecipeInput,
    hostId?: HostId,
  ) => Promise<WorktreeRecipeRun | null>;
  addTrackedRepository: (
    input: AddTrackedRepositoryInput,
    hostId?: HostId,
  ) => Promise<TrackedRepository[]>;
  removeTrackedRepository: (
    input: RemoveTrackedRepositoryInput,
    hostId?: HostId,
  ) => Promise<TrackedRepository[]>;
  reorderTrackedRepositories: (
    input: ReorderTrackedRepositoriesInput,
    hostId?: HostId,
  ) => Promise<TrackedRepository[]>;
  suggestTrackedRepositories: (
    hostId?: HostId,
  ) => Promise<TrackedRepositorySuggestion[]>;
  listTrackedPullRequests: (
    input: ListTrackedPullRequestsInput,
    hostId?: HostId,
  ) => Promise<TrackedPullRequestList[]>;
  readCodeReviewSettings: (hostId?: HostId) => Promise<CodeReviewSettings>;
  saveReviewerProfile: (
    input: SaveReviewerProfileInput,
    hostId?: HostId,
  ) => Promise<CodeReviewSettings>;
  deleteReviewerProfile: (
    input: DeleteReviewerProfileInput,
    hostId?: HostId,
  ) => Promise<CodeReviewSettings>;
  saveReviewConvention: (
    input: SaveReviewConventionInput,
    hostId?: HostId,
  ) => Promise<CodeReviewSettings>;
  deleteReviewConvention: (
    input: DeleteReviewConventionInput,
    hostId?: HostId,
  ) => Promise<CodeReviewSettings>;
  startPullRequestReview: (
    input: StartPullRequestReviewInput,
    hostId?: HostId,
  ) => Promise<DesktopReviewDraft>;
  listPullRequestReviews: (
    input: ListPullRequestReviewsInput,
    hostId?: HostId,
  ) => Promise<DesktopReviewDraft[]>;
  updateReviewFinding: (
    input: UpdateReviewFindingInput,
    hostId?: HostId,
  ) => Promise<DesktopReviewDraft>;
  discardPullRequestReview: (
    input: DiscardPullRequestReviewInput,
    hostId?: HostId,
  ) => Promise<DesktopReviewDraft>;
  publishPullRequestReview: (
    input: PublishPullRequestReviewInput,
    hostId?: HostId,
  ) => Promise<DesktopReviewPublishResult>;
  queueMessage: (
    input: SendMessageInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  cancelQueued: (
    input: QueuedMessageRefInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  startQueued: (
    input: QueuedMessageRefInput,
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
  decideWorkerPlan: (
    input: DecideWorkerPlanInput,
    hostId?: HostId,
  ) => Promise<DesktopSession>;
  subscribe: (listener: (event: WorkspaceEvent) => void) => () => void;
};
