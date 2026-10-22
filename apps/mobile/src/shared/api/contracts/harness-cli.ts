export type HarnessCliEnvelope =
  | {
      error: {
        code: string;
        exitCode?: 1 | 2 | 3 | 4 | 5;
        message: string;
        receipt?: Receipt;
        retryable: boolean;
      };
      ok: false;
      schemaVersion: 1;
    }
  | {
      data:
        | ((
            | WorkflowRecoveryContext
            | ((
                | {
                    constraints: WorkflowConstraintPolicy;
                    hasMore: boolean;
                    nextCursor: number;
                    records: WorkflowConstraint[];
                    run: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                    };
                  }
                | {
                    checkpoints: WorkflowCheckpoint[];
                    nextOffset: number | null;
                    run: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                    };
                  }
                | {
                    checkpoint: null | WorkflowCheckpoint;
                    context: WorkflowContextMetadata;
                    currentConstraints: WorkflowConstraintPolicy;
                    nextOffset: number | null;
                    parts: WorkflowContextPart[];
                    run: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                    };
                  }
                | {
                    batches: WorkflowWakeBatchSummary[];
                    deliveredThrough: Cursor;
                    more: boolean;
                    nextCursor: Cursor;
                    notices: WorkflowWakeNotice[];
                    pendingCount: number;
                    run: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                    };
                    wakePolicy: null | WorkflowWakePolicy;
                  }
                | {
                    run: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                    };
                    wakeBatch: WorkflowWakeBatch;
                  }
                | {
                    executor: null | WorkflowExecutor;
                    run: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                    };
                  }
                | {
                    nextOffset: number | null;
                    run?: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                    };
                    runs: {
                      id: unknown;
                      revision: unknown;
                      state: unknown;
                      title: unknown;
                    }[];
                  }
                | {
                    digest: WorkflowDigest;
                    fingerprint: string;
                    run: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                      id: unknown;
                      revision: unknown;
                      state: unknown;
                      title: unknown;
                    };
                    stored: boolean;
                  }
                | {
                    delivery?: WorkflowDelivery;
                    launch?: WorkflowLaunch;
                    run: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                      goal: string;
                      id: string;
                      revision: number;
                      state:
                        | 'draft'
                        | 'active'
                        | 'draining'
                        | 'drained'
                        | 'stopping'
                        | 'stopped'
                        | 'canceling'
                        | 'canceled'
                        | 'succeeded';
                      taskResult: 'succeeded' | null;
                      title: string;
                    };
                    tasks: {
                      attempts: number;
                      dependencies: string[];
                      dependencyState: 'ready' | 'waiting';
                      id: string;
                      instruction: unknown;
                      key: string;
                      state:
                        | 'planned'
                        | 'launching'
                        | 'launchFailed'
                        | 'launchUnknown'
                        | 'assigned'
                        | 'reported'
                        | 'succeeded'
                        | 'failed'
                        | 'stopped';
                      taskResult: 'succeeded' | 'failed' | null;
                      title: unknown;
                    }[];
                  }
                | {
                    attempt: {
                      id: unknown;
                    };
                    constraints?: {
                      policy: WorkflowConstraintPolicy;
                      records: WorkflowConstraint[];
                    };
                    decision: WorkflowDecision;
                    run: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                      id: unknown;
                      revision: unknown;
                      state: unknown;
                      title: unknown;
                    };
                    task: {
                      id: unknown;
                    };
                  }
                | {
                    attempt: WorkflowAttempt;
                    constraints?: {
                      policy: WorkflowConstraintPolicy;
                      records: WorkflowConstraint[];
                    };
                    run: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                      id: unknown;
                      revision: unknown;
                      state: unknown;
                      title: unknown;
                    };
                    task: {
                      id: unknown;
                      instruction: unknown;
                      key: unknown;
                      title: unknown;
                    };
                  }
                | {
                    attempts: WorkflowAttempt[];
                    nextOffset: number | null;
                    run: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                      id: unknown;
                      revision: unknown;
                      state: unknown;
                    };
                    task: {
                      id: unknown;
                      spec: unknown;
                    };
                  }
                | {
                    decisions: WorkflowDecision[];
                    nextOffset: number | null;
                    run: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                      id: unknown;
                      revision: unknown;
                      state: unknown;
                      title: unknown;
                    };
                  }
                | {
                    control: {
                      counts: {
                        [k: string]: number | undefined;
                      };
                      createdAt: Timestamp;
                      id: Id;
                      kind: 'stop' | 'cancel';
                      state:
                        'dispatching' | 'awaitingExit' | 'blocked' | 'unconfirmed' | 'completed';
                    };
                    nextOffset: number | null;
                    run: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                      id: unknown;
                      revision: unknown;
                      state: unknown;
                    };
                    targets: {
                      attemptId: Id;
                      code: string | null;
                      operationKey: string;
                      phase:
                        | 'pending'
                        | 'dispatching'
                        | 'stopRequested'
                        | 'blocked'
                        | 'unknown'
                        | 'unavailable'
                        | 'exited';
                      receiptId: string | null;
                      sessionId: Id;
                    }[];
                  }
                | {
                    policy: RunBudget;
                    run: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                      id: unknown;
                      revision: unknown;
                      state: unknown;
                    };
                  }
                | {
                    budget: {
                      limits: {
                        maxSessions: number;
                        maxWorkers: number;
                        providers: {
                          claude: number;
                          codex: number;
                          gemini: number;
                          shell: number;
                        };
                      };
                      revision: number;
                    };
                    run?: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                    };
                  }
                | ((
                    | {
                        headCursor: Cursor;
                        messages: WorkflowMessage[];
                        more: boolean;
                        nextCursor: Cursor;
                        pendingCount: number;
                      }
                    | {
                        message: WorkflowMessage;
                      }
                    | {
                        acknowledged: {
                          ackedAt: Timestamp;
                          ackedBy: {
                            role: unknown;
                          };
                          id: string;
                        }[];
                      }
                  ) & {
                    mailbox: {
                      recipientAttemptId: string | null;
                      runId: string;
                    };
                    run: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                      id: unknown;
                      revision: unknown;
                      state: unknown;
                      title: unknown;
                    };
                  })
                | {
                    delivery: JobTriggerDelivery;
                  }
                | {
                    run?: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                    };
                    trigger: JobTrigger;
                  }
                | {
                    nextOffset: number | null;
                    run?: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                    };
                    triggers: JobTrigger[];
                  }
                | {
                    deliveries: JobTriggerDelivery[];
                    nextOffset: number | null;
                    run?: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                    };
                  }
                | ({
                    [k: string]: unknown | undefined;
                  } & {
                    nextOffset?: number | null;
                    precheckApproval?: PrecheckApproval;
                    precheckApprovals?: PrecheckApproval[];
                    precheckDescription?: {
                      digest: string;
                      environmentPolicy: 'isolated-platform-v1';
                      platformEnvironmentKeys: 'SystemRoot'[];
                      sandboxed: false;
                      spec: {
                        [k: string]: unknown | undefined;
                      };
                      trust: 'notApproved';
                    };
                    run?: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                    };
                  })
                | ({
                    [k: string]: unknown | undefined;
                  } & {
                    job?: JobDefinition;
                    jobAttempt?: JobAttemptDetail;
                    jobAttempts?: JobAttemptSummary[];
                    jobs?: JobDefinition[];
                    nextOffset?: number | null;
                    occurrence?: JobOccurrence;
                    occurrences?: JobOccurrence[];
                    run?: {
                      coordinatorBinding?: null | WorkflowCoordinatorBinding;
                    };
                  })
              ) & {
                cursor?: Cursor;
                nativeEffectsRestored?: false;
                signal?: {
                  kind: 'blocked' | 'question';
                  options: string[];
                };
                workerAuthorityRestored?: false;
              })
          ) & {
            type: 'workflow';
          })
        | {
            gate?: ProviderQuotaGate;
            providers: ProviderQuotaObservation[];
            refresh: {
              program: 'claude' | 'codex' | 'gemini';
              readerId?: string;
              retryAfterMs: Cursor;
              revision: Cursor;
              state: 'queued' | 'pending' | 'cooldown';
            } | null;
            type: 'providerQuota';
          }
        | {
            quotaWake: null | QuotaWake;
            sessionId: Id;
            type: 'quotaWake';
          }
        | {
            quotaWake: null | QuotaWake;
            sessionId: Id;
            type: 'wakeConfigured';
            wakeAt: number | null;
          }
        | {
            cursor?: Cursor;
            receipt: Receipt;
            type: 'operation';
            wait?: {
              outcome: 'reached' | 'timeout' | 'failed' | 'unknown' | 'interrupted' | 'settled';
              reached: boolean;
              until: 'delivered' | 'received' | 'started' | 'settled';
            };
          }
        | {
            events: {
              at: Cursor;
              kind: string;
              payload: {
                [k: string]: unknown | undefined;
              };
              sequence: number;
              sessionId: string | null;
            }[];
            floorCursor: Cursor;
            gap: boolean;
            headCursor: Cursor;
            health: {
              observationDrops: Cursor;
              writeFailures: Cursor;
            };
            more: boolean;
            nextCursor: Cursor;
            type: 'events';
          }
        | {
            session: Session;
            type: 'session';
          }
        | {
            groups: unknown[];
            revision: Cursor;
            sessions: Session[];
            type: 'sessions';
          }
        | {
            providers: {
              claude?: ProviderAvailability;
              codex?: ProviderAvailability;
              gemini?: ProviderAvailability;
            };
            type: 'providers';
          }
        | {
            cols: number;
            page: Page;
            rows: number;
            sessionId: Id;
            type: 'sessionRead';
          }
        | ({
            [k: string]: unknown | undefined;
          } & {
            review: {
              base?: {
                mergeBase: string;
                oid: string;
                ref: string;
              };
              directory: string;
              files: unknown[];
              head?: string | null;
              range?: {
                from: string;
                to: string;
              };
              revision?: string;
              scope: 'staged' | 'unstaged' | 'untracked' | 'branch' | 'commits';
              truncated: boolean;
            };
            reviewId?: Id;
            sessionId?: null | Id;
            type: 'diff';
          })
        | {
            base: {
              mergeBase: string;
              oid: string;
              ref: string;
            } | null;
            checks?: {
              failed: number;
              headOid: string;
              passed: number;
              pending: number;
              total: number;
            } | null;
            directory: string;
            head: {
              oid: string | null;
              ref: string | null;
            };
            reviewId: Id;
            revision: string;
            scope: 'branch' | 'unstaged';
            source: {
              baseRef?: string;
              context?: string;
              headOid?: string;
              headRef?: string;
              kind: 'local' | 'pull';
              number?: number;
              owner?: string;
              repo?: string;
              sessionId?: string | null;
              state?: string;
              title?: string;
              url?: string;
            };
            type: 'reviewOpened';
          }
        | {
            bytes: number;
            key?: string | null;
            path: 'operation' | 'paste';
            receipt: Receipt | PasteReceipt;
            reviewId: Id;
            sessionId: Id;
            type: 'reviewDelivered';
          }
        | {
            nextOffset: null | Cursor;
            records: RecoveryRecord[];
            type: 'recovery';
          }
        | {
            resume?: ResumeVerification;
            sessionId: Id;
            type: 'created';
          }
        | {
            hibernation?: SessionHibernation;
            replayed: boolean;
            resume?: ResumeVerification;
            sessionId: Id;
            state: 'hibernated' | 'resumed';
            type: 'sessionHibernation';
          }
        | {
            approved: boolean;
            config: {
              envFiles: string[];
              run: string[];
              setup: string[];
              timeoutS: number;
            } | null;
            configured: boolean;
            digest: string | null;
            policy: {
              logLimit: 65536;
              shell: 'platform-shell-v1';
              source: 'HEAD:nesvo.toml';
              version: 1;
            };
            repository: string;
            type: 'worktreeSetup';
          }
        | {
            approvedAt: number;
            digest: string;
            repository: string;
            type: 'worktreeSetupApproved';
          }
        | {
            digest: string;
            repository: string;
            revoked: boolean;
            type: 'worktreeSetupRevoked';
          }
        | {
            log: string;
            sessionId: Id;
            type: 'worktreeRunStarted';
            worktree: string;
          }
        | {
            cancelled: boolean;
            sessionId: Id;
            type: 'worktreeCancelled';
          }
        | {
            blockers: ('conflicts' | 'dirty' | 'unpushed' | 'unborn')[];
            branch: string | null;
            branchDeleted: boolean;
            discarded: boolean;
            sessionId: Id;
            type: 'worktreeArchived';
            worktree: string;
          }
        | {
            type: 'worktreeRegistry';
            worktrees: {
              active: boolean;
              archivedAt: number | null;
              branch: string | null;
              createdAt: number;
              digest: string | null;
              discarded: boolean;
              envFiles: {
                path: string;
                sha256: string;
              }[];
              present: boolean;
              repository: string;
              run: {
                finishedAt: number | null;
                log: string | null;
                startedAt: number;
                state:
                  | 'notConfigured'
                  | 'running'
                  | 'passed'
                  | 'failed'
                  | 'timedOut'
                  | 'cancelled'
                  | 'interrupted';
              } | null;
              sessionId: Id;
              sessionLive: boolean;
              setup: {
                finishedAt: number | null;
                log: string | null;
                startedAt: number;
                state:
                  | 'notConfigured'
                  | 'running'
                  | 'passed'
                  | 'failed'
                  | 'timedOut'
                  | 'cancelled'
                  | 'interrupted';
              };
              worktree: string;
            }[];
          }
        | {
            items: AttentionItem[];
            limit: number;
            nextPage: number | null;
            page: number;
            total: Cursor;
            type: 'attentionInbox';
          }
        | {
            acknowledged: AttentionReceipt[];
            type: 'inboxAcknowledged';
          }
        | {
            decisions: {
              answer: string | null;
              askedBy: {
                [k: string]: unknown | undefined;
              };
              attemptId: string;
              audience: 'owner' | 'coordinator';
              createdAt: Timestamp;
              expiresAt: Timestamp;
              id: string;
              inboxId: string;
              question: string;
              reason: string | null;
              resolvedAt: number | null;
              resolvedBy: {
                [k: string]: unknown | undefined;
              } | null;
              revision: number;
              run: {
                id: Id;
                state: string;
                title: string;
              };
              runId: string;
              state: 'pending' | 'answered' | 'canceled' | 'expired';
              taskId: string;
            }[];
            nextPage: number | null;
            page: number;
            total: Cursor;
            type: 'decisions';
          }
        | {
            attempt?: {
              [k: string]: unknown | undefined;
            };
            cursor: Cursor;
            decision: WorkflowDecision & {
              state?: 'answered';
            };
            inboxId: string;
            run: {
              [k: string]: unknown | undefined;
            };
            task?: {
              [k: string]: unknown | undefined;
            };
            type: 'decided';
          }
        | {
            limit: number;
            projects: Project[];
            type: 'projects';
          }
        | {
            pinned: boolean;
            root: string;
            type: 'projectPinned';
          }
        | {
            defaultLayout: string | null;
            root: string;
            type: 'projectLayout';
          }
        | {
            defaultLayout: string | null;
            folders: {
              folder: string;
              lastLaunchAt: Timestamp;
              launches: number;
            }[];
            launchFolder: string;
            name: string;
            root: string;
            type: 'projectDefaults';
            worktreeSetup: {
              approved?: boolean;
              available: boolean;
              configured?: boolean;
              digest?: string | null;
              error?: {
                code: string;
                message: string;
              };
              openWorktrees?: number;
            };
          }
        | {
            approved: boolean;
            configured: boolean;
            digest: string | null;
            repository: string;
            source: 'HEAD:nesvo.toml';
            templates: WorkflowTemplate[];
            type: 'workflowTemplates';
          }
        | {
            approvedAt: Timestamp;
            digest: string;
            repository: string;
            type: 'workflowTemplatesApproved';
          }
        | {
            digest: string;
            repository: string;
            revoked: boolean;
            type: 'workflowTemplatesRevoked';
          }
        | {
            digest: string;
            executor: null | WorkflowExecutor;
            key: string;
            profiles: {
              profile: {
                program: unknown;
                workspace: unknown;
              };
              taskId: Id;
            }[];
            run: {
              id: unknown;
              revision: unknown;
              state: unknown;
              title: unknown;
            };
            start: 'draft' | 'active' | 'executor';
            tasks: {
              id: unknown;
              key: unknown;
              state: unknown;
            }[];
            template: string;
            type: 'workflowTemplateStarted';
          }
        | {
            available: boolean;
            bounds: {
              connectMs: number;
              idleMs: number;
              processes: number;
              sessions: number;
              warmPerKey: number;
            };
            entries: {
              ageMs: number;
              digest: string;
              entryId: string;
              program: 'shell' | 'claude' | 'codex' | 'gemini';
              root: string;
              server: string;
              sessionId: string | null;
              state: 'warm' | 'leased';
            }[];
            processes: {
              leased: number;
              warm: number;
            };
            sessions: {
              entryId: string | null;
              mode: 'pooled' | 'cold' | 'dedicated';
              program: 'shell' | 'claude' | 'codex' | 'gemini';
              reason: string | null;
              server: string;
              sessionId: string;
            }[];
            type: 'mcpPool';
          };
      ok: true;
      schemaVersion: 1;
    }
  | {
      host: {
        buildId: string;
        id: Id;
        protocolVersion: 2;
        version: string;
      };
      launchProfileSupport?: LaunchProfileSupport[];
      programs: unknown[];
      providerVersions: unknown[];
      schemaVersion: 1;
      sessions: unknown[];
    };
export type WorkflowRecoveryContext = {
  bound: boolean;
  cursor?: Cursor;
  hasMoreRuns?: boolean;
  nativeEffectsRestored: false;
  page?: WorkflowRecoveryPage;
  runs?: {
    id: string;
    state: string;
    title: string;
  }[];
  scope: 'owner' | 'coordinator' | 'worker';
  selectionRequired: boolean;
  taskContext?: WorkflowRecoveryTask;
  type?: 'workflow';
} & WorkflowRecoveryContext1;
export type Cursor = number;
export type WorkflowContextPart =
  | {
      data: {
        budget: {
          [k: string]: unknown | undefined;
        };
        goal: string;
        id: string;
        revision: number;
        state:
          | 'draft'
          | 'active'
          | 'draining'
          | 'stopping'
          | 'stopped'
          | 'canceling'
          | 'canceled'
          | 'succeeded';
        title: string;
      };
      kind: 'run';
    }
  | {
      data: WorkflowConstraintPolicy;
      kind: 'constraintPolicy';
    }
  | {
      data: WorkflowConstraint;
      kind: 'constraint';
    }
  | {
      data: {
        attempts: number;
        currentAttempt: {
          id: string;
          ordinal: number;
          reportedOutcome: 'succeeded' | 'failed' | 'blocked' | 'canceled' | null;
          sessionId: string;
          state:
            | 'planned'
            | 'launching'
            | 'launchUnknown'
            | 'launchFailed'
            | 'assigned'
            | 'reported'
            | 'stopped'
            | 'succeeded'
            | 'failed'
            | 'canceled';
        } | null;
        dependencies: string[];
        dependencyState: 'ready' | 'waiting';
        id: string;
        instruction: string;
        key: string;
        state:
          | 'planned'
          | 'launching'
          | 'launchUnknown'
          | 'launchFailed'
          | 'assigned'
          | 'reported'
          | 'stopped'
          | 'succeeded'
          | 'failed'
          | 'canceled';
        taskResult: 'succeeded' | 'failed' | null;
        title: string;
      };
      kind: 'task';
    }
  | {
      data: {
        deliveryId: string | null;
        deliveryNativePhase: string | null;
        deliveryPhase: string | null;
        deliveryReceiptId: string | null;
        id: string;
        launchPhase: string | null;
        launchReceiptId: string | null;
        ordinal: number;
        reportedOutcome: 'succeeded' | 'failed' | 'blocked' | 'canceled' | null;
        sessionId: string;
        state:
          | 'planned'
          | 'launching'
          | 'launchUnknown'
          | 'launchFailed'
          | 'assigned'
          | 'reported'
          | 'stopped'
          | 'succeeded'
          | 'failed'
          | 'canceled';
        taskId: string;
        validationPassed: boolean | null;
      };
      kind: 'attempt';
    }
  | {
      data: {
        attemptId: string;
        audience: 'owner' | 'coordinator';
        expiresAt: number;
        id: string;
        revision: number;
        state: 'pending' | 'answered' | 'canceled' | 'expired';
      };
      kind: 'decision';
    }
  | {
      data: {
        attemptId: string | null;
        code: string | null;
        id: string;
        kind: 'stop' | 'cancel';
        operationKey: string | null;
        phase: string | null;
        receiptId: string | null;
        sessionId: string | null;
        state: string;
      };
      kind: 'control';
    }
  | {
      data: {
        id: string;
        nativePhase: string;
        phase: string;
        policyId: string;
        reason: string | null;
        receiptId: string;
      };
      kind: 'wakeBatch';
    }
  | {
      data: {
        operation: 'create' | 'send' | 'interrupt' | 'stop';
        phase: string;
        receiptId: string;
        sessionId: string;
      };
      kind: 'nativeOperation';
    }
  | {
      data: {
        enabled: boolean;
        generation: number;
        id: string;
        phase: string;
        reason: string | null;
        type: 'executor' | 'wakes';
      };
      kind: 'automation';
    }
  | {
      data: {
        messageHead: number;
        pendingCoordinatorMessages: number;
      };
      kind: 'inbox';
    };
export type Timestamp = number;
export type WorkflowRecoveryContext1 =
  | {
      bound?: true;
      scope?: 'worker';
      selectionRequired?: false;
    }
  | {
      bound?: true;
      scope?: 'owner' | 'coordinator';
      selectionRequired?: false;
    }
  | {
      bound?: false;
      hasMoreRuns?: false;
      runs?: unknown;
      scope?: 'worker' | 'coordinator';
      selectionRequired?: false;
    }
  | {
      bound?: false;
      runs: unknown;
      scope?: 'coordinator';
      selectionRequired?: true;
    };
export type WorkflowWakeDelivery = 'delta' | 'full';
export type Id = string;
export type WorkflowWakeBaseline = {
  checkpointDigest: string | null;
  checkpointId: null | Id;
  contextDigest?: string;
  partCount?: number;
  pendingInbox?: number;
  tasks?: {
    key: string;
    state:
      | 'planned'
      | 'launching'
      | 'launchUnknown'
      | 'launchFailed'
      | 'assigned'
      | 'reported'
      | 'stopped'
      | 'succeeded'
      | 'failed'
      | 'canceled';
  }[];
} & WorkflowWakeBaseline1;
export type WorkflowWakeBaseline1 = {
  [k: string]: unknown | undefined;
};
export type JobAttemptChecks = {
  details: string;
  name: string;
  outcome: 'passed' | 'failed' | 'skipped';
}[];
export type NativeToolNames = string[];
export type RepositoryContext = {
  branch: string | null;
  name: string | null;
  observedAt: number | null;
  revision: number;
  source: 'launchDirectory';
  state: 'checking' | 'ready' | 'detached' | 'notRepository' | 'unavailable' | 'stale';
} & RepositoryContext1;
export type RepositoryContext1 =
  | {
      branch?: string;
      name?: string;
      observedAt?: number;
      state?: 'ready';
    }
  | {
      branch?: null;
      name?: string;
      observedAt?: number;
      state?: 'detached';
    }
  | {
      branch?: null;
      name?: null;
      observedAt?: number;
      state?: 'notRepository' | 'stale';
    }
  | {
      branch?: null;
      name?: null;
      observedAt?: null;
      state?: 'checking' | 'unavailable';
    };
export type SearchRoot = {
  observedAt: number | null;
  path: string | null;
  reason: 'insideRoot' | 'outsideRoot' | 'noCurrentCwd';
  source: 'currentCwd' | 'launchDirectory';
} & SearchRoot1;
export type SearchRoot1 =
  | {
      observedAt?: number;
      path?: string;
      reason?: 'insideRoot';
      source?: 'currentCwd';
    }
  | {
      observedAt?: number;
      path?: null;
      reason?: 'outsideRoot';
      source?: 'launchDirectory';
    }
  | {
      observedAt?: null;
      path?: null;
      reason?: 'noCurrentCwd';
      source?: 'launchDirectory';
    };

export type Receipt = {
  id: string;
  operation: 'create' | 'send' | 'interrupt' | 'stop';
  phase:
    | 'accepted'
    | 'dispatching'
    | 'created'
    | 'failed'
    | 'unknown'
    | 'delivered'
    | 'received'
    | 'started'
    | 'waiting'
    | 'settled'
    | 'interrupted'
    | 'stopRequested'
    | 'stopped';
  result: {
    [k: string]: unknown | undefined;
  };
  sessionId: string;
};
export type WorkflowRecoveryPage = {
  checkpoint: null | WorkflowCheckpoint;
  context: WorkflowContextMetadata;
  currentConstraints: WorkflowConstraintPolicy;
  nextOffset: number | null;
  parts: WorkflowContextPart[];
  run: {
    [k: string]: unknown | undefined;
  };
};
export type WorkflowCheckpoint = {
  createdAt: number;
  digest: string;
  id: string;
  issuer: string;
  ordinal: number;
  sourceCursor: number;
  sourceRunRevision: number;
  summary: string | null;
};
export type WorkflowContextMetadata = {
  baselineDiffers: boolean | null;
  digest: string;
  kind: 'current' | 'historical';
  nativeEffectsRestored: false;
  partCount: number;
  schemaVersion: 1;
  sourceCursor: number;
  sourceRunRevision: number;
};
export type WorkflowConstraintPolicy = {
  acknowledgedRevision: number;
  pending: boolean;
  revision: number;
};
export type WorkflowConstraint = {
  createdAt: number;
  id: string;
  issuer: string;
  revision: number;
  text: string;
};
export type WorkflowRecoveryTask = {
  attempt: WorkflowAttempt;
  constraints?: {
    policy: WorkflowConstraintPolicy;
    records: WorkflowConstraint[];
  };
  run: {
    id: unknown;
    revision: unknown;
    state: unknown;
    title: unknown;
  };
  task: {
    id: unknown;
    instruction: unknown;
    key: unknown;
    title: unknown;
  };
  workingState?: {
    [k: string]: unknown | undefined;
  } | null;
};
export type WorkflowAttempt = {
  delivery?: null | WorkflowDelivery;
  id: string;
  launch?: null | WorkflowLaunch;
  ordinal: number;
  result: {
    [k: string]: unknown | undefined;
  } | null;
  sessionId: string;
  state:
    | 'launching'
    | 'launchFailed'
    | 'launchUnknown'
    | 'assigned'
    | 'reported'
    | 'succeeded'
    | 'failed'
    | 'stopped';
  taskId: string;
  validation: {
    [k: string]: unknown | undefined;
  } | null;
};
export type WorkflowDelivery = {
  attemptId: string;
  blocker: string | null;
  createdAt: Timestamp;
  deadlineAt: Timestamp;
  id: string;
  native: {
    phase?: string;
    result?: {
      [k: string]: unknown | undefined;
    };
  } | null;
  operationKey: string | null;
  phase:
    'queued' | 'dispatching' | 'sent' | 'failed' | 'paused' | 'expired' | 'canceled' | 'unknown';
  receiptId: string | null;
  reuse?: {
    createdAt: Timestamp;
    previousAttemptId: string;
    sessionId: string;
  } | null;
};
export type WorkflowLaunch = {
  attemptId: string;
  code: string | null;
  createdAt: Timestamp;
  directory: string | null;
  effectStarted: boolean | null;
  operationKey: string;
  phase: 'accepted' | 'dispatching' | 'created' | 'failed' | 'unknown';
  preparedWorkspace?: {
    derivedWorktree: boolean | null;
    directory: string | null;
    preparedAt: number | null;
  } | null;
  profile?: {
    allowedNesvoTools?: string[];
    claudeQuotaCapture?: ClaudeQuotaCapture;
  } | null;
  quotaHoldReason?: 'quota_wait' | 'native_run_busy' | null;
  receiptId: string;
  sessionId: string;
  workspace: 'shared' | 'worktree';
};
export type ClaudeQuotaCapture = {
  displayProfile: string;
};
export type WorkflowCoordinatorBinding = {
  directory: string;
  generation: number;
  groupId: string | null;
  nativeEffectsRestored: false;
  previousSessionId: string | null;
  sessionId: string;
  source: 'retainedSession' | 'recoveryRecord' | 'previousBinding' | 'unbound';
  updatedAt: Timestamp;
  workerAuthorityRestored: false;
};
export type WorkflowWakeBatchSummary = {
  createdAt: Timestamp;
  delivery: WorkflowWakeDelivery;
  id: Id;
  native: WorkflowWakeNative;
  noticeCount: number;
  phase: 'dispatching' | 'settled' | 'failed' | 'unknown' | 'interrupted';
  reason: string | null;
};
export type WorkflowWakeNative = {
  phase: string;
};
export type WorkflowWakeNotice = {
  batchId?: string | null;
  createdAt?: Timestamp;
  id: Id;
  kind: 'result' | 'decision' | 'question' | 'error' | 'blocker';
  reference: {
    [k: string]: unknown | undefined;
  } & {
    attemptId?: string | null;
    attention?: {
      blockedChildren: number;
      exitCode: number | null;
      priority: number;
      processExited: boolean;
      reason: string | null;
    };
    decisionId?: string | null;
    decisionState?: string | null;
    messageId?: Id;
    messageSequence?: Cursor;
    sessionId?: Id;
    signalRevision?: number;
    taskId?: string | null;
  };
  sequence: Cursor;
};
export type WorkflowWakePolicy = {
  coordinator: Id;
  createdAt: Timestamp;
  delivery: WorkflowWakeDelivery;
  enabled: boolean;
  generation: number;
  held: boolean;
  id: Id;
  issuer: Id;
  phase: 'enabled' | 'waiting' | 'paused' | 'held' | 'disabled' | 'completed';
  reason: string | null;
  runId: Id;
};
export type WorkflowWakeBatch = {
  afterSequence: number | null;
  baseline: null | WorkflowWakeBaseline;
  createdAt: Timestamp;
  delivery: WorkflowWakeDelivery;
  generation: number;
  id: Id;
  issuer: Id;
  native: WorkflowWakeNative;
  notices: WorkflowWakeNotice[];
  operationKey: string;
  phase: 'dispatching' | 'settled' | 'failed' | 'unknown' | 'interrupted';
  policyId: Id;
  reason: string | null;
  receiptId: Id;
};
export type WorkflowExecutor = {
  createdAt: Timestamp;
  enabled: boolean;
  generation: number;
  id: string;
  issuer: string;
  phase: 'enabled' | 'waiting' | 'blocked' | 'disabled' | 'paused' | 'completed' | 'scheduling';
  reason: string | null;
  runId: string;
  spec: {
    readinessTimeoutMs: number;
    retryDelayMs: number;
    retryFailed: boolean;
    tasks: {
      profile: {
        claudeQuotaCapture?: ClaudeQuotaCapture;
        cwd?: string | null;
        effort?: string;
        harness?: boolean | null;
        model?: string;
        name?: string | null;
        program: 'claude' | 'codex' | 'gemini';
        workspace: 'shared' | 'worktree';
      };
      taskId: string;
    }[];
  };
  taskId: string | null;
};
export type WorkflowDigest = {
  budget: {
    [k: string]: unknown | undefined;
  };
  decisions: {
    answered: unknown;
    closed: unknown;
    pending: unknown;
    total: unknown;
  };
  evidence: {
    checkpointCount: number;
    checkpoints: unknown[];
    journalCursor: number;
  };
  inbox: {
    messageHead: unknown;
    pendingCoordinatorMessages: unknown;
  };
  kind: 'final' | 'workingState';
  omittedTasks: number;
  openDecisions: unknown[];
  producedAt: number;
  runId: string;
  schemaVersion: 1;
  sourceRevision: number;
  state: string;
  taskDigests: {
    attempt: {
      [k: string]: unknown | undefined;
    } | null;
    checks: {
      failed: unknown;
      passed: unknown;
      skipped: unknown;
    };
    decisionsAnswered: number;
    files: string[];
    filesTotal: number;
    id: string;
    key: string;
    limitations: number;
    nativeOperations: number;
    nextSteps: string[];
    outcome: 'succeeded' | 'failed' | 'blocked' | 'canceled' | null;
    state: string;
    summary: string | null;
    validation: {
      [k: string]: unknown | undefined;
    } | null;
    workspace: {
      branch: string | null;
      directory: string | null;
      kind: 'shared' | 'worktree';
    } | null;
  }[];
  tasks: {
    byState: {
      [k: string]: number | undefined;
    };
    total: number;
  };
  title: string;
  truncated: boolean;
};
export type WorkflowDecision = {
  answer: string | null;
  askedBy: {
    [k: string]: unknown | undefined;
  };
  attemptId: string;
  audience: 'owner' | 'coordinator';
  createdAt: Timestamp;
  expiresAt: Timestamp;
  id: string;
  question: string;
  reason: string | null;
  resolvedAt: number | null;
  resolvedBy: {
    [k: string]: unknown | undefined;
  } | null;
  revision: number;
  runId: string;
  state: 'pending' | 'answered' | 'canceled' | 'expired';
  taskId: string;
};
export type RunBudget = {
  activeAttempts: number;
  deadlineAt: number | null;
  exhaustedAt: number | null;
  limits: {
    maxAttemptsPerTask: number;
    maxElapsedMs: number | null;
    maxParallel: number;
  };
  ownerDrain: boolean;
  startedAt: number | null;
  timeState: 'notStarted' | 'untracked' | 'unlimited' | 'open' | 'exhausted';
};
export type WorkflowMessage = {
  ackedAt: number | null;
  ackedBy: {
    [k: string]: unknown | undefined;
  } | null;
  body: string;
  correlationId: string;
  createdAt: Timestamp;
  id: string;
  kind: 'note' | 'question' | 'error' | 'result' | 'decision';
  payload: {
    [k: string]: unknown | undefined;
  } | null;
  recipientAttemptId: string | null;
  runId: string;
  sender: {
    attemptId?: string;
    role: 'owner' | 'coordinator' | 'worker';
    sessionId?: string;
  };
  sequence: number;
};
export type JobTriggerDelivery = {
  acceptedAt: Timestamp;
  bodyDigest: string;
  credentialGeneration: number;
  deliveryId: string;
  disposition: 'queued' | 'skipped' | 'ignored';
  id: Id;
  jobId: Id;
  jobRevision: number;
  occurrenceId: null | Id;
  reason: string | null;
  triggerId: Id;
  triggerRevision: number;
};
export type JobTrigger = {
  createdAt: Timestamp;
  credentialGeneration: number;
  enabled: boolean;
  id: Id;
  revision: number;
  revoked: boolean;
  spec: JobTriggerSpec;
  updatedAt: Timestamp;
};
export type JobTriggerSpec = {
  adapter:
    | {
        event: string;
        kind: 'webhook';
      }
    | ((
        | {
            actions?: unknown;
            event?: 'push';
          }
        | {
            actions?: (
              | 'assigned'
              | 'unassigned'
              | 'labeled'
              | 'unlabeled'
              | 'opened'
              | 'edited'
              | 'closed'
              | 'reopened'
              | 'synchronize'
              | 'converted_to_draft'
              | 'locked'
              | 'unlocked'
              | 'enqueued'
              | 'dequeued'
              | 'milestoned'
              | 'demilestoned'
              | 'ready_for_review'
              | 'review_requested'
              | 'review_request_removed'
              | 'auto_merge_enabled'
              | 'auto_merge_disabled'
            )[];
            event?: 'pull_request';
          }
        | {
            actions?: ['completed'];
            event?: 'workflow_run';
          }
      ) & {
        actions: string[];
        branch: string | null;
        event: 'push' | 'pull_request' | 'workflow_run';
        kind: 'github';
        repository: string;
        repositoryId: number;
      });
  jobId: Id;
  jobRevision: number;
  title: string;
};
export type PrecheckApproval = {
  createdAt: Timestamp;
  digest: string;
  enabled: boolean;
  environmentPolicy: 'isolated-platform-v1';
  id: Id;
  platformEnvironmentKeys: 'SystemRoot'[];
  revision: number;
  sandboxed: false;
  spec?: {
    arguments: unknown;
    cwd: unknown;
    environment: unknown;
    executable: unknown;
    passExitCodes: unknown;
    skipExitCodes: unknown;
    timeoutMs: unknown;
    title: unknown;
    version: unknown;
  };
  trust: 'ownerExactCommand';
};
export type JobDefinition = {
  calendarError?: {
    code: string;
    message: string;
  } | null;
  calendarState?: 'ready' | 'exhausted' | 'blocked';
  createdAt: Timestamp;
  enabled: boolean;
  id: Id;
  nextDueAt: null | Cursor;
  revision: number;
  schedule:
    | {
        at: string;
        kind: 'once';
      }
    | {
        expression: string;
        kind: 'cron';
        timeZone: string;
      }
    | {
        kind: 'rrule';
        rule: string;
        start: string;
        timeZone: string;
      }
    | {
        kind: 'external';
      };
  spec?: {
    executionTimeoutMs?: number;
    instruction: unknown;
    profile: {
      claudeQuotaCapture?: ClaudeQuotaCapture;
    };
    quotaPolicy?: JobQuotaPolicy;
    retry?: JobRetryPolicy;
    schedule: unknown;
    title: unknown;
  };
  title: string;
};
export type JobQuotaPolicy = {
  accountFingerprint: string;
  contextId: string;
  mode: 'wait';
};
export type JobRetryPolicy = {
  initialDelayMs: number;
  maxAttempts: number;
  maxDelayMs: number;
  on: 'launchNoEffect';
};
export type JobAttemptDetail = {
  attemptId: null | Id;
  claimedAt: number | null;
  createdAt: Timestamp;
  executionTimeout?: null | JobExecutionTimeout;
  finishedAt: number | null;
  id: Id;
  jobId: Id;
  launchReceiptId: null | Id;
  launchReconciliation?: null | JobLaunchReconciliation;
  launchResolution?: null | JobLaunchResolution;
  occurrenceId: Id;
  ordinal: number;
  precheck: {
    approvalDigest: string | null;
    approvalId: string;
    approvalRevision?: number | null;
    authorizedAt: number;
    finishedAt: number | null;
    observedAt: number | null;
    reason: string;
    result: null | PrecheckOutcome;
    state:
      | 'running'
      | 'passed'
      | 'skipped'
      | 'failed'
      | 'timedOut'
      | 'outputLimit'
      | 'refused'
      | 'unknown'
      | 'abandoned';
  } | null;
  reason: string | null;
  result: null | JobAttemptResult;
  retry?: null | JobRetryDecision;
  retryAdmission?: null | JobRetryAdmission;
  retryClassification?: null | JobRetryClassification;
  runId: null | Id;
  runState: string | null;
  sessionId: null | Id;
  state:
    | 'dispatching'
    | 'prechecking'
    | 'running'
    | 'needsValidation'
    | 'reconcile'
    | 'canceling'
    | 'succeeded'
    | 'failed'
    | 'skipped'
    | 'canceled';
  validation: null | JobAttemptValidation;
};
export type JobExecutionTimeout = {
  armedAt: Timestamp;
  attemptId: Id;
  controlId: null | Id;
  controlKey: string;
  deadlineAt: Timestamp;
  executionTimeoutMs: number;
  jobAttemptId: Id;
  jobId: Id;
  launchReceiptId: Id;
  observedAt: Timestamp;
  occurrenceId: Id;
  reason: string | null;
  requestedAt: number | null;
  runId: Id;
  sessionId: Id;
  state:
    'armed' | 'disarmed' | 'dispatching' | 'awaitingExit' | 'blocked' | 'unconfirmed' | 'completed';
};
export type JobLaunchReconciliation = {
  attemptId: Id;
  available: boolean;
  digest: string | null;
  jobAttemptId: Id;
  jobId: Id;
  kind: 'launchNoEffect';
  launchReceiptId: Id;
  occurrenceId: Id;
  reason: string | null;
  retryClassification?: JobRetryClassification;
  runId: Id;
  sessionId: Id;
};
export type JobRetryClassification = {
  claimProbe?: null | JobRetryProbe;
  class: 'noEffect' | 'uncertainEffect' | 'definiteEffect';
  decidedAt: number | null;
  decision: 'probing' | 'adopted' | 'retryWaiting' | 'blocked' | 'canceled';
  failure: string | null;
  launchKey: string | null;
  nextOrdinal: number | null;
  notBefore: number | null;
  probe: null | JobRetryProbe;
  retryJobAttemptId?: string | null;
  state?: 'waiting' | 'claimed' | 'canceled' | 'blocked' | 'adopted';
};
export type JobRetryProbe = {
  attemptId: string | null;
  attemptState: string | null;
  executorAccepted: boolean;
  launchKey: string;
  launchReceiptId: string | null;
  observedAt: Timestamp;
  result: 'absent' | 'noEffectProven' | 'attemptFound' | 'sessionFound';
  runId: string | null;
  sessionId: string | null;
};
export type JobLaunchResolution = {
  acknowledgedAt: Timestamp;
  attemptId: Id;
  digest: string;
  jobAttemptId: Id;
  jobId: Id;
  kind: 'launchNoEffect';
  launchReceiptId: Id;
  mutationKey: string;
  occurrenceId: Id;
  runId: Id;
  sessionId: Id;
};
export type PrecheckOutcome = {
  cleanupConfirmed: boolean;
  commandStarted: boolean | null;
  durationMs: number;
  exitCode: number | null;
  reason: string;
  state: 'passed' | 'skipped' | 'failed' | 'timedOut' | 'outputLimit' | 'refused' | 'unknown';
  stderr?: string;
  stderrTruncated: boolean;
  stdout?: string;
  stdoutTruncated: boolean;
};
export type JobAttemptResult = {
  artifacts: string[];
  checks: JobAttemptChecks;
  files: string[];
  limitations: string[];
  outcome: 'succeeded' | 'failed' | 'blocked' | 'canceled';
  summary: string;
};
export type JobRetryDecision = {
  attemptId: null | Id;
  class?: 'noEffect' | 'uncertainEffect';
  decidedAt: Timestamp;
  jobAttemptId: Id;
  launchReceiptId: null | Id;
  nextOrdinal: number | null;
  notBefore: Cursor;
  probe?: JobRetryProbe;
};
export type JobRetryAdmission = {
  claimProbe: null | JobRetryProbe;
  class: 'noEffect' | 'uncertainEffect';
  sourceJobAttemptId: Id;
};
export type JobAttemptValidation = {
  checks: JobAttemptChecks;
  passed: boolean;
  source: 'ownerAttestation' | 'coordinatorAttestation';
  summary: string;
  validatorSessionId: null | Id;
};
export type JobAttemptSummary = {
  attemptId: null | Id;
  claimedAt: number | null;
  createdAt: Timestamp;
  executionTimeout?: null | JobExecutionTimeout;
  finishedAt: number | null;
  id: Id;
  jobId: Id;
  launchReceiptId: null | Id;
  launchReconciliation?: null | JobLaunchReconciliation;
  launchResolution?: null | JobLaunchResolution;
  occurrenceId: Id;
  ordinal: number;
  precheck: {
    approvalDigest: string | null;
    approvalId: string;
    approvalRevision?: number | null;
    authorizedAt: number;
    finishedAt: number | null;
    observedAt: number | null;
    reason: string;
    result: null | PrecheckOutcome;
    state:
      | 'running'
      | 'passed'
      | 'skipped'
      | 'failed'
      | 'timedOut'
      | 'outputLimit'
      | 'refused'
      | 'unknown'
      | 'abandoned';
  } | null;
  reason: string | null;
  retry?: null | JobRetryDecision;
  retryAdmission?: null | JobRetryAdmission;
  retryClassification?: null | JobRetryClassification;
  runId: null | Id;
  runState: string | null;
  sessionId: null | Id;
  state:
    | 'dispatching'
    | 'prechecking'
    | 'running'
    | 'needsValidation'
    | 'reconcile'
    | 'canceling'
    | 'succeeded'
    | 'failed'
    | 'skipped'
    | 'canceled';
};
export type JobOccurrence = {
  attemptId?: null | Id;
  cancellation?: null | JobCancellation;
  coalescedFromAt?: null | Cursor;
  createdAt: Timestamp;
  dueAt: Timestamp;
  executionTimeout?: null | JobExecutionTimeout;
  finishedAt: null | Cursor;
  id: Id;
  jobAttemptId?: null | Id;
  jobAttemptOrdinal?: number | null;
  jobId: Id;
  jobRevision: number;
  launchReceiptId?: null | Id;
  launchReconciliation?: null | JobLaunchReconciliation;
  launchResolution?: null | JobLaunchResolution;
  precheck?: {
    approvalDigest: string | null;
    approvalId: string;
    approvalRevision?: number | null;
    authorizedAt: number;
    finishedAt: number | null;
    observedAt: number | null;
    reason: string;
    result: null | PrecheckOutcome;
    state:
      | 'running'
      | 'passed'
      | 'skipped'
      | 'failed'
      | 'timedOut'
      | 'outputLimit'
      | 'refused'
      | 'unknown'
      | 'abandoned';
  } | null;
  quota?: JobQuotaDecision;
  reason: string | null;
  retry?: null | JobRetryDecision;
  runId: null | Id;
  sessionId?: null | Id;
  spec?: {
    executionTimeoutMs?: number;
    instruction: unknown;
    profile: {
      claudeQuotaCapture?: ClaudeQuotaCapture;
    };
    quotaPolicy?: JobQuotaPolicy;
    retry?: JobRetryPolicy;
    schedule: unknown;
    title: unknown;
  };
  startedAt: null | Cursor;
  state:
    | 'queued'
    | 'dispatching'
    | 'running'
    | 'needsValidation'
    | 'reconcile'
    | 'skipped'
    | 'succeeded'
    | 'failed'
    | 'canceled'
    | 'prechecking'
    | 'canceling'
    | 'retryWaiting';
  trigger: 'schedule' | 'manual' | 'external';
};
export type JobCancellation = {
  controlId: null | Id;
  controlKey: string;
  observedAt: Timestamp;
  reason: string | null;
  requestedAt: Timestamp;
  state:
    | 'requested'
    | 'awaitingPrecheck'
    | 'dispatching'
    | 'awaitingExit'
    | 'blocked'
    | 'unconfirmed'
    | 'completed'
    | 'abandoned';
};
export type JobQuotaDecision = {
  reason: string | null;
  state: 'waiting' | 'eligible' | 'notRequired';
};
export type ProviderQuotaGate = {
  holds: ProviderQuotaGateHold[];
  providers: ProviderQuotaGateProvider[];
  revision: Cursor;
};
export type ProviderQuotaGateHold = {
  checks: number;
  id: Id;
  kind: 'launch' | 'operation';
  program: 'claude' | 'codex' | 'gemini';
  reason: string;
  resetsAt: number | null;
  since: number;
};
export type ProviderQuotaGateProvider = {
  freshUntil: number | null;
  program: 'claude' | 'codex' | 'gemini';
  reason: string | null;
  resetsAt: number | null;
  source: 'codexAppServer' | 'claudeStatusline' | 'unsupported';
  sourceRevision: number | null;
  verdict: 'allow' | 'hold' | 'unknown';
};
export type ProviderQuotaObservation = {
  accountFingerprint: string | null;
  ageMs: number | null;
  attemptedAt: number | null;
  complete: boolean;
  contextId: string | null;
  eligibilityReason: string;
  expiresAt: number | null;
  freshness: 'fresh' | 'stale' | 'unavailable';
  observedAt: number | null;
  ordinaryUsageAllowed: boolean | null;
  ordinaryUsageEligible: boolean;
  program: 'claude' | 'codex' | 'gemini';
  readerId?: string;
  reason: string;
  revision: Cursor;
  scope: 'readerSnapshotOnly';
  source: 'codexAppServer' | 'claudeStatusCache' | 'unsupported';
  sourceAt: number | null;
  status: 'checking' | 'ready' | 'partial' | 'unavailable' | 'stale';
  windows: ProviderQuotaWindow[];
};
export type ProviderQuotaWindow = {
  durationMins: number;
  resetsAt: number | null;
  usedPercent: number;
};
export type QuotaWake = {
  generation: number;
  id: string;
  launchId: Id;
  operationId: string | null;
  operationPhase: string | null;
  phase: 'armed' | 'dispatching' | 'paused';
  predecessorId: string | null;
  reason: string | null;
  sessionId: Id;
  source: {
    accountFingerprint: string;
    contextId: string;
    readerId: string;
    resetAt: number;
    revision: number;
  };
};
export type Session = {
  cols: number;
  controllerId: number | null;
  createdAt: string;
  cwd: string;
  groupId: string | null;
  harness?: null | HarnessConfiguration;
  hibernation?: SessionHibernation;
  id: Id;
  launchProfile?: LaunchProfile;
  name: string;
  program?: 'shell' | 'claude' | 'codex' | 'gemini';
  repositoryContext?: RepositoryContext;
  resume?: ResumeVerification;
  rows: number;
  running: boolean;
  searchRoot?: SearchRoot;
  uptimeSeconds?: Cursor;
};
export type HarnessConfiguration = {
  childToolPolicy?: {
    allow: NativeToolNames;
    recursive: false;
    scope: 'authenticatedClaudeChildren';
    source: 'none' | 'ownerLaunch';
  };
  nativePermissions?: {
    allow: NativeToolNames;
    inheritedByChildren: false;
    originSessionId?: string | null;
    providerRulesStillApply: true;
    restrictsOtherTools: false;
    scope: 'process';
    source: 'none' | 'ownerLaunch' | 'ownerChildPolicy';
  };
};
export type SessionHibernation = {
  conversationId: string;
  hibernatedAt: Cursor;
  lastResumeFailure: string | null;
  state: 'hibernated';
  trigger: 'owner' | 'idlePolicy';
};
export type LaunchProfile = {
  inheritedByChildren: false;
  requested: {
    effort: string | null;
    model: string | null;
  };
  resolved: null;
  scope: 'process';
  source: 'launch' | 'providerDefaults';
};
export type ResumeVerification = {
  conversationId: string;
  reason?: string;
  state: 'pending' | 'verified' | 'resumeFailed';
};
export type ProviderAvailability = {
  reason?: string;
  state: 'ok' | 'noCli' | 'notLoggedIn' | 'unknown';
  version?: string;
};
export type Page = {
  data: string;
  floorCursor: Cursor;
  format: 'terminalReplay';
  fromCursor: Cursor;
  gap: boolean;
  headCursor: Cursor;
  more: boolean;
  nextCursor: Cursor;
};
export type PasteReceipt = {
  id: string;
  operation: 'paste';
  phase: 'pasted';
  result: {
    bytes: number;
    submitted: false;
  };
  sessionId: Id;
};
export type RecoveryRecord = {
  id: Id;
  spec: {
    cwd?: string | null;
    name: string;
    program: 'shell' | 'claude' | 'codex' | 'gemini';
    prompt: '';
    resume?: ResumeTarget;
  };
  state: 'saved' | 'starting' | 'interrupted';
};
export type ResumeTarget = {
  conversationId: string;
  provider: 'claude' | 'codex' | 'gemini';
};
export type AttentionItem = {
  at: Cursor;
  attemptId?: string;
  audience?: 'owner' | 'coordinator';
  decisionId?: Id;
  expiresAt?: Timestamp;
  id: string;
  jobId?: Id;
  kind: 'session' | 'decision' | 'run' | 'result';
  occurrenceId?: Id;
  priority: number;
  program?: 'claude' | 'codex' | 'gemini';
  reason: string;
  revision: Cursor;
  runId?: string | null;
  sessionId?: Id;
  summary?: string;
  taskId?: string;
  title: string;
};
export type AttentionReceipt = {
  acknowledgedAt: Timestamp;
  id: string;
  revision: Cursor;
};
export type Project = {
  defaultBranch: string | null;
  lastActivityAt: Timestamp;
  name: string;
  openSessions: number;
  pinned: boolean;
  root: string;
  sessions: Id[];
};
export type WorkflowTemplate = {
  budget: {
    maxAttemptsPerTask: number;
    maxElapsedMs: number | null;
    maxParallel: number;
  } | null;
  goal: string;
  name: string;
  start: 'draft' | 'active' | 'executor';
  tasks: {
    allowedNesvoTools: string[] | null;
    checks?: string[];
    dependencies: string[];
    harness: boolean | null;
    instruction: string;
    key: string;
    program: 'claude' | 'codex' | 'gemini';
    title: string;
    workspace: 'shared' | 'worktree';
  }[];
  title: string;
};
export type LaunchProfileSupport = {
  effortSource: 'cli' | 'modelAdvertised' | null;
  effortValues: string[] | null;
  explicitModelRequiredForEffort: true;
  modelFlag: '--model' | null;
  probeStatus: string;
  program: 'claude' | 'codex' | 'gemini';
  supported: boolean;
  version: string | null;
};
