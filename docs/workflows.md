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

## Lessons and gate rules

Owner lessons and gate rules are short rule entries stored as files in the same roots: `<root>/lessons/<id>.md` for lessons and `<root>/gate-rules/<id>.md` for gate rules. The folder decides the entry type; IDs are `lesson-NNNN` and `rule-NNNN`, assigned by the host and never reused. The files are the source of truth; the host database keeps only incidents and per-entry delivery counts. The schema, parser and serializer are shared in `packages/contracts/src/rule-entries.ts`.

```markdown
---
id: lesson-0007
description: "Applies when editing host persistence code. Bump the database version together with every schema-version assertion."
kind: instruction
scope:
  providers: ["claude", "codex"]
  workflows: ["pre-push"]
  steps: ["review"]
  paths: ["apps/host/src/**"]
status: active
enforcedBy: "none"
review: 2026-12-18
provenance:
  source: incident
  incidents: ["0b9c..."]
  session: 8f9c...
  date: 2026-11-18
  quote: "The newer database test still expects the old version."
---

Bump the database version in the same commit as every assertion that names it.
Why: parallel branches collided on the same version.
Check: the version assertions in the host tests show one value.
```

| Field | Meaning |
| -- | -- |
| `id` | Matches the file name. |
| `description` | Required, at most 200 characters, third person, starts with "Applies when". The only text always added to prompts. |
| `kind` | `instruction` for an agent, or `check` for a deterministic command or lint rule offered as a suggestion. |
| `scope` | All keys optional: `providers` (`claude`, `codex`), `roles` (`standalone`, `orchestrator`, `worker`, `workflow-agent`, `reviewer`), `workflows`, `steps` and `paths` (globs). An empty scope means every session of the root; a project root applies only to sessions inside that project. |
| `status` | `active` or `retired`. Retiring keeps the ID. |
| `enforcedBy` | `none`, `lint:<rule>`, `test:<file>` or `ci:<job>`. Enforced entries are not added to prompts. |
| `review` | Optional date. On that day the entry stops being added to prompts and returns to the Inbox until the owner keeps or retires it. |
| `provenance` | Assembled by the host: `source`, cited `incidents`, `run`, `step`, `session`, `decision`, `date` and a `quote` of at most 400 characters. |

The body has at most 600 characters: the rule in one to three imperative sentences, a `Why:` line and a `Check:` line as the last line. Leave out dates, hashes, versions and counts.

Prompts receive an index of matching `id: description` lines (at most 20 lines and 2,000 characters) and the full bodies only of entries whose `steps`, `workflows` or `paths` match the current step or files (at most six bodies and 3,000 characters). Retired entries, entries past their review date and entries with `enforcedBy` are never added. Nesvo writes these files only when the owner decides in the Inbox or in Settings > Lessons, through the same checked and undoable path as assistant changes. A lesson file in a project is added to prompts only after the owner approved its current text on this computer.

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
| `type` | `command`, `check`, `agent`, `human`, `action`, `wait-ci`, `until`, `probe`, `session`, `fan-out` | Use `session` to run one child workflow and `fan-out` to run a child workflow for each item in a list. |
| `phase` | `plan`, `pre-done`, `pre-push` | When the step runs, see [Phases](#phases-and-author-turns). |
| `timeout` | `1s` to `4h`, for example `90s`, `15m` | Default `15m`. |
| `retries` | 0 to 5 | Default 0. `retries: 2` allows up to three attempts. The run records each attempt, then applies the normal failure route and `on_fail`. Human decisions never retry. |
| `retry_backoff` | `1s` to `4h` | Fixed delay between automatic attempts. Defaults to no delay. |
| `idempotent` | `true`, `false` | Defaults to false. Declare that repetition is safe to allow automatic retries of actions, external commands, agent steps and commands after a human gate. |
| `on_fail` | `stop`, `fix` | Default `stop`: a failure ends the run. `fix`: the run needs your attention with the failure instead of failing, and Resume runs the step again. Only the Fix decision of a `human` gate sends a correction to the author. |
| `effect` | `local`, `external` | Default `local`. Only `command` and `action` steps can be `external`; Nesvo warns when nothing asks a human first. |
| `skill` | a skill name | Only `agent` steps. An agent step needs instructions or a skill. |
| `needs` | `env:NAME`, `browser` | A missing `env:NAME` variable blocks the step with a readable reason instead of running it. `browser` runs an `agent` step whose step and workflow are defined in your own workflows folder with browser access when its provider supports it on this computer (Claude Code with the browser extension); otherwise, on other step types and for steps defined in the repository, the step is blocked with the reason. An unattended browser step can open and read pages but cannot click, type, run scripts or take screenshots. |

Body by type: a `command` or `action` body is a shell script run in the task directory; an `agent` body holds the instructions for the verifying session; a `human` body is the question shown at the gate. Command and action steps do not inherit variables ending in `KEY`, `TOKEN`, `SECRET` or `PASSWORD`; list them in `needs` when a step really needs one.

### Portable test checks

A `check` step runs tests selected for the task checkout. A Global workflow can use the same step across projects. Project settings live in the repository and Global settings live in the owner's Nesvo configuration.

```yaml
name: verify-tests
type: check
phase: pre-done
intent: tests
preferred:
  typescript: { runner: package-script, script: test }
  kotlin: { runner: gradle-wrapper, task: test }
timeout: 5m
on_fail: fix
```

Write the acceptance criteria in the Markdown body. For example, require the suite that covers the changed code and evidence of at least one executed test. In the step inspector, **Preferred commands** is optional and starts collapsed. Add a row to prefer a candidate from a registered stack detector. Without preferences the verifier picks from what the project offers. The host inventories one module per run. It reads `package.json` scripts and package manager signals, Gradle wrapper inputs and static Gradle tasks, test commands in supported CI files, Makefile, justfile and Taskfile targets, and README or CONTRIBUTING examples. The host reads these files without evaluating build or CI configuration. A read-only verifier selects a candidate ID from that inventory.

A mixed checkout can locate its module and prefer a known target with `.agents/project.md`. A Gradle task such as `:app:test` implies module `app` unless you set `module`.

```yaml
---
stack: kotlin
module: app
checks:
  tests: { runner: gradle-wrapper, task: ':app:test' }
---
```

When the host has no suitable candidate, the verifier can propose a single local test command with a source reference. The Inbox shows its command, working folder, provenance and reason. Approval saves the mapping in `.agents/project.md` in the run checkout and permits the command to run. Later runs on this computer can reuse the approved mapping hash for that project. A new or edited command mapping needs its own approval. Use **Undo Project mapping** in **Last run** to restore the previous file if its hash still matches. Inbox workflow-step and command holds apply to each actual invocation.

A known setup mismatch can select one alternate of the same test scope. A failed suite follows the normal failure edge and `on_fail`. A zero exit must also produce evidence that tests ran, such as a positive runner count or fresh Gradle test reports. **Last run** shows the stack, chosen check, selection and substitution reasons, exact invocation, exit code and suite evidence. Expand **Details** for source references and hashes. Check commands use the same local process boundary and permissions as command steps. Use trusted project scripts and build files.

### Waiting for pull request checks

A `wait-ci` step polls on the session host using the installed `gh` CLI. The body is optional. The `pr` field can contain a pull request URL, a quoted number resolved in the task folder, or `steps.<step>.outputs.<key>` resolving to either. Without it, the runner uses the task session's linked pull request. Use an upstream step for output references.

`timeout` includes time while the host is down. Set `poll_interval` between `1s` and `1m` (default `10s`). The runner records the pull request and head SHA and resumes the same attempt after restart when only CI waits were active. A changed head fails the attempt. A known failed check ends the wait early. An empty check list waits until checks appear or time expires.

Outputs are `status` (`success`, `failure` or `timeout`), `failing_checks` (newline-separated names), and `head_sha` when known. Failure and timeout follow the same routing and retry rules as other failed checks.

### Repeating a sequence

An `until` step follows the steps it repeats. Set `repeat` to their names in order, `condition` to a string comparison and `max_iterations` to a number from 1 to 20. The following step checks the output of `read-status`.

```yaml
name: ready
type: until
phase: pre-done
repeat: [read-status]
condition: 'steps.read-status.outputs.state == "ready"'
max_iterations: 4
```

Connect the body and the loop control in one same-phase success chain. The body can receive incoming edges at its first step, and exits go from the control step. Loops cannot overlap or nest. Only a current iteration's output can satisfy the condition. A missing output does not match either comparison. A body failure follows the normal failure route. When the limit is reached without a match, the control step fails.

The run records both the iteration and the attempt. Shell steps in the body receive `NESVO_STEP_ITERATION`, starting at 1. Each iteration has its own retry allowance. Include a human gate in the repeated sequence when each repetition needs a decision.

### Probing the current diff

A `probe` step reads the current Git diff in the task directory without opening a model turn. It compares staged and working files with the task worktree's recorded base, or with `HEAD` for a run without an isolated worktree. It includes unignored untracked regular files. Patch input is bounded to 2 MiB, 80 untracked files and 10 seconds. Incomplete scans report a finding and set `complete` to `false`.

Set `probe` to `all` (default), `secrets`, `personal-data`, `test-integrity` or `change-size`. Findings include common credential assignments, tokens and private keys, email and phone patterns, checksum-validated IBAN and national IDs (PESEL, DNI/NIE and labeled NIF), removed assertions, skipped or focused tests, and signs that lint, type or CI enforcement changed. A diff above 20 files or 500 changed lines includes a split suggestion. Findings are signals for review. The run records the finding and changed-file counts and a bounded set of locations with masked values.

Connect the probe to an agent in the graph. The next downstream agent sees the upstream findings and must justify each one or identify the fix required. Separate phases can also pass findings forward. The agent remains read-only and can report a required correction, which fails its step. The probe itself passes even when it reports findings. View the findings on the probe result and the assessments in the agent result. For large sets the agent also receives a grouped item for the overflow. Probe-review turns send masked context and display the reviewed findings and sanitized assessments in the workflow result.

### Running a child workflow

A `session` step starts a child of the run's session and waits for its workflow. The `session` mapping names the `workflow`, `provider`, `model`, `mode` and `title`. Set `effort` when you want a provider-specific effort. Set `directory` to an absolute path or a path relative to the parent run folder. The default is the parent run folder. With `worktree: true`, the host creates a session worktree from that checkout and uses its configured worktree recipe and existing approval flow.

The body is the first prompt. In the body or title, `{{ steps.prepare.outputs.task }}` expands to the named value from an upstream step. A missing value fails that item. A child runs the named workflow with its own provider session and permission mode. A workflow with a planning gate uses the prompt as the task for that gate. The default nesting depth is two child levels. Set `max_depth` on a child step to choose a limit from one to eight. A descendant can lower an inherited limit.

A child report records the workflow status, a summary from the author reply or failure, pull request links, recent step notes and outputs. The parent stores the report in `result.items` and exposes its status, summary, session ID, first pull request (`pr`) and bounded output values as step outputs. The sidebar and Subsessions show the children, including children in separate worktrees.

### Running child workflows for a list

A `fan-out` step uses the same session mapping and body for each item. Specify one `items` source.

| Source | Fields | Input |
| -- | -- | -- |
| Inline | `kind: inline`, `values` | A list of strings or flat objects. |
| File | `kind: file`, `path` | A UTF-8 Markdown table or JSON list up to 64 KiB inside the run folder. The first Markdown table supplies the column names and rows. |
| Output | `kind: output`, `reference` | An upstream `steps.<step>.outputs.<key>` value containing a JSON list. |

The list has up to 32 items. Use `{{ item }}` for a string or JSON object, `{{ item.id }}` for a field or table column, and `{{ index }}` for the one-based position. The `policy` mapping requires `max_parallel`, `min_free_ram_mb`, `min_plan_remaining_percent` and `on_fail`. The host checks free RAM in MiB, provider sign-in and the lowest reported remaining plan window before starting each item. Set `max_cpu_load_percent` to also check CPU usage across all cores. With `soft_limit`, slots beyond that threshold require 25% more free RAM, an additional 10 percentage points of plan allowance up to 100%, and at most 80% of the configured CPU cap when present.

The run lists queued items and the reason they are waiting. Items start as capacity and gates allow. Running children keep their slots until their workflows settle. Folder locks still apply to child turns. On failure, `continue` finishes the batch and reports individual failures, `stop-remaining` skips queued items and fails after active children finish, and `fail-run` stops active children, skips further launches and fails immediately. An item object or table row can override the policy using its `on_fail` field. The result contains every item and its report in input order, plus `total` and `passed` outputs. The `items` text output is available when its JSON fits the normal output limit.

The step timeout includes queued time and time while the host is down. Stop on the parent run stops its children and clears the queue. On restart, a running step reconnects to recorded children, keeps completed reports, and marks items that never started as interrupted. An interrupted provider turn stays interrupted. A child already waiting for human input can still receive that decision. Child steps have no automatic retries.

#### Example orchestrator

Save this as `.agents/workflows/workflows/orchestrate-stages.md`.

```yaml
---
name: orchestrate-stages
steps: [dispatch-stages]
---
```

Save the following step as `.agents/workflows/steps/dispatch-stages.md`. The prompt starts with each stage's ID and task.

```markdown
---
name: dispatch-stages
type: fan-out
phase: pre-done
timeout: 2h
session:
  workflow: worker-gates
  provider: Codex
  model: default
  mode: supervised
  worktree: true
  title: "Stage {{ item.id }}"
items:
  kind: file
  path: stages.md
policy:
  max_parallel: 4
  soft_limit: 2
  min_free_ram_mb: 2048
  min_plan_remaining_percent: 20
  max_cpu_load_percent: 75
  on_fail: stop-remaining
---
Implement stage {{ item.id }}. {{ item.task }}
```

Put `stages.md` in the run folder.

```markdown
| id | task |
| --- | --- |
| W1 | Add the parser and run its integration check. |
| W2 | Wire the inspector and verify its empty state. |
```

Save `.agents/workflows/workflows/worker-gates.md` with `name: worker-gates` and `steps: [inspect-diff, approve-result]` in its frontmatter. Define `inspect-diff` as a `probe` and `approve-result` as a `human` step, both in `pre-done`. The human step's body explains what to review. Add a task spec with `workflow: orchestrate-stages` and run it from the editor. Keep the steps and stage table in the checkout when running the orchestrator in a worktree.

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
| `decisions` | Optional: `inbox`, `parent` or `both`. Where decisions of child sessions started by this workflow appear, see [Routing decisions to the orchestrator](#routing-decisions-to-the-orchestrator). |
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

### Conditional routes

Append `when` to an edge to compare the pinned `stack` or an upstream output against a JSON string using `==` or `!=`. Quote the complete YAML edge when its condition contains YAML punctuation.

```yaml
edges:
  - 'inspect -> js-check when stack == "typescript"'
  - 'inspect -> kotlin-check when stack == "kotlin"'
  - js-check -> results
  - kotlin-check -> results
```

Use `join: reached` on `results` to omit routes disabled by a false condition. It waits for all active inputs and requires at least one. A failed active input still has to satisfy its outcome. A missing condition input needs attention. Use `required: true` to require a step to pass even on conditional graphs. Human and CI gates are required on these graphs.

### Light and full lanes

Declare both lanes to classify a plan before implementation. Name one optional pre-done agent review for the light lane. Common checks remain required, and successors of the deep review use a reached join with a common input.

```yaml
lanes:
  light: { omit: deep-review, max_changed_files: 5, max_changed_lines: 100 }
  full: {}
```

The Run menu lets you choose full in advance. The host also chooses full when a plan is uncertain or a saved diff is incomplete, touches protected files or exceeds the light limits. Full remains in effect after corrections. The run inspector shows the effective lane and its reason.

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
- an `external` step, or a body that mentions `git push`, `gh pr`, `curl` or `wget`, that some path reaches without a human step first and that no enabled Inbox rule holds (see [Inbox rules and human steps](#inbox-rules-and-human-steps));
- the workflow has no gate at all, or a `fix` step has no retries;
- two agent steps of one phase could start together, while a run drives one author session at a time.

## Inbox rules and human steps

A `human` step is an explicit point in one workflow: the run stops there, binds to the latest saved result and offers accept, reject or fix. An Inbox rule is cross-cutting: it applies to every session it matches, whatever started it, and can hold a command, a pull request action, an MCP tool call or a workflow step before it happens, or put an event in your Inbox. Use a human step when the workflow itself has a decision point; use a rule for a habit that should hold everywhere, such as reviewing the diff before any `git push`. Rule files and their fields are described in [architecture.md](architecture.md#inbox-rules) and edited in Settings › Inbox rules.

A rule with `trigger: workflow-step` names a `step` (a name glob), a `phase` or both, and optionally a `workflow`:

```markdown
---
name: hold-before-publish
trigger: workflow-step
phase: pre-push
action: hold
show: [diff]
diff: branch
---
{{ session.title }} reached {{ step }} in {{ workflow }}.
```

With `action: hold` the step waits before it runs until you approve or decline it in the Inbox; a decline fails the step with your note, and a restart keeps the hold pending. The decision belongs to that attempt: a retry asks again. The validator warning about an external action without a human step is not shown when an enabled global or project rule holds that step (`hold` on `workflow-step` with a matching step, phase and workflow). A project rule counts for this warning while it is enabled, but it holds at run time only after you trust the repository.

### Typed gate decisions

A human step can set `decision: { kind: binary }`, `kind: choice` with an array of `{ id, label }` options, `kind: files` for the saved diff, or `kind: fields` with declared text, number and boolean fields. The host pins the form and review version for the attempt. The Inbox and run inspector use the same form. A partial file approval records exactly the selected paths and leaves the full saved review pending. An external step requires a complete decision.

### Gate recommendations

A human step can reference a Global owner policy with `delegate: low-risk-pr`. The host reads `policies/low-risk-pr.md` from the Global workflows root. Set version 1, exact repository, workflow, gate, lanes and target branches, required green CI and named checks, protected path globs and file and line limits. The default mode is observe. A read-only recommendation appears as Would approve or Needs approval in the gate.

To authorize automatic acceptance of the bound saved result at a terminal gate, use `mode: enabled`, allow `accept-result` and place a host-local `workflow-policy-activations/low-risk-pr.json` file in the host data directory. It names the reviewed `policyHash`, `repository`, `workflow` and `gate`. Removing the activation or changing the policy revokes automatic acceptance. GitHub actions still require their existing operator flow.

### Learning from recorded runs

Repeated successful test substitutions can propose a Project command mapping. A Fix or Reject comment containing `Route: <source> -> <optional-agent-review> when stack == "typescript"` can propose adding a condition to that existing edge. The gate learning queue allows two suggestions per settled run. Review a proposal in the Inbox and choose Accept, Edit or Dismiss. The host rechecks the source hashes and validates edits through the assistant writer. Accepted changes can be undone.

### Decision memory

Decision memory starts off. Enable **Remember workflow decisions** under **Workflows** in Settings to propose precedents on this computer. A workflow can independently set `decision_memory: review` to propose its own precedents or `decision_memory: automatic` to save them after each operator decision. Review proposals use Accept, Edit and Dismiss in the Inbox. Undo keeps its hash check.

An accepted precedent lives in `decisions/` under the workflow's Project or Global root. It records the chosen outcome, bounded owner comment, gate context, source run and evidence identities. Open **Lessons & decisions** in the workflow editor to filter applicable entries by step and see usage and source links. The host delivers accepted precedents to verifiers and to policy recommendations as quoted historical data.

### Gate autonomy

Select a human step and open the workflow assistant to review its autonomy. Level 0 asks for a decision. Level 1 adds a read-only recommendation with applicable precedents. Level 2 can focus a file selection on the uncertain paths, with the complete changed files list available. Level 3 shows the agreement between valid recommendations and owner decisions. Level 4 requires an enabled hash-bound owner policy and can accept an eligible terminal saved result.

Open **Review level change** to see whether the agreed decisions in the configured window support the next level. Accept each increase explicitly. A dismissal hides that suggestion until the decision evidence changes. If you override a policy approval, the current bound result is rejected, the previous decision remains in its audit record, and the gate drops one level with your reason.

### Gate trust

Read and edit **Why is this gate human?** in its step inspector or under **Lessons & decisions** filtered to that step. Record the reason a person is needed, such as critical paths, missing tests or a two-person rule. Select **Always require a person** to enforce a continuing human requirement. When memory is enabled, expand the past cases to see which appeared suitable for automation, which still needed a person, and the recorded lane, phase, diff and test evidence behind the comparison. Each case links to its source run when one is available.

With the gate selected, open the workflow assistant and choose **What would I need to make this gate more autonomous?** The assistant answers from recorded cases. When a split separates the cases, the proposal shows a `when` lane condition, diff limits, required passing steps and protected paths. Preview edits to see how many past cases each branch would take, then accept or dismiss. The accepted split routes the existing gate between policy review and a person. Policy activation and all execution safeguards still apply. Unknown factors, unsatisfied conditions and changed definitions go to the person. A dismissed suggestion stays hidden until the decision evidence changes.

### Routing decisions to the orchestrator

A workflow file may set `decisions` to `inbox`, `parent` or `both`. Children started by a `session` or `fan-out` step of that workflow carry the route, so their plans, questions, operation approvals and rule items appear as cards in the orchestrator's conversation instead of, or as well as, the Inbox. A rule's own `route` wins over the workflow; a session group default and the computer default in Settings › Inbox rules apply when neither says.

```yaml
---
name: orchestrate-stages
decisions: parent
steps: [dispatch-stages]
---
```

With the `dispatch-stages` step and the `worker-gates` children from the example above, a stage child that runs `git push` under a hold rule shows a card in the orchestrator session with its name, the command and the diff. Approve or Decline there: the child resumes with the outcome, its history records the decision as made by you in the parent session, and the orchestrator agent receives `decision-needed` and `decision-made` events so it can keep coordinating. The orchestrator agent cannot approve the hold itself.

## Phases and author turns

A task is a spec run through one workflow. Starting it creates one ordinary session, optionally in its own Git worktree and branch (a worktree needs the folder to be the top level of a Git repository). The phases and the author's turns alternate:

1. **Plan.** When the workflow has an `agent` or `human` step in `plan`, the author first answers a planning turn without changing files. Then the `plan` steps run.
2. **Implementation turn.** The author works from the spec and the plan.
3. **Before done** (`pre-done`). The steps check the result: tests, lint, review, a human gate.
4. **Before push** (`pre-push`). The last steps before anything leaves the machine: a final gate, a push action.

The run passes when the last phase passes. A `human` gate binds to the latest saved result and offers accept, reject or fix. Fix sends your comment to the author as one correction turn and runs the checks again; reject ends the run. Nothing is replayed: a turn is sent once, and a run that was interrupted continues only when you resume it.

## How a run moves through a graph

- **Ready steps.** A step starts when every incoming edge has fired and every step that precedes it through any edges has finished. A step with no incoming edge starts with its phase.
- **Parallel.** Up to four non-agent checks and actions can run at once. `agent` and `human` steps run one at a time, because a run drives one author session and a gate binds to one result. A human gate and an action never run together.
- **Joins.** A step with several incoming edges is an and-join: it starts only when all of them have fired.
- **Failure branches.** An edge `on failure` fires when its source fails. Use it for work that should happen before the failure takes effect, such as collecting logs. It never turns the failure into a pass: when the phase settles, the failed gate still applies its `on_fail`.
- **Not reached.** A step cut off because a step it needed failed, or passed when only an `on failure` edge led to it, is recorded as Not reached with the reason, for example `Not reached: "unit" failed`. Its own outgoing edges then die in turn.
- **Operator skip.** Skipping a step counts as success for routing, and the steps before it still have to finish.
- **Outputs.** A step receives the outputs of the steps that precede it in its phase graph and of every step in earlier phases as `NESVO_OUTPUT_<STEP>_<KEY>` variables. Steps running in parallel never see each other, so results do not depend on timing. Treat outputs from agent steps as untrusted text.
- **Stop and restart.** Stop ends every running step. When the computer restarts, a running `command` becomes interrupted and a running `action` becomes uncertain, because its effect may have happened: you choose **It already ran** or **Run it again**. Resume gives interrupted and failed steps a new attempt and lets Not reached steps be re-evaluated. A run never repeats work by itself.
- **One task per project** runs at a time. Tasks in different projects or worktrees run together; a workflow turn waits only while another session or a folder operation holds the folder of its session.

## Live flows

Open **Flows** from Workflows or choose **Open Flows** in the command palette. Each project on each computer has one section per live workflow. Graphs use the steps and connections pinned by their live runs, including when runs use different revisions of the same workflow. The shared zoom controls apply to every graph. **Fit graphs** fits the widest graph to the available space. Runs between steps appear above their graph, aligned with its left edge. Runs that require attention or can be resumed stay visible. Sessions disappear when they are archived or deleted.

A row opens its session. It shows the session title, elapsed time and the linked pull request when present. Use the title template on a list-driven step to include a stage ID, such as `Stage {{ item.id }}`. An active run can occupy several parallel steps. Workflow counts count each session once, and agent counts reflect provider turns in progress. Steps omit zero counts and show their kind when idle. Children of a `session` or `fan-out` step appear under the step that started them, including settled children while that step is still current. Hover over or focus a child row to see its workflow and current step. Live child workflows also have their own graphs.

The **Orchestration** section groups live ad hoc coordinators by computer. Each tree shows the coordinator, its direct children and grandchildren when the computer allows nested coordination. Settled children stay visible while work, a decision or a recovery is outstanding elsewhere in their tree. Sessions without children appear only as part of an orchestration tree or workflow graph.

An orchestration row shows the provider, title, status and elapsed time. A linked pull request and an Inbox decision each have their own action. Decisions routed to a parent conversation open that conversation. Coordinators show **Waiting for children**, **Updates waiting** or **Continue required** when applicable. A workflow row with child orchestration can jump to the corresponding branch in Flows.

The view follows session, workflow, Inbox and coordinator wake events. A disconnected computer shows its last known state with an Offline label.

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

What it cannot do: change project code, run commands or enable an automation. A workflow it saves cannot reach an external action, such as a `git push`, without a human step before it; that is a refusal, not a warning. Every change goes through the same checks as a save from the editor: when a file changed since the assistant read it, when the result is invalid or when a step is still used by a workflow, the change is refused, nothing is written and the reason shows under the turn. Undo is refused the same way when the file or automation changed after the assistant's change, so newer content is never overwritten. The session itself cannot write: Claude Code has only Read, Glob and Grep there, and Codex runs in its read-only sandbox; the host applies the changes the assistant describes. While another session writes in the folder, sending answers that the folder is in use and creates nothing.

Changing the provider or model starts a new conversation. The assistant sends the open workflow only while the editor has no unsaved edits. Quoted files and catalog entries are data for the assistant, not instructions.

## Automations as triggers

A workflow file has no trigger. A task starts from the new-thread screen (the Workflow chip) or from an automation: a scheduled job with a workflow and a spec instead of a prompt. The job uses its provider and model in read-only mode, a worktree when the folder is a repository, and the other provider as the gate. The usual limits still apply before the start: the provider's limit gate, one task per project and the operator-idle rule. Other sessions on the computer do not hold the job back. The job's run records the session and the workflow run and finishes when the workflow run settles; a missing or invalid workflow fails the job run with a catalog reason. The Start node of the editor lists these automations and adds new ones.

### Watching command output

In an automation's editor, turn on **Run only when this changes**, choose its folder and enter the executable and arguments as a JSON array. For example, `["git", "rev-parse", "HEAD"]` watches the checked-out commit. The host starts the executable directly in the selected folder with its own account. Use a command intended to read the state you want to watch.

The first successful check records a baseline. The host normalizes line endings and trims trailing whitespace before hashing stdout. A later check triggers a run only if its hash differs from the previous successful check. Each command has 10 seconds and a 64 KiB limit per output stream. Timeouts, excess output and nonzero exit codes appear under **Last check** in the automation detail. The host persists the hash and status and discards the output. After downtime, the host checks once for the latest due occurrence.

**Ask before starting** is on by default. The Inbox keeps one pending request per automation. Use **Start** or **Skip** on that row. Later changes still update the baseline while a request is pending. When asking is off, the existing host availability and idle rules apply. A started run follows the existing automation result flow to the Inbox.

The cap defaults to three starts per day in the automation's time zone and accepts values from 1 to 24. Run now is an explicit start and counts toward the same cap. Reaching the cap consumes the observed command change, so a new change is required for another scheduled start. A pending request can be started on a later day with capacity. Editing or pausing the automation clears its pending request. Changing the folder or command resets the baseline.

### Scheduled rituals

New automations use the operator's OS time zone. Choose a different IANA zone such as `Europe/Warsaw` in the editor. Daily and weekly schedules follow local wall time through daylight saving changes. Intervals measure elapsed time. Scheduling runs inside the active host process.

Prompt automations start read-only. Turn on **Edit files in a worktree** to run with Accept edits or Workspace edits, depending on the provider. Select a repository checkout. Each run creates a managed worktree and uses the repository's worktree recipe, including its existing setup approval when needed. Provider permission rules apply to the session. The host uses its existing allowance, budget and folder checks for each start.

The latest completed run's report is included as context for the next prompt or workflow task. The automation's run history shows the bounded report and lists new and resolved bullet items when it can compare two reports. Use stable `[item-id]` prefixes when an item's description may change. Skipped, failed and interrupted runs leave the last completed report available.

For browser access, define an agent step with `needs: [browser]` and its workflow in your global workflows folder. Select **Use browser** in the automation editor and supply that workflow name and the project's task spec path. The browser step uses the existing read-only tools and checks that the extension is connected on the automation's computer. The host refuses repository workflows and repository overrides of browser steps.

### Watching failing pull request checks

**My pull request checks fail** checks your open pull requests on the automation's schedule. It uses the host's existing GitHub CLI login and the tracked repositories with a checkout on that host. Unseen failing heads are eligible on the first poll. Each claim records the repository, pull request number and head SHA, so subsequent checks and restarts cannot start the same head again for that automation. The daily cap and the availability check leave unclaimed heads eligible on a later poll.

The fix session is linked to the pull request and starts on a new worktree branch based on the exact head commit. Its prompt includes failing job names and short excerpts when logs are available. It uses the automation's selected provider and workspace-editing mode. The source checkout stays on its current branch.

The automation editor offers paused starter templates for daily error triage, dependency update maintenance, a morning plan, a day summary and a weekly Git summary. Select the folder and any sources the task needs before enabling it.

## Sharing a workflow

A workflow can be shared as a link that anyone can open without an account. The link stays valid for 7 days. The share site stores the files; Nesvo keeps only the link and the token that revokes it.

- **Share.** **Share…** in the graph editor toolbar, or the share button on a row of the Workflows list, collects the workflow file and every step file it lists, from the root each one resolves to (a project step that overrides a global one is shared, not the global one). The editor must be saved and without errors.
- **Secret check.** Before anything is uploaded, every line of every file goes through the same credential patterns as the `secrets` probe: private keys, provider and GitHub tokens, Bearer values, credentials in URLs and credential assignments, including the check the share site runs itself. A match blocks the share and lists the file, the line and a masked excerpt. Fix the file, for example by naming the variable in `needs` instead of writing its value, and choose **Scan again**. The patterns are signals, not a guarantee that a file holds no secret; read what the dialog shows.
- **Review and upload.** A clean scan shows exactly the files that will be uploaded, the share site and the size. **Upload and create link** sends them from the Nesvo app, not from the window, and shows the link with **Copy** and its expiry. A shared workflow is at most 64 KiB per file and 192 KiB of files in total, up to 32 steps. If the share site is limiting new links, the dialog says how long to wait.
- **Shared links.** Settings › Sharing lists every link this device created, with its expiry. **Revoke** asks the share site to delete the workflow at once; an expired link can be removed from the list. The revoke token is stored in the desktop's data folder, never in the project.
- **Share site.** Settings › Sharing sets the site address, `https://nesvo.dev` by default. It must be an `https://` address without a path; `http://` is accepted only for `localhost` and `127.0.0.1`. A development build started with `NESVO_SHARE_ORIGIN` uses that address instead and shows it as fixed.

### Importing a shared workflow

Opening a shared link opens Nesvo with an import dialog. Nothing runs and nothing is saved until you choose **Save workflow**.

- The dialog shows the name and description, every step with its type, and the full text of every command, action and agent step, followed by the workflow file. Lines that look like secrets are listed as warnings. Commands and actions run on your computer with your account when you run the workflow, and agent steps send their instructions to your provider; read them before saving.
- **Save to** offers the project folders Nesvo knows on this computer, **Global workflows** and **Choose a folder…**. The dialog checks the location as soon as you choose it and marks each file **New**, **Already there** (identical, left unchanged) or **Different file exists**.
- When a different workflow with the same name exists, the dialog suggests a free name such as `release-2`; renaming changes only the workflow's `name` field and file name. Steps keep their names. Files that differ are written only when you tick **Overwrite** and confirm the list of files; a file that changed again after the check is not overwritten.
- The files go through the same checks as a save from the editor: every step must parse, the workflow must list exactly the shared steps, and the graph rules apply. A bundle that fails any rule saves nothing.
- After saving, the workflow opens in the graph editor. Running it is a separate, explicit step.

Only links of the form `nesvo://import-workflow?share=<id>&origin=<site>` are accepted, and only from the configured share site or `https://nesvo.dev`. Any other link is refused with a message and nothing is fetched. Imports are saved on this computer (Local).

## Command line

The host bundle edits the same files as the editor, with no running host and no database:

```text
bun run --cwd apps/host build
node apps/host/dist/main.js workflows validate --directory <project>
node apps/host/dist/main.js workflows list --directory <project> --json
node apps/host/dist/main.js workflows add-step --directory <project> --scope project --file step.md [--expected-hash <hash>]
node apps/host/dist/main.js workflows add-to-workflow --directory <project> --scope project --workflow <name> --step <name> [--after <name>]
node apps/host/dist/main.js workflows remove-from-workflow --directory <project> --scope project --workflow <name> --step <name>
```

`pipelines` is accepted as an alias of the `workflows` command for scripts written before the rename.

`validate` prints `severity path:line: message` and exits 1 on an error. Edits keep the rest of the file byte for byte, check that every listed step exists and name the hash they read: a file that changed meanwhile is a conflict (exit 2) and nothing is written. `remove-from-workflow` also removes the edges that name the step and reports them; `add-to-workflow --after` moves only the `on success` edges that leave the named step to the new step. In a graph with explicit `edges`, a step added without `--after`, or into another phase, has no incoming edge and starts with its phase, possibly in parallel; removing a step does not reconnect its neighbours, so a step left without incoming edges becomes a phase start. The command prints each of these as a note. The CLI has no database, so it does not see runs in progress. Exit codes: 0 success, 1 validation errors, 2 conflict, 3 inside a workflow run, 64 usage. Inside a workflow run session the commands that write refuse with exit 3, so a run cannot change its own definitions.

## Gate rules

Settings › Workflows enables gate rule proposals per computer by default. After a run passes, fails or is rejected, a read-only session using its gate model can draft up to two rules from the owner's commented Fix or Reject decisions. Review each proposal in the Inbox. Accept uses the target step's scope for a new file. Edit lets you change the content, targets and scope. Dismiss settles the proposal for that run. Run details show the generation result and offer a limited explicit retry when it produced no proposals.

Gate rules use the shared rule entry format in `gate-rules/rule-NNNN.md` under the global or project `.agents/workflows` root. Set `scope.steps` to one through four agent step names and optionally narrow `scope.workflows`. A project entry takes precedence over a global entry of the same ID. Active, unenforced entries are pinned at run start. A step can have up to twelve matching active rules per workflow. A check suggestion is part of the verifier's instructions and is available to copy from the Inbox.

Accepted files include the run, source step and decision, date and an excerpt of at most 400 characters from the owner comment. Use Undo in the save notification, the Gate rules section of the step inspector, or the source run details. Undo uses the saved file hash and refuses to overwrite a newer edit.

The inspector shows delivery and citation counts and the last citation date. An instruction cited as broken at least twice suggests considering a deterministic check. An entry without a delivery in 60 days is flagged as unused. The owner controls retirement.
