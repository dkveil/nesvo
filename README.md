# Nesvo

The Expo mobile companion supports existing conversations, live activity and operator decisions. See [mobile setup and scope](docs/mobile.md).

A desktop workspace for technical sessions, visible delegation and operator review.

The approved prototype targets Windows, macOS and Linux. The desktop connects installed Claude Code and Codex for technical conversations, streaming, Stop and persistent history. Codex adds provider-specific modes, one-time operation approvals and visible delegation. P0, the initial P1 layout, the delivered Codex scope of P3 and P4 are accepted. P5 provides direct decisions on session-linked inbox rows; successful Claude task evidence remains open in P2.

## Start

Install Node.js 24.20.0 and Bun 1.4.0, then run from the repository root:

```sh
bun install --frozen-lockfile
bun run dev
```

The desktop opens your saved sessions in a black workspace with an English interface. Use New session to open a new thread: pick the provider and model, the computer, an optional project folder and access permissions from the chips under the composer, then send the first message. That message creates the session and its first line becomes the title. There is no role picker: new Codex sessions can propose workers when the task calls for delegation, without changing their permissions. A directory does not need Git; leaving it empty creates a separate local working folder. Connection and provider status are available on demand. Quitting the application stops its local active group and host. On macOS, use Quit to exit; closing the last window keeps the application available in the dock.

The desktop uses Electron's embedded Node runtime. The Node version above is for development tools and the standalone host. Local remains the default computer. In Computers, add a prepared Linux host through SSH and connect it explicitly. New sessions can choose that connected computer; its files, skills and provider login belong to it. Quitting Nesvo stops Local work and disconnects remote computers without stopping their hosts. See [Linux host setup](docs/ssh-host.md).

## Workspace

The narrow left rail shows the remaining reported allowance for Claude Code and Codex on the selected computer. Open a provider indicator for its quota windows and reset times, or the account icon below for both accounts. Refresh is available in that panel. Unavailable data stays unknown; offline, expired and older observations are labeled explicitly. Reading limits starts no model task. Claude's native usage capability is experimental and may be unavailable in another CLI version. The panel covers reported subscription windows, not billing or account management.

```text
apps/desktop     Electron main/preload and React renderer
apps/host        Effect services, SQLite and standalone entry
packages/contracts  Zod schemas and inferred types
docs             Architecture, workflow and acceptance plan
scripts          Desktop and focused remote-host integration scenarios
```

## Commands

| Command               | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| bun run dev           | Start the desktop with development reload          |
| bun run check         | Types, lint, formatting and host integration cases |
| bun run build         | Build the standalone host and desktop              |
| bun run smoke:desktop | Check the built desktop, real host and shutdown    |
| bun run smoke:remote  | Check two hosts over isolated Docker SSH           |
| bun run package:dir   | Produce an unpacked native desktop package         |
| bun run format        | Format current workspace files                     |

Install the native Claude Code or Codex CLI and sign in using `claude auth login` or `codex login`. Nesvo uses that existing login and requires no new model API key. It checks the installed CLI and authentication before execution. Claude choices are CLI aliases; Codex choices come from its local model catalog. Actual account access is confirmed by the provider, and the running model is shown in session details.

Claude runs in analysis mode with Read, Glob and Grep. Codex read-only mode can read files and run read commands without write or elevation grants. Codex supervised mode allows workspace changes and displays the operation approvals requested by Codex; it does not ask before every edit. Decisions apply once to a particular request and run. One group runs per host at a time: a parent with up to two approved workers, or a single session. Account limits and authentication failures remain visible; Stop preserves partial text and never means successful completion. The inbox brings operation approvals, worker proposals and successful results into compact rows with distinct inline actions. Accepting a result is separate from allowing a provider operation and performs no commit or merge.

## P2 acceptance walkthrough

1. Confirm that Claude Code is detected and logged in, then create a session in a small known directory.
2. Ask it to summarize a file and observe the streamed response. Confirm the actual model in session details.
3. Reload or restart the application and continue the same conversation.
4. Start another response and press Stop. Confirm the stopped state and preserved partial output.
5. Switch sessions, check separate drafts, and open navigation/details in a smaller window.

On November 7, the local Claude account reported its weekly limit until November 8 at 20:00 Europe/Warsaw. Actual CLI startup, limit handling, reload and Stop were verified; successful Claude output still requires account availability. Damian explicitly authorized starting Codex in P3 while retaining this pending P2 evidence (D50). See [platform evidence](docs/platforms.md).

## P3 acceptance walkthrough

1. Refresh Codex availability and create a Codex session with a model from its catalog.
2. In read-only mode, ask about a small file, reload and continue the same conversation.
3. Create a supervised session in a disposable directory. Inspect a requested operation, decline it, and confirm its intended change did not happen.
4. Request a new operation and allow it once. Check the resulting file. A stopped or completed request cannot be approved again.
5. Press Stop during work or while awaiting a decision. Reopen the app and inspect the retained history.
6. Switch to Claude and confirm its distinct capabilities and account state. Successful Claude work and the owner's full two-provider acceptance remain separate gates.

## P4 acceptance walkthrough

1. Create a new Codex session in a small known directory. Choose access permissions independently of delegation; no role choice is required. New Codex sessions receive the delegation tool and become orchestrators when they make a valid proposal. Existing conversations retain their original provider threads and recorded capabilities.
2. Ask for two workers with explicit tasks and scopes. For example: "Propose two read-only Codex workers in this directory: one summarizes README.md, the other inspects package.json. After my approval, summarize their results. Use your delegation tool."
3. Inspect each proposal's task, scope, directory, provider, model and mode. Approve or decline each separately. No worker session or process exists before approval.
4. Open each child from the session tree and watch its conversation. Stop one while the other continues; return to the parent and inspect the distinct results. Stop group on the parent cancels both children and pending proposals.
5. Reload or reopen the application and confirm that conversations and relationships remain. Interrupted work never starts automatically.

Worker directories must exist inside the parent directory. Read-only workers may share a folder; writable workers require non-overlapping directories and a read-only parent. Until isolated workspaces exist, a supervised parent can delegate only read-only workers so its review snapshot cannot mix in worker edits. Unsupported proposals are rejected explicitly, without downgrading permissions or starting a child. The textual scope describes the assignment, not an additional filesystem sandbox. A proposal is accepted as shown; reject it and request another plan to change its settings. Workers cannot delegate recursively.
P4's real demonstration uses Codex. Claude can be a read-only worker, with successful execution still dependent on account availability. Each parent turn has a ten-minute deadline including time spent awaiting operator decisions and worker results. The conversation retains at most 100 proposals before a new orchestrator is required.

## P5 acceptance walkthrough

1. Create a supervised Codex session in a small disposable directory and ask it to edit a text file. Open the inbox. Pending operations show the requesting session and their own approve/deny buttons; completed results show result acceptance actions.
2. Read the short description and version in the row. Its session-name link opens the conversation at that exact request or saved result. Full task, answer, diff and decision history live there, without a separate inbox detail screen. Existing dirty contents are the baseline; the diff compares the start and end of that turn without changing the workspace or Git index.
3. Request changes on the result row, enter feedback and submit it. This explicitly starts another turn in the same session, provider thread, directory and permissions. The app opens that conversation. Unsaved feedback survives navigation between the list and session.
4. Return to the inbox for the new result version. The previous decision remains in history; its acceptance is not inherited. Each version shows its own turn's delta inside the conversation.
5. Accept the result directly on the new row and reload the application. Select History to confirm the accepted version and correction history. Session links still open the exact historical version. An old result cannot accept a replaced version, and external changes to captured files block stale acceptance.

The inbox receives successful turns completed after P5 was installed; it does not fabricate results for older conversations or stopped/failed runs. Read-only results are reviewed as saved responses. Parent summaries link to exact worker results; accepting a summary does not accept those workers automatically. Continuing a child invalidates dependent parent summaries. When continuing a parent without another delegation, it receives the latest saved child summaries and retains their result references.

Writable review uses a bounded local snapshot: 500 files, 512 KiB per file, 8 MiB total and five seconds per capture. Generated directories are excluded and listed in the result. Symlinks, special files, read failures, excessive size or changed binary contents make the diff unavailable and block acceptance. Use a small work directory for this prototype. Changes made outside Nesvo during a turn can also appear in the comparison. Review decisions wait until the active group finishes.

## P6 skill walkthrough

1. Open either provider session. Type `/` at the start of a draft or use Choose skill to search the shared local library.
2. Inspect the source and delivery label. Codex uses Native skill; Claude uses compatible static content as Shared instructions. Unsupported entries explain why they cannot be selected.
3. Select with the mouse or arrow keys and Enter/Tab. Escape closes the menu. One removable skill is attached to the current draft.
4. Send your task. Nesvo revalidates the source and selected content hash. A changed, disabled or incompatible selection fails explicitly without widening session permissions.
5. Inspect the result and source reference in history. The reference includes origin, delivery and content hash and survives reopening the app. The hash does not freeze supporting files or later native reads.

The catalog covers known project/user/managed sources and the isolated native Codex catalog, with explicit coverage limits. It does not promise every plugin or remote skill. Claude's Shared instructions delivery is distinct from native Claude skill execution. Real Codex use of a Claude-source skill is verified on Windows; a successful real Claude task remains open because the account reached its weekly limit.

## P7 restart walkthrough

1. Finish a parent/worker task and leave a result pending in Inbox. Open a saved result diff if you want to resume that review location.
2. Quit and reopen Nesvo. The last session or Inbox and the exact saved diff are restored. Sessions, worker relationships, results, decisions and selected skill references come from the host database.
3. An unfinished run is marked Interrupted with its cause. Partial output remains available; no successful result or operation completion is invented. Expired operation and worker approvals are not restored as actionable requests.
4. Use Continue conversation to focus the composer, then send a new instruction after checking the current state. The button itself starts nothing. Nesvo retains the provider thread and includes interruption context; it never replays the previous task automatically.
5. Continue reviewing the same saved result version. Re-delivery of an already recorded decision returns that decision rather than starting another correction.

Reloading the window leaves the host running. Quitting the app closes its local owned work and disconnects remote computers; a host restart reconciles incomplete records. Local view preferences contain only navigation identifiers and a diff path, not authoritative status or permission. Unsent composer and review-feedback drafts remain transient in this stage. Only one app/host may own a data directory.

## Working agreement

Small conventional commits go directly to master during the prototype. Each stage ends with Damian's acceptance. See [roadmap](docs/roadmap.md), [contributing](CONTRIBUTING.md), [testing](docs/testing.md) and [platform evidence](docs/platforms.md).

The active repository contains no previous branding. The baseline is preserved in Git; see [baseline](docs/baseline.md). Existing checkouts may contain ignored historical files and private runtime data. Use only the documented workspace commands.
