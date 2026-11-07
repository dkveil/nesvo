# Architecture

## Process boundaries

```text
React renderer (plain TypeScript, base shadcn)
  |
  | window.nesvo.health() -> validated data
  v
Sandboxed preload (narrow typed API)
  |
  | Electron IPC, caller checked by main
  v
Electron main (window and host process lifetime)
  |
  | utilityProcess messages, Zod request/response contracts
  v
Node host (Effect scope and services)
  |
  v
SQLite (persistent identity in P0)

Standalone Node entry -> JSONL transport -> the same host service
```

Bun installs dependencies, runs scripts and builds the standalone host. It is not a runtime requirement for a packaged desktop.
Electron provides its own embedded Node for the utility process. The standalone host uses Node 24.
The host imports no Electron code; its desktop transport adapter belongs to the desktop main process.

Effect owns the database and request stream lifetime. Finalizers run on normal shutdown and transport completion.
SQLite uses a versioned bootstrap and transaction, WAL, foreign keys and a busy timeout. An unsupported newer schema is rejected before migration.
P0 stores only a persistent host identity; session/history/review schema belongs to later stages.

## Ownership

| Area                 | Owns                                                        | Must not own                                           |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| contracts            | Zod schemas, inferred data types, narrow desktop API        | Runtime services, UI state, provider implementations   |
| desktop main/preload | Window, IPC boundary, child process lifetime                | Domain decisions or credentials in renderer            |
| renderer             | Presentation and operator interaction                       | Effect, filesystem, process control or database access |
| host                 | Authoritative state, resources and future provider adapters | UI components or Electron dependency                   |

The health request carries a unique correlation ID. Malformed requests produce a bounded error response, not execution.
The renderer cannot send arbitrary host requests. It can only call the API exposed by preload.
Main denies external window creation, renderer navigation and permission requests.

## Growth by domain

Introduce sessions, delegation, review and skills modules as their stages are accepted.
Each host module keeps its domain rules, application service and adapters close together. Simple rules remain plain TypeScript; Effect composes I/O and lifetime.
Do not create a second schema system: public messages use the shared Zod contracts.

The renderer grows with a light feature-sliced structure:

```text
app -> pages/widgets -> features -> entities -> shared
```

Create only the layers needed by actual features. Imports move downward; cross-slice imports use public entry points.
Sibling features do not reach into each other's implementation. Shared contains generic UI and utilities, not session state or orchestration rules.
P1 composes a workspace page from session navigation, conversation, details and review widgets. Creation and live host status are features; session presentation types live in entities/session. Public slice entry points define the imports.

Demonstration fixtures belong to pages/workspace/demo-data.ts. The page owns temporary preview sessions, selection and per-session drafts. These are explicitly non-authoritative UI examples, not a replacement for the host's future session state. P2 will introduce the real session contract and provider adapter. No mock response is presented as an actual agent operation.

## Deliberate P0 limits

The host is local and lives with the desktop. There is no network listener, remote authentication, provider execution or background daemon.
A closed host is not silently restarted. UI reports failure and lets the operator retry or reopen the app.
History recovery, worker lifetimes, cancellation and review revision rules are introduced with their corresponding stages.
