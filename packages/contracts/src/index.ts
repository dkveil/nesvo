import { z } from 'zod';
import type { MobileGatewayStatus, MobilePairing } from './mobile';
import {
  providerUsageInputSchema,
  providerUsageSchema,
  type ProviderUsageInput,
  type ProviderUsage,
} from './provider-usage';
import {
  type Computer,
  type DesktopReview,
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
} from './scheduled-jobs';
import {
  discoverSkillsSchema,
  skillCatalogSchema,
  type DiscoverSkillsInput,
  type SkillCatalog,
} from './skills';

export * from './sessions';
export * from './activities';
export * from './reviews';
export * from './workspace';
export * from './skills';
export * from './computers';
export * from './provider-usage';
export * from './mobile';
export * from './scheduled-jobs';

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
]);

export const hostCapabilitySchema = z.enum(['scheduled-jobs']);

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
export type HostCapability = z.infer<typeof hostCapabilitySchema>;
export type HostResponse = z.infer<typeof hostResponseSchema>;
export const hostMessageSchema = z.union([
  hostResponseSchema,
  desktopEventSchema,
]);
export type HostMessage = z.infer<typeof hostMessageSchema>;
export type DesktopApi = {
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
