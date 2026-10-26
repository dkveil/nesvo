# Documentation index

Every document in this folder is listed once. Where two documents touch the same contract,
the one named here is the source and the other links to it.

## Start here

| Document                                         | Covers                                                        |
| ------------------------------------------------ | ------------------------------------------------------------- |
| [Quick start](quick-start.md)                    | Host, desktop client and phone setup                          |
| [Engine map](engine-map.md)                      | What the engine does and how to observe it, on one page       |
| [TUI guide and keyboard](../apps/tui/README.md)  | Every TUI view and key; the source for key bindings           |
| [Review and session workflows](tui-workflows.md) | Review, scheduling, worktree and palette workflows in the TUI |
| [Compact navigation](tui-compact-navigation.md)  | Sidebar width, single-row sessions and provider marks         |
| [Host configuration](../apps/host/README.md)     | Host flags, data directory and pairing files                  |
| [Testing](testing.md)                            | Automated checks, native scenarios and the device checklist   |
| [Engineering conventions](engineering.md)        | Layering, naming, generated contracts and contributor gates   |
| [Harness delivery](harness-delivery.md)          | Status and evidence of each harness feature                   |

## Architecture and protocol

| Document                                                          | Covers                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| [Architecture](architecture.md)                                   | Ownership boundaries between host, clients and adapters  |
| [Host protocol v2](protocol-v2.md)                                | Wire commands, replies and every capability flag         |
| [Terminal client and synchronization](terminal-client.md)         | Shared groups, local layouts, watching and control       |
| [Agent session status](agent-session-status.md)                   | Status evidence, freshness and provider adapter limits   |
| [Provider status signals](provider-signals.md)                    | Which mechanism backs each status signal, per provider   |
| [Durable domain events](harness-events.md)                        | Event kinds, cursors, retention and the generated schema |
| [Durable session operations](harness-operations.md)               | Create, send and wait receipts and the journal drill     |
| [Shared SQLite writer admission](harness-transactions.md)         | Immediate transactions and numbered migrations           |
| [Host data-directory ownership](host-directory-ownership.md)      | One live host per data directory                         |
| [Host startup diagnostics](host-startup-diagnostics.md)           | Startup phase records                                    |
| [Windows session process ownership](windows-process-ownership.md) | Job objects and process-tree cleanup on Windows          |
| [Relay transport design](relay-design.md)                         | Proposed relay transport (not implemented)               |
| [Remote hosts and workers design](remote-design.md)               | Proposed multi-host operation (not implemented)          |

## Agent-facing surfaces

| Document                                                        | Covers                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| [Harness CLI](harness-cli.md)                                   | Every `nesvo` subcommand, exit codes and stdin rules     |
| [MCP adapter](harness-mcp.md)                                   | Tool table (generated), event resources and the MCP pool |
| [Automatic review context](agent-diff-context.md)               | Hook-selected review folder of a launched Claude session |
| [Contextual session search](harness-contextual-search.md)       | Search roots and repository context                      |
| [Launch-local model profiles](harness-model-profiles.md)        | Requested model and effort per launch                    |
| [Native tool permission additions](harness-tool-permissions.md) | Owner additions for one harness process                  |
| [Child tool policy](harness-child-tool-policy.md)               | Owner policy for a coordinator's children                |
| [Provider quota observations](harness-provider-quota.md)        | Quota sources, freshness and refresh                     |
| [Claude statusline capture](harness-claude-quota-capture.md)    | Opt-in statusline display and quota capture              |
| [Configured-account quota admission](harness-quota-jobs.md)     | The host-wide quota gate and job admission               |
| [One-shot quota continuation](harness-quota-wakes.md)           | Resuming a session after a quota reset                   |
| [Host process admission budgets](harness-budgets.md)            | Host and provider admission limits                       |

## Runs and workflows

| Document                                                             | Covers                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------- |
| [Durable workflow plans](harness-workflows.md)                       | Runs, tasks, templates, host checks and digests       |
| [Durable workflow inbox](harness-inbox.md)                           | Messages, recipients and acknowledgement              |
| [Questions and decisions](harness-decisions.md)                      | Attempt-bound decisions and their gates               |
| [Atomic task launch](harness-task-launch.md)                         | Reserving and launching a task worker                 |
| [Guarded task delivery](harness-task-delivery.md)                    | Queued instructions and worker session reuse          |
| [Task tool profiles](harness-task-tool-profiles.md)                  | Native tool selection per task                        |
| [Host DAG executor](harness-executor.md)                             | Automatic launch of dependency-ready tasks            |
| [Run budgets and drain](harness-run-budgets.md)                      | Run admission, elapsed budgets and drain              |
| [Native run stop and cancel](harness-run-controls.md)                | Run-level controls and their receipts                 |
| [Delta-only coordinator wakes](harness-wakes.md)                     | Wake batches, hold and delivery mode                  |
| [Checkpoints and owner constraints](harness-checkpoints.md)          | Saved context and literal owner constraints           |
| [Authenticated recovery context](harness-recovery-context.md)        | Context reconstruction and exact conversation resume  |
| [Coordinator binding recovery](harness-coordinator-recovery.md)      | Rebinding a run to a new coordinator                  |
| [Original-provider recovery probe](harness-native-recovery-probe.md) | Prepared coordinator recovery acceptance, not yet run |

## Jobs

| Document                                                                | Covers                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------- |
| [Durable host jobs](harness-jobs.md)                                    | Definitions, occurrences, attempts and the Jobs view |
| [Host job calendars](harness-job-calendars.md)                          | Cron, RRULE, time zones and DST                      |
| [Job prechecks](harness-job-prechecks.md)                               | Owner-approved commands before dispatch              |
| [Job execution timeouts](harness-job-timeouts.md)                       | Execution deadlines and cleanup                      |
| [No-effect launch reconciliation](harness-job-launch-reconciliation.md) | Owner abandonment of a proven no-effect launch       |
| [External job triggers](harness-job-triggers.md)                        | Signed webhook and GitHub triggers                   |
| [Jobs presentation review](harness-jobs-ui-review.md)                   | The approved Jobs view layout and its checks         |

## Product and design

| Document                                  | Covers                                     |
| ----------------------------------------- | ------------------------------------------ |
| [Interface direction](design.md)          | Visual rules for both clients              |
| [Branding and compatibility](branding.md) | Name, mark and compatibility identifiers   |
| [Mobile priorities](mobile-roadmap.md)    | Proposed mobile sequence and current state |
