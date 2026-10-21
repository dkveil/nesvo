# Automatic review context

New Claude sessions launched by the host receive session-only `--settings` hooks. Global Claude settings are not edited. Successful `Edit`/`Write` events select the edited file's parent directory; `CwdChanged` selects the agent's new working directory. The latest accepted context transaction within the current conversation generation wins. Git resolves that directory to its repository root on the host. Repository changes reset review position; refreshes within the same repository preserve it.

The hidden host helper reads at most 2 MiB of hook input. Current launches store
bounded typed context in their private lifecycle journal, isolated by a random
per-session directory and removed with the session. Before reading stdin, the
helper captures an already-bound host session, launch, provider conversation and
generation. The context update checks that exact identity again inside one write
transaction. Child, foreign, unbound and delayed previous-generation callbacks
cannot replace the current record, including an A → B → A conversation change.
An initial callback without context authority can still bind lifecycle identity.

Automatic resolution reads current scope and context in one read transaction,
checking the expected host session. Rebinding without a new context event returns
the launch-folder fallback. A missing/corrupt journal or descriptor never enables
unscoped JSON fallback for a current launch. Explicit legacy scopes retain their
bounded JSON compatibility; a descriptor-less older journal may continue to
deliver lifecycle events without gaining context authority. No raw hook payload,
prompt, file content or transcript is retained.

Review directory and actual-cwd evidence are distinct: Edit/Write updates review
only; CwdChanged updates both. An edited file's parent is not evidence of agent
cwd. Reads and Git work occur outside the shared state lock and rendering. Hook
errors use a fixed private diagnostic and remain fail-open for agent tools.

The review header shows `Auto: edited file`, `Auto: agent directory`, `Auto: launch folder`, or `Pinned`. Press `o` to pin a folder, `a` to resume Auto, or submit an empty folder. A manual pin overrides automatic context. The protocol adds optional `review.directory` (resolved repository root) and `review.source`; existing clients can ignore them and mobile can reuse them.

Requires Claude hook support for command/args exec form and CwdChanged. Existing sessions must be relaunched to receive hooks. Codex/Gemini and sessions without hook reports retain the launch-folder fallback. Bash commands editing files via absolute paths do not emit Edit/Write events; Nesvo does not guess their target from prose or shell command strings. Disabled hooks likewise leave the fallback in effect. Changes remain scoped to staged, unstaged, or untracked, not agent-turn snapshots.

Reference: https://code.claude.com/docs/en/hooks
