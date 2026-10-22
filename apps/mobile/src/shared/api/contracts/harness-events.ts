export type HarnessEventRecord = {
  at: number;
  sequence: number;
  sessionId: string | null;
  [k: string]: unknown | undefined;
} & (
  | {
      kind: 'host.started';
      payload: HostStarted;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'host.budget_changed';
      payload: RevisionChanged;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'provider.quota_changed';
      payload: RevisionChanged;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'session.created';
      payload: SessionCreated;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'session.closed';
      payload: SessionClosed;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'session.hibernated';
      payload: SessionHibernated;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'session.resumed';
      payload: SessionResumed;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'process.exited';
      payload: ProcessExited;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'response.settled';
      payload: ResponseSettled;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'agent.lifecycle';
      payload: AgentLifecycle;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'agent.attention';
      payload: AgentAttention;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'operation.changed';
      payload: OperationChanged;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'job.changed';
      payload: JobChanged;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'precheck.approval.changed';
      payload: PrecheckApprovalChanged;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'job.trigger_changed';
      payload: JobTriggerChanged;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'job.trigger_delivery';
      payload: JobTriggerDelivery;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.created';
      payload: RunRevision;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.plan_changed';
      payload: RunRevision;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.activated';
      payload: RunRevision;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.attempt_assigned';
      payload: RunRevision;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.result_reported';
      payload: RunRevision;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.result_validated';
      payload: RunRevision;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.draining';
      payload: RunRevision;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.resumed';
      payload: RunRevision;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.checkpoint_saved';
      payload: RunCheckpointSaved;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.constraints_added';
      payload: RunConstraints;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.constraints_acknowledged';
      payload: RunConstraints;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.control_requested';
      payload: RunControl;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.control_progress';
      payload: RunControl;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.control_completed';
      payload: RunControl;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.control_unconfirmed';
      payload: RunControl;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.coordinator_rebound';
      payload: RunCoordinatorRebound;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.decision_asked';
      payload: RunDecision;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.decision_answered';
      payload: RunDecision;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.decision_canceled';
      payload: RunDecision;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.decisions_expired';
      payload: RunCount;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.delivery_changed';
      payload: RunDelivery;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.digest_recorded';
      payload: RunDigestRecorded;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.executor_changed';
      payload: RunExecutor;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.message_sent';
      payload: RunMessage;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.messages_acknowledged';
      payload: RunCount;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.launch_reserved';
      payload: RunAttempt;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.launch_recovered';
      payload: RunAttempt;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.launch_observed';
      payload: RunAttempt;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.workspace_prepared';
      payload: RunAttempt;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.quota_hold_changed';
      payload: RunAttempt;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.session_reused';
      payload: RunSessionReused;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.time_budget_exhausted';
      payload: RunChanged;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.budget_changed';
      payload: RunChanged;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'run.wake_changed';
      payload: RunWake;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'workflow.templates_approved';
      payload: RepositoryDigest;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'workflow.templates_revoked';
      payload: RepositoryDigest;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'worktree.setup_approved';
      payload: RepositoryDigest;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'worktree.setup_revoked';
      payload: RepositoryDigest;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'worktree.prepared';
      payload: WorktreePrepared;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'worktree.ran';
      payload: WorktreeRan;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'worktree.archived';
      payload: WorktreeArchived;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'mcp.pool_attached';
      payload: McpPoolAttached;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'mcp.pool_released';
      payload: McpPoolReleased;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'mcp.pool_reaped';
      payload: McpPoolReaped;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'mcp.server_attached';
      payload: McpServerAttached;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'mcp.server_released';
      payload: McpServerReleased;
      [k: string]: unknown | undefined;
    }
  | {
      kind: 'mcp.server_reaped';
      payload: McpServerReaped;
      [k: string]: unknown | undefined;
    }
);
export type AgentState =
  'working' | 'idle' | 'done' | 'blocked' | 'question' | 'failed' | 'unknown';
export type HibernationTrigger = 'owner' | 'idlePolicy';
export type Program = 'shell' | 'claude' | 'gemini' | 'codex';
export type SessionClosed = Record<string, never>;

export type AgentAttention = {
  blockedChildren: number;
  exitCode: number | null;
  priority: number;
  processExited: boolean;
  reason: string | null;
};
export type AgentLifecycle = {
  event: string;
  generation: number;
  sourceSequence: number;
  state: AgentState;
  submissionEvidence: boolean;
};
export type HostStarted = {
  buildId: string;
};
export type JobChanged = {
  jobId: string;
  occurrenceId: string | null;
  phase: string;
};
export type JobTriggerChanged = {
  phase: string;
  triggerId: string;
};
export type JobTriggerDelivery = {
  deliveryId: string;
  disposition: string;
  triggerId: string;
};
export type McpPoolAttached = {
  digest: string;
  entryId: string;
  program: Program;
  root: string;
  server: string;
};
export type McpPoolReaped = {
  digest: string;
  entryId: string;
  reason: string;
  server: string;
};
export type McpPoolReleased = {
  entryId: string;
  reason: string;
  server: string;
};
export type McpServerAttached = {
  digest: string;
  entryId: string | null;
  mode: string;
  reason: string | null;
  repository: string;
  root: string;
  server: string;
};
export type McpServerReaped = {
  digest: string;
  entryId: string;
  reason: string;
  repository: string;
  server: string;
};
export type McpServerReleased = {
  reason: string;
  repository: string;
  server: string;
};
export type OperationChanged = {
  operation: string;
  operationId: string;
  phase: string;
};
export type PrecheckApprovalChanged = {
  approvalId: string;
  phase: string;
};
export type ProcessExited = {
  exitCode: number | null;
};
export type RepositoryDigest = {
  digest: string;
  repository: string;
};
export type ResponseSettled = {
  taskResult: null;
  turnId: string;
};
export type RevisionChanged = {
  revision: number;
};
export type RunAttempt = {
  attemptId: string;
  runId: string;
};
export type RunChanged = {
  runId: string;
};
export type RunCheckpointSaved = {
  checkpointId: string;
  runId: string;
  sourceRunRevision: number;
};
export type RunConstraints = {
  constraintRevision: number;
  runId: string;
};
export type RunControl = {
  controlId: string;
  runId: string;
};
export type RunCoordinatorRebound = {
  generation: number;
  previousSessionId: string | null;
  runId: string;
  sessionId: string;
};
export type RunCount = {
  count: number;
  runId: string;
};
export type RunDecision = {
  decisionId: string;
  runId: string;
  state: string;
};
export type RunDelivery = {
  deliveryId: string;
  runId: string;
};
export type RunDigestRecorded = {
  bytes: number;
  fingerprint: string;
  revision: number;
  runId: string;
  state: string;
};
export type RunExecutor = {
  executorId: string;
  runId: string;
};
export type RunMessage = {
  messageId: string;
  runId: string;
};
export type RunRevision = {
  revision: number;
  runId: string;
};
export type RunSessionReused = {
  attemptId: string;
  previousAttemptId: string;
  runId: string;
  sessionId: string;
  taskId: string;
};
export type RunWake = {
  policyId: string;
  runId: string;
};
export type SessionCreated = {
  parentSessionId?: string | null;
  program: Program;
};
export type SessionHibernated = {
  conversationId: string;
  program: Program;
  trigger: HibernationTrigger;
};
export type SessionResumed = {
  conversationId: string;
  program: Program;
};
export type WorktreeArchived = {
  blockers: string[];
  branch: string | null;
  branchDeleted: boolean;
  discarded: boolean;
  sessionId: string;
  worktree: string;
};
export type WorktreePrepared = {
  digest: string;
  log: string;
  result: string;
  sessionId: string;
  worktree: string;
};
export type WorktreeRan = {
  log: string;
  result: string;
  sessionId: string;
};
