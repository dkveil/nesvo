import { z } from 'zod';
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
  type Session,
  type StopRunInput,
  type RespondApprovalInput,
  type DecideDelegationInput,
} from './sessions';
import {
  reviewSchema,
  decideReviewSchema,
  type Review,
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

export * from './sessions';
export * from './activities';
export * from './reviews';
export * from './workspace';

export const desktopEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('session-changed'),
    session: sessionSchema,
  }),
  z.strictObject({ type: z.literal('review-changed'), review: reviewSchema }),
  z.strictObject({ type: z.literal('host-disconnected') }),
]);
export type DesktopEvent = z.infer<typeof desktopEventSchema>;

export const hostRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ id: z.uuid(), method: z.literal('health') }),
  z.strictObject({ id: z.uuid(), method: z.literal('shutdown') }),
  z.strictObject({ id: z.uuid(), method: z.literal('claude-status') }),
  z.strictObject({ id: z.uuid(), method: z.literal('codex-status') }),
  z.strictObject({ id: z.uuid(), method: z.literal('list-sessions') }),
  z.strictObject({ id: z.uuid(), method: z.literal('list-reviews') }),
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
]);

export const hostHealthSchema = z.strictObject({
  status: z.literal('ready'),
  instanceId: z.uuid(),
  protocolVersion: z.literal(1),
});

export const hostResponseSchema = z.discriminatedUnion('type', [
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
export type DesktopApi = {
  health: () => Promise<HostHealth>;
  claudeStatus: () => Promise<ClaudeStatus>;
  codexStatus: () => Promise<CodexStatus>;
  listSessions: () => Promise<Session[]>;
  listReviews: () => Promise<Review[]>;
  listWorkspaceDirectory: (
    input: ListWorkspaceDirectoryInput,
  ) => Promise<WorkspaceDirectory>;
  searchWorkspaceFiles: (
    input: SearchWorkspaceFilesInput,
  ) => Promise<WorkspaceSearch>;
  readWorkspaceFile: (input: ReadWorkspaceFileInput) => Promise<WorkspaceFile>;
  decideReview: (input: DecideReviewInput) => Promise<Review>;
  createSession: (input: CreateSessionInput) => Promise<Session>;
  sendMessage: (input: SendMessageInput) => Promise<Session>;
  stopRun: (input: StopRunInput) => Promise<Session>;
  respondApproval: (input: RespondApprovalInput) => Promise<Session>;
  decideDelegation: (input: DecideDelegationInput) => Promise<Session>;
  subscribe: (listener: (event: DesktopEvent) => void) => () => void;
};
