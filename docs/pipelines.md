# Pipelines

A pipeline runs a task through checks you define in files. This guide is for the operator: what the files contain, how a run moves through them, and how to edit them in the graph editor, with the assistant dock or from a terminal. How the host implements this is in [architecture.md](architecture.md#pipelines).

## Files and roots

Everything lives in plain Markdown files on the computer that runs the task. A remote computer reads its own files.

| Root | Folder | Holds |
| -- | -- | -- |
| Global | `~/.agents/pipelines/` | `steps/*.md`, `pipelines/*.md` shared by every project |
| Project | `<project>/.agents/pipelines/` | `steps/*.md`, `pipelines/*.md` for this project |
| Tasks | `<project>/.agents/tasks/*.md` | task specs; any Markdown file inside the project also works |

The project is the nearest folder, at or above the working directory, that contains `.git`, or the folder itself when there is none. A project step or pipeline with the same name as a global one replaces it. Each file is at most 64 KiB; a root reads at most 200 steps and 100 pipelines.

Saving or deleting a pipeline that has a run in progress is refused as busy, in the editor and the dock alike.

The files are the source of truth. Nesvo never keeps a second copy of a definition: a run pins the definitions it started with, so editing a file never changes a run in progress.

## The step file

One file per step, named `<name>.md`. The frontmatter describes the step and the body is what it does.

```markdown
---
name: lint
type: command
phase: pre-done
timeout: 5m
retries: 1
on_fail: stop
---
bun run lint
```

| Field | Values | Meaning |
| -- | -- | -- |
| `name` | lowercase letters, digits and inner hyphens | Must match the file name. |
| `type` | `command`, `agent`, `human`, `action` | `command` runs a check, `agent` asks a read-only session to verify, `human` waits for your decision, `action` runs something with an effect outside the task. |
| `phase` | `plan`, `pre-done`, `pre-push` | When the step runs, see [Phases](#phases-and-author-turns). |
| `timeout` | `1s` to `4h`, for example `90s`, `15m` | Default `15m`. |
| `retries` | 0 to 5 | Default 0. A `human` step never retries. The value is recorded and shown, but the runner does not retry a step by itself yet; Resume runs a failed step again. |
| `on_fail` | `stop`, `fix` | Default `stop`: a failure ends the run. `fix`: the run needs your attention with the failure instead of failing, and Resume runs the step again. Only the Fix decision of a `human` gate sends a correction to the author. |
| `effect` | `local`, `external` | Default `local`. Only `command` and `action` steps can be `external`; Nesvo warns when nothing asks a human first. |
| `skill` | a skill name | Only `agent` steps. An agent step needs instructions or a skill. |
| `needs` | `env:NAME`, `browser` | A missing `env:NAME` variable blocks the step with a readable reason instead of running it. `browser` is not available on this host yet and always blocks the step. |

Body by type: a `command` or `action` body is a shell script run in the task directory; an `agent` body holds the instructions for the verifying session; a `human` body is the question shown at the gate. Command and action steps do not inherit variables ending in `KEY`, `TOKEN`, `SECRET` or `PASSWORD`; list them in `needs` when a step really needs one.

## The pipeline file

One file per pipeline, named `<name>.md`.

```markdown
---
name: release
description: Lint and tests in parallel, one review, a human decision, then publish.
steps: [lint, test, review, collect-logs, approve, publish]
edges:
  - lint -> review
  - test -> review
  - review -> approve
  - review -> collect-logs on failure
  - approve -> publish
layout:
  lint: [0, 0]
  test: [0, 140]
  review: [260, 70]
  approve: [520, 70]
  publish: [780, 70]
---
Free text for people. Nesvo does not interpret it.
```

Edges stay inside one phase, so in this example all six steps declare `phase: pre-done` in their step files; an edge from a `pre-done` step to a `pre-push` step is refused.

| Field | Meaning |
| -- | -- |
| `name`, `description` | Identify the pipeline. |
| `steps` | Required: 1 to 32 unique step names. They are the nodes of the graph. |
| `edges` | Optional: at most 64 entries, one string each. Describes the order and the branches. |
| `layout` | Optional: step name to `[x, y]` whole numbers. Only the editor reads it; nothing that runs steps does. |

### The edge grammar

```text
<from> -> <to>
<from> -> <to> on success
<from> -> <to> on failure
<from> -> <to> on any
```

`on success` is the default and may be left out. Whitespace around the arrow is free. The editor shows the conditions as On success, On failure and Always.

- **Without `edges`** the pipeline is a chain: inside each phase, each step follows the one before it in `steps` order and runs on its own, one step at a time. Every pipeline written before graphs keeps its meaning without an edit.
- **With `edges`**, even `edges: []`, the graph is explicit: a step with no incoming edge starts as soon as its phase begins, and a step with several incoming edges waits for all of them.

## Validation in plain words

Errors make the pipeline invalid: the catalog lists it only through its issues, and a save is refused.

| Rule | What it says |
| -- | -- |
| Edge syntax | Every entry reads `<step> -> <step>` with an optional `on success`, `on failure` or `on any`. |
| Known steps | Both ends of an edge are in `steps`. |
| No self edge | A step cannot connect to itself. |
| No duplicate | The same edge is not listed twice (`on success` written or omitted counts as one). |
| One phase | An edge stays inside one phase. Phases keep their fixed order. |
| No cycle | The steps never form a loop. |
| No routed decisions | An `on failure` edge cannot leave a `human` step: a human decides to accept, reject or fix. |
| Reachable joins | A step cannot wait for both the success and the failure of the same step. |
| Size | At most 64 edges and 32 steps. |

Warnings are saved and shown next to the step:

- the `layout` names a step that is not in the pipeline (the editor drops it on the next save);
- an `external` step, or a body that mentions `git push`, `gh pr`, `curl` or `wget`, that some path reaches without a human step first;
- the pipeline has no gate at all, or a `fix` step has no retries;
- two agent steps of one phase could start together, while the computer runs one session at a time.

## Phases and author turns

A task is a spec run through one pipeline. Starting it creates one ordinary session, optionally in its own Git worktree and branch (a worktree needs the folder to be the top level of a Git repository). The phases and the author's turns alternate:

1. **Plan.** When the pipeline has an `agent` or `human` step in `plan`, the author first answers a planning turn without changing files. Then the `plan` steps run.
2. **Implementation turn.** The author works from the spec and the plan.
3. **Before done** (`pre-done`). The steps check the result: tests, lint, review, a human gate.
4. **Before push** (`pre-push`). The last steps before anything leaves the machine: a final gate, a push action.

The run passes when the last phase passes. A `human` gate binds to the latest saved result and offers accept, reject or fix. Fix sends your comment to the author as one correction turn and runs the checks again; reject ends the run. Nothing is replayed: a turn is sent once, and a run that was interrupted continues only when you resume it.

## How a run moves through a graph

- **Ready steps.** A step starts when every incoming edge has fired and every step that precedes it through any edges has finished. A step with no incoming edge starts with its phase.
- **Parallel.** Up to four `command` and `action` steps of a run run at once. `agent` and `human` steps run one at a time, because the computer runs one session at a time and a gate binds to one result. A human gate and an action never run together.
- **Joins.** A step with several incoming edges is an and-join: it starts only when all of them have fired.
- **Failure branches.** An edge `on failure` fires when its source fails. Use it for work that should happen before the failure takes effect, such as collecting logs. It never turns the failure into a pass: when the phase settles, the failed gate still applies its `on_fail`.
- **Not reached.** A step cut off because a step it needed failed, or passed when only an `on failure` edge led to it, is recorded as Not reached with the reason, for example `Not reached: "unit" failed`. Its own outgoing edges then die in turn.
- **Operator skip.** Skipping a step counts as success for routing, and the steps before it still have to finish.
- **Outputs.** A step receives the outputs of the steps that precede it in its phase graph and of every step in earlier phases as `NESVO_OUTPUT_<STEP>_<KEY>` variables. Steps running in parallel never see each other, so results do not depend on timing. Treat outputs from agent steps as untrusted text.
- **Stop and restart.** Stop ends every running step. When the computer restarts, a running `command` becomes interrupted and a running `action` becomes uncertain, because its effect may have happened: you choose **It already ran** or **Run it again**. Resume gives interrupted and failed steps a new attempt and lets Not reached steps be re-evaluated. A run never repeats work by itself.
- **One task per project** runs at a time, and a pipeline turn starts only while no other session works on the computer.

## The graph editor

Open the Pipelines view from the sidebar. **Edit** on a row opens that pipeline on a canvas, and **New pipeline** starts an empty one.

- **Lanes.** Three horizontal lanes are the phases, with the author's implementation turn drawn as a bar between the first two. A step sits in the lane of its phase. It cannot be dragged to another lane, because `phase` lives in the shared step file; change it in the step inspector, which says how many other pipelines use the step.
- **Palette.** **Add step** lists the steps of the catalog with a search and the phase of each; **New step** creates a step. Delete removes the selection.
- **Connect.** Drag from one step's handle to another's. A refused connection shows the validation message inline. Select an edge to switch it between On success, On failure and Always.
- **Inspector.** The right panel edits what you select. A step form covers name, type, phase, skill, timeout, retries, failure behaviour, effect, needs and body, with the host's limits and messages. The pipeline form covers name, description and the free text. A pipeline that has no `edges` opens as its chain and is saved with explicit `edges` and `layout` the first time.
- **Start node.** The first node of the plan lane lists how the pipeline starts: **New thread**, and the automations that name this pipeline with their schedule and state. **Add schedule** creates an automation for it.
- **Validation.** The shared rules run while you edit: badges on steps, an issues list in the toolbar, and Save disabled while an error exists. The host checks again on save and its issues appear beside the field or step they name.
- **Run colours.** **Show last run** colours the steps by their latest attempt and opens a step's result in the inspector. The editor starts no run.
- **Save.** Ctrl+S or **Save** writes each new or changed step file and then the pipeline, each with the hash of the file you opened. Auto-layout places steps by lane and depth; Escape returns the selection to the pipeline.
- **Conflicts.** When a file changed on disk, a dialog shows its current text. **Reload** takes the new version; **Keep mine on top of the new version** saves your edits against it (when the file was deleted on disk, only **Keep mine** is offered). Nothing merges.
- **Unsaved edits.** Leaving the editor with unsaved changes asks first.

## The assistant dock

A collapsible chat in the bottom-right corner of the editor. It has a provider and model picker, keeps one conversation per computer, folder and pipeline, and shows what you typed rather than the text Nesvo wraps around it. The conversation is an ordinary visible, read-only session: it appears in the sidebar, Stop works and the history is kept.

What it can do: read your question, the open document, the selected steps and a summary of the catalog, and answer with a proposal of complete file texts, one card per file, each with a diff against the file it would replace and the host's issues.

What it cannot do: write files or change settings. The session is told not to write or run anything; Claude Code has only Read, Glob and Grep there, and Codex runs in its read-only sandbox. Nothing is written when a proposal arrives. **Apply** saves one file through the same command as the editor, with the hash of the file the diff was shown against; a conflict offers **Reload** to compare with what is on disk. **Discard** drops the card. A proposal with errors cannot be applied. While another session works on the computer, sending answers that the computer is busy and creates nothing.

Changing the provider or model starts a new conversation. The assistant sends the open pipeline only while the editor has no unsaved edits. The answer's shape is a request to the model, not a guarantee, which is why the host validates every proposal before it reaches a card.

## Automations as triggers

A pipeline file has no trigger. A task starts from the new-thread screen (the Pipeline chip) or from an automation: a scheduled job with a pipeline and a spec instead of a prompt. The job uses its provider and model in read-only mode, a worktree when the folder is a repository, and the other provider as the gate. The usual limits still apply before the start: the provider's limit gate, the busy refusal and the operator-idle rule. The job's run records the session and the pipeline run and finishes when the pipeline run settles; a missing or invalid pipeline fails the job run with a catalog reason. The Start node of the editor lists these automations and adds new ones.

## Command line

The host bundle edits the same files as the editor, with no running host and no database:

```text
node apps/host/dist/main.js pipelines validate --directory <project>
node apps/host/dist/main.js pipelines list --directory <project> --json
node apps/host/dist/main.js pipelines add-step --directory <project> --scope project --file step.md [--expected-hash <hash>]
node apps/host/dist/main.js pipelines add-to-pipeline --directory <project> --scope project --pipeline <name> --step <name> [--after <name>]
node apps/host/dist/main.js pipelines remove-from-pipeline --directory <project> --scope project --pipeline <name> --step <name>
```

`validate` prints `severity path:line: message` and exits 1 on an error. Edits keep the rest of the file byte for byte, check that every listed step exists and name the hash they read: a file that changed meanwhile is a conflict (exit 2) and nothing is written. `remove-from-pipeline` also removes the edges that name the step and reports them; `add-to-pipeline --after` moves only the `on success` edges that leave the named step to the new step. In a graph with explicit `edges`, a step added without `--after`, or into another phase, has no incoming edge and starts with its phase, possibly in parallel; removing a step does not reconnect its neighbours, so a step left without incoming edges becomes a phase start. The command prints each of these as a note. The CLI has no database, so it does not see runs in progress. Exit codes: 0 success, 1 validation errors, 2 conflict, 3 inside a pipeline run, 64 usage. Inside a pipeline run session the commands that write refuse with exit 3, so a run cannot change its own definitions.
