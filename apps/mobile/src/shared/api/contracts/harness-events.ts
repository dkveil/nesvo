export type HarnessEventRecord = {
  at: number;
  sequence: number;
  sessionId: string | null;
} & (
  | {
      kind: 'host.started';
      payload: HostStarted;
    }
  | {
      kind: 'host.budget_changed';
      payload: RevisionChanged;
    }
  | {
      kind: 'provider.quota_changed';
      payload: RevisionChanged;
    }
  | {
      kind: 'session.created';
      payload: SessionCreated;
    }
  | {
      kind: 'session.closed';
      payload: SessionClosed;
    }
  | {
      kind: 'session.hibernated';
      payload: SessionHibernated;
    }
  | {
      kind: 'session.resumed';
      payload: SessionResumed;
    }
  | {
      kind: 'process.exited';
      payload: ProcessExited;
    }
  | {
      kind: 'response.settled';
      payload: ResponseSettled;
    }
  | {
      kind: 'agent.lifecycle';
      payload: AgentLifecycle;
    }
  | {
      kind: 'agent.attention';
      payload: AgentAttention;
    }
  | {
      kind: 'operation.changed';
      payload: OperationChanged;
    }
  | {
      kind: 'job.changed';
      payload: JobChanged;
    }
  | {
      kind: 'precheck.approval.changed';
      payload: PrecheckApprovalChanged;
    }
  | {
      kind: 'job.trigger_changed';
      payload: JobTriggerChanged;
    }
  | {
      kind: 'job.trigger_delivery';
      payload: JobTriggerDelivery;
    }
  | {
      kind: 'run.created';
      payload: RunRevision;
    }
  | {
      kind: 'run.plan_changed';
      payload: RunRevision;
    }
  | {
      kind: 'run.activated';
      payload: RunRevision;
    }
  | {
      kind: 'run.attempt_assigned';
      payload: RunRevision;
    }
  | {
      kind: 'run.result_reported';
      payload: RunRevision;
    }
  | {
      kind: 'run.result_validated';
      payload: RunRevision;
    }
  | {
      kind: 'run.draining';
      payload: RunRevision;
    }
  | {
      kind: 'run.resumed';
      payload: RunRevision;
    }
  | {
      kind: 'run.checkpoint_saved';
      payload: RunCheckpointSaved;
    }
  | {
      kind: 'run.constraints_added';
      payload: RunConstraints;
    }
  | {
      kind: 'run.constraints_acknowledged';
      payload: RunConstraints;
    }
  | {
      kind: 'run.control_requested';
      payload: RunControl;
    }
  | {
      kind: 'run.control_progress';
      payload: RunControl;
    }
  | {
      kind: 'run.control_completed';
      payload: RunControl;
    }
  | {
      kind: 'run.control_unconfirmed';
      payload: RunControl;
    }
  | {
      kind: 'run.coordinator_rebound';
      payload: RunCoordinatorRebound;
    }
  | {
      kind: 'run.decision_asked';
      payload: RunDecision;
    }
  | {
      kind: 'run.decision_answered';
      payload: RunDecision;
    }
  | {
      kind: 'run.decision_canceled';
      payload: RunDecision;
    }
  | {
      kind: 'run.decisions_expired';
      payload: RunCount;
    }
  | {
      kind: 'run.delivery_changed';
      payload: RunDelivery;
    }
  | {
      kind: 'run.digest_recorded';
      payload: RunDigestRecorded;
    }
  | {
      kind: 'run.executor_changed';
      payload: RunExecutor;
    }
  | {
      kind: 'run.message_sent';
      payload: RunMessage;
    }
  | {
      kind: 'run.messages_acknowledged';
      payload: RunCount;
    }
  | {
      kind: 'run.launch_reserved';
      payload: RunAttempt;
    }
  | {
      kind: 'run.launch_recovered';
      payload: RunAttempt;
    }
  | {
      kind: 'run.launch_observed';
      payload: RunAttempt;
    }
  | {
      kind: 'run.workspace_prepared';
      payload: RunAttempt;
    }
  | {
      kind: 'run.quota_hold_changed';
      payload: RunAttempt;
    }
  | {
      kind: 'run.session_reused';
      payload: RunSessionReused;
    }
  | {
      kind: 'run.time_budget_exhausted';
      payload: RunChanged;
    }
  | {
      kind: 'run.budget_changed';
      payload: RunChanged;
    }
  | {
      kind: 'run.wake_changed';
      payload: RunWake;
    }
  | {
      kind: 'workflow.templates_approved';
      payload: RepositoryDigest;
    }
  | {
      kind: 'workflow.templates_revoked';
      payload: RepositoryDigest;
    }
  | {
      kind: 'worktree.setup_approved';
      payload: RepositoryDigest;
    }
  | {
      kind: 'worktree.setup_revoked';
      payload: RepositoryDigest;
    }
  | {
      kind: 'worktree.prepared';
      payload: WorktreePrepared;
    }
  | {
      kind: 'worktree.ran';
      payload: WorktreeRan;
    }
  | {
      kind: 'worktree.archived';
      payload: WorktreeArchived;
    }
  | {
      kind: 'mcp.pool_attached';
      payload: McpPoolAttached;
    }
  | {
      kind: 'mcp.pool_released';
      payload: McpPoolReleased;
    }
  | {
      kind: 'mcp.pool_reaped';
      payload: McpPoolReaped;
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
