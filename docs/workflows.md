# Workflows

A workflow runs a task through checks you define in files. This guide is for the operator: what the files contain, how a run moves through them, and how to edit them in the graph editor, with the assistant dock or from a terminal. How the host implements this is in [architecture.md](architecture.md#workflows).

## Files and roots

Everything lives in plain Markdown files on the computer that runs the task. A remote computer reads its own files.

| Root | Folder | Holds |
| -- | -- | -- |
| Global | `~/.agents/workflows/` | `steps/*.md`, `workflows/*.md` shared by every project |
| Project | `<project>/.agents/workflows/` | `steps/*.md`, `workflows/*.md` for this project |
| Tasks | `<project>/.agents/tasks/*.md` | task specs; any Markdown file inside the project also works |

The project is the nearest folder, at or above the working directory, that contains `.git`, or the folder itself when there is none. A project step or workflow with the same name as a global one replaces it. Each file is at most 64 KiB; a root reads at most 200 steps and 100 workflows.

### Legacy location

Workflows were called pipelines before November 2026 and lived in `~/.agents/pipelines/` and `<project>/.agents/pipelines/`, with the workflow files in a `pipelines/` subfolder. Nesvo still reads those folders, read-only, and marks what it finds: the catalog carries a warning naming the legacy folder and every step or workflow read from it shows a `Legacy location` note. A file with the same name in the new root wins over the legacy one. Nothing is written to a legacy folder: saving a definition that was read from one, in the editor, the dock or the command line, writes it to `.agents/workflows/` and removes the legacy file, so a folder migrates one file at a time, or all at once when you move it yourself. A task spec may still say `pipeline:` instead of `workflow:`; the catalog warns and asks you to rename the field. The `.claude/workflows/` folder is not a Nesvo location: it belongs to a Claude Code feature with the same name.

Saving or deleting a workflow that has a run in progress is refused as busy, in the editor and the dock alike.

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
| `type` | `command`, `agent`, `human`, `action`, `wait-ci` | `command` runs a check, `agent` asks a read-only session to verify, `human` waits for your decision, `action` runs something with an effect outside the task. |
| `phase` | `plan`, `pre-done`, `pre-push` | When the step runs, see [Phases](#phases-and-author-turns). |
| `timeout` | `1s` to `4h`, for example `90s`, `15m` | Default `15m`. |
| `retries` | 0 to 5 | Default 0. `retries: 2` allows up to three attempts. The run records each attempt, then applies the normal failure route and `on_fail`. Human decisions never retry. |
| `retry_backoff` | `1s` to `4h` | Fixed delay between automatic attempts. Defaults to no delay. |
| `idempotent` | `true`, `false` | Defaults to false. Declare that repetition is safe to allow automatic retries of actions, external commands, agent steps and commands after a human gate. |
| `on_fail` | `stop`, `fix` | Default `stop`: a failure ends the run. `fix`: the run needs your attention with the failure instead of failing, and Resume runs the step again. Only the Fix decision of a `human` gate sends a correction to the author. |
| `effect` | `local`, `external` | Default `local`. Only `command` and `action` steps can be `external`; Nesvo warns when nothing asks a human first. |
| `skill` | a skill name | Only `agent` steps. An agent step needs instructions or a skill. |
| `needs` | `env:NAME`, `browser` | A missing `env:NAME` variable blocks the step with a readable reason instead of running it. `browser` is not available on this host yet and always blocks the step. |

Body by type: a `command` or `action` body is a shell script run in the task directory; an `agent` body holds the instructions for the verifying session; a `human` body is the question shown at the gate. Command and action steps do not inherit variables ending in `KEY`, `TOKEN`, `SECRET` or `PASSWORD`; list them in `needs` when a step really needs one.

### Waiting for pull request checks

A `wait-ci` step polls on the session host using the installed `gh` CLI. The body is optional. The `pr` field can contain a pull request URL, a quoted number resolved in the task folder, or `steps.<step>.outputs.<key>` resolving to either. Without it, the runner uses the task session's linked pull request. Use an upstream step for output references.

`timeout` includes time while the host is down. Set `poll_interval` between `1s` and `1m` (default `10s`). The runner records the pull request and head SHA and resumes the same attempt after restart when only CI waits were active. A changed head fails the attempt. A known failed check ends the wait early. An empty check list waits until checks appear or time expires.

Outputs are `status` (`success`, `failure` or `timeout`), `failing_checks` (newline-separated names), and `head_sha` when known. Failure and timeout follow the same routing and retry rules as other failed checks.

## The workflow file

One file per workflow, named `<name>.md`.

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
| `name`, `description` | Identify the workflow. |
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

- **Without `edges`** the workflow is a chain: inside each phase, each step follows the one before it in `steps` order and runs on its own, one step at a time. Every workflow written before graphs keeps its meaning without an edit.
- **With `edges`**, even `edges: []`, the graph is explicit: a step with no incoming edge starts as soon as its phase begins, and a step with several incoming edges waits for all of them.

## Validation in plain words

Errors make the workflow invalid: the catalog lists it only through its issues, and a save is refused.

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

- the `layout` names a step that is not in the workflow (the editor drops it on the next save);
- an `external` step, or a body that mentions `git push`, `gh pr`, `curl` or `wget`, that some path reaches without a human step first;
- the workflow has no gate at all, or a `fix` step has no retries;
- two agent steps of one phase could start together, while the computer runs one session at a time.

## Phases and author turns

A task is a spec run through one workflow. Starting it creates one ordinary session, optionally in its own Git worktree and branch (a worktree needs the folder to be the top level of a Git repository). The phases and the author's turns alternate:

1. **Plan.** When the workflow has an `agent` or `human` step in `plan`, the author first answers a planning turn without changing files. Then the `plan` steps run.
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
- **One task per project** runs at a time, and a workflow turn starts only while no other session works on the computer.

## The graph editor

Open the Workflows view from the sidebar. **Edit** on a row opens that workflow on a canvas, and **New workflow** starts an empty one. The editor is a node-graph builder: steps are cards on an infinite dot-grid canvas, connections flow from left to right, and the file stays the source of truth.

- **Canvas.** A **Start** node on the left names how the workflow starts (a manual run from a new thread, and the automations that schedule it). An empty workflow shows one **Add first step** card next to it. Steps are cards of the same size with a type icon tile, the step name, its phase and command, skill or decision as a second line, and a status dot. A dashed frame groups the steps of each phase and labels it; the author's implementation turn is drawn between the Plan frame and the next one. Positions are free: drag a card anywhere, pan with the mouse or with Space held, zoom with the wheel. The controls in the bottom-left corner zoom, fit the view, toggle a minimap and tidy up the layout by phase and depth.
- **Adding steps.** Every free output has a **+** button, and so does the Start node. It opens a node picker with a search and five groups: Triggers (on the Start node), Checks, Agents, Approvals and Actions. Pick a step from the catalog to add it connected to the source, or **New check**, **New agent step**, **New approval** or **New action** to create one in the inspector; it joins the graph when you save the step form. A catalog step of another phase is added without a connection and the editor says why.
- **Connections.** Drag from a card's right handle to another card's left handle. The lower, red handle of a command, agent or action card is its failure output; a connection from it runs **On failure**. Hovering a connection shows a **+** that inserts a step between its ends and a trash button that removes it. Selecting a connection opens its inspector to switch it between On success, On failure and Always. A refused connection shows the validation message inline.
- **Hover actions.** Hovering a card shows Duplicate and Remove. Duplicate creates a new step file from the card; Remove takes the card and its connections out of the workflow and never deletes the step file.
- **Inspector.** The right panel slides in for the selection. A step form covers name, type, phase, skill, timeout, retries, failure behaviour, effect, needs and body, with the host's limits and messages and the count of other workflows that use the step. The Start form lists the automations and adds a schedule. **Settings** in the top bar opens the workflow form: name, description, scope and the free text. Escape closes the panel.
- **Top bar.** The workflow name is edited in place. Next to it the editor says Saved, Unsaved changes or Saving. Undo and Redo walk the edit history. **Last run** toggles the run overlay, **Validate** lists the issues, **Run** starts a task through this workflow and **Save** writes the files.
- **Run.** **Run** picks a task spec that names this workflow, the author provider and model and whether to isolate the task in a Git worktree; the gate is the other provider with its default model. The author works read-only. The editor must be saved and without errors first.
- **Run overlay.** While a run of this workflow exists, each card shows the state of its latest attempt: a spinner while running, a check when passed, a cross when failed, a hand while it waits for you, and the attempt count when a step ran more than once. Clicking a card opens the step result in the inspector. The overlay starts no run and follows the latest run of this workflow in this folder.
- **Keyboard.** Delete removes the selection, Ctrl+Z and Ctrl+Y undo and redo, Ctrl+S saves, Ctrl+D duplicates the selected step, Space with a drag pans, Escape closes the inspector or the picker.
- **Validation.** The shared rules run while you edit: badges on steps, an issues list under the top bar, and Save disabled while an error exists. The host checks again on save and its issues appear beside the field or step they name.
- **Save.** Ctrl+S or **Save** writes each new or changed step file and then the workflow, each with the hash of the file you opened. A workflow that has no `edges` opens as its chain and is saved with explicit `edges` and `layout` the first time.
- **Conflicts.** When a file changed on disk, a dialog shows its current text. **Reload** takes the new version; **Keep mine on top of the new version** saves your edits against it (when the file was deleted on disk, only **Keep mine** is offered). Nothing merges.
- **Unsaved edits.** Leaving the editor with unsaved changes asks first.

## The assistant dock

A chat in the bottom-right corner of the Workflows list, the Automations list and the graph editor. It collapses to one round button and can be resized from its top-left corner. The header names its subject: the open workflow, Workflows or Automations. The composer is the one from a session: Enter sends, Shift+Enter adds a line, the model chip opens the same picker as a new thread with the providers, a search, the models the computer reports and the reasoning effort when the provider has one, and Stop ends the turn in progress. An empty conversation offers a few prompts to start from. **New chat** starts another conversation; the history button lists the earlier ones of the same computer, folder and subject.

The conversation is an ordinary visible, read-only session: it appears in the sidebar, Stop works, the history is kept and **Open session** shows the full transcript.

What it can do: read your question, the open document, the selected steps, a summary of the catalog and the automations of the folder, and create, change or delete steps, workflows and automations while it answers. Each change is saved as soon as the assistant writes it and appears at once: a new card on the canvas (marked **Assistant**), a new row in the Workflows list and a new automation in the Automations list (marked **Added by assistant**), until you select it. Every change is also listed under the turn as a card with **Undo**; the host keeps the history of the conversation's changes and the dock loads it when a conversation opens, so a change can be taken back later too. Undo restores the exact previous file or automation, or removes what the assistant created. An automation created by the assistant starts **disabled** and shows an **Enable** action in the list; the assistant never starts work on its own.

What it cannot do: change project code, run commands or enable an automation. A workflow it saves cannot reach an external action, such as a `git push`, without a human step before it; that is a refusal, not a warning. Every change goes through the same checks as a save from the editor: when a file changed since the assistant read it, when the result is invalid or when a step is still used by a workflow, the change is refused, nothing is written and the reason shows under the turn. Undo is refused the same way when the file or automation changed after the assistant's change, so newer content is never overwritten. The session itself cannot write: Claude Code has only Read, Glob and Grep there, and Codex runs in its read-only sandbox; the host applies the changes the assistant describes. While another session works on the computer, sending answers that the computer is busy and creates nothing.

Changing the provider or model starts a new conversation. The assistant sends the open workflow only while the editor has no unsaved edits. Quoted files and catalog entries are data for the assistant, not instructions.

## Automations as triggers

A workflow file has no trigger. A task starts from the new-thread screen (the Workflow chip) or from an automation: a scheduled job with a workflow and a spec instead of a prompt. The job uses its provider and model in read-only mode, a worktree when the folder is a repository, and the other provider as the gate. The usual limits still apply before the start: the provider's limit gate, the busy refusal and the operator-idle rule. The job's run records the session and the workflow run and finishes when the workflow run settles; a missing or invalid workflow fails the job run with a catalog reason. The Start node of the editor lists these automations and adds new ones.

### Watching command output

In an automation's editor, turn on **Run only when this changes**, choose its folder and enter the executable and arguments as a JSON array. For example, `["git", "rev-parse", "HEAD"]` watches the checked-out commit. The host starts the executable directly in the selected folder with its own account. Use a command intended to read the state you want to watch.

The first successful check records a baseline. The host normalizes line endings and trims trailing whitespace before hashing stdout. A later check triggers a run only if its hash differs from the previous successful check. Each command has 10 seconds and a 64 KiB limit per output stream. Timeouts, excess output and nonzero exit codes appear under **Last check** in the automation detail. The host persists the hash and status and discards the output. After downtime, the host checks once for the latest due occurrence.

**Ask before starting** is on by default. The Inbox keeps one pending request per automation. Use **Start** or **Skip** on that row. Later changes still update the baseline while a request is pending. When asking is off, the existing host availability and idle rules apply. A started run follows the existing automation result flow to the Inbox.

The cap defaults to three starts per UTC day and accepts values from 1 to 24. Run now is an explicit start and counts toward the same cap. Reaching the cap consumes the observed change, so a new change is required for another scheduled start. A pending request can be started on a later day with capacity. Editing or pausing the automation clears its pending request. Changing the folder or command resets the baseline.

## Command line

The host bundle edits the same files as the editor, with no running host and no database:

```text
node apps/host/dist/main.js workflows validate --directory <project>
node apps/host/dist/main.js workflows list --directory <project> --json
node apps/host/dist/main.js workflows add-step --directory <project> --scope project --file step.md [--expected-hash <hash>]
node apps/host/dist/main.js workflows add-to-workflow --directory <project> --scope project --workflow <name> --step <name> [--after <name>]
node apps/host/dist/main.js workflows remove-from-workflow --directory <project> --scope project --workflow <name> --step <name>
```

`pipelines` is accepted as an alias of the `workflows` command for scripts written before the rename.

`validate` prints `severity path:line: message` and exits 1 on an error. Edits keep the rest of the file byte for byte, check that every listed step exists and name the hash they read: a file that changed meanwhile is a conflict (exit 2) and nothing is written. `remove-from-workflow` also removes the edges that name the step and reports them; `add-to-workflow --after` moves only the `on success` edges that leave the named step to the new step. In a graph with explicit `edges`, a step added without `--after`, or into another phase, has no incoming edge and starts with its phase, possibly in parallel; removing a step does not reconnect its neighbours, so a step left without incoming edges becomes a phase start. The command prints each of these as a note. The CLI has no database, so it does not see runs in progress. Exit codes: 0 success, 1 validation errors, 2 conflict, 3 inside a workflow run, 64 usage. Inside a workflow run session the commands that write refuse with exit 3, so a run cannot change its own definitions.
