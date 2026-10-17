# Automatic review context

New Claude sessions launched by the host receive session-only `--settings` hooks. Global Claude settings are not edited. Successful `Edit`/`Write` events select the edited file's parent directory; `CwdChanged` selects the agent's new working directory. The latest explicit event wins. Git resolves that directory to its repository root on the host. Repository changes reset review position; refreshes within the same repository preserve it.

The hidden host helper reads at most 2 MiB of hook input, persists only directory/source in an atomically replaced private report, and never stores prompts, tool output, or transcripts. Reports are isolated by a random per-session directory and removed with the session. Reads and Git work occur outside the shared state lock. Hook errors cannot block agent tools.

The review header shows `Auto: edited file`, `Auto: agent directory`, `Auto: launch folder`, or `Pinned`. Press `o` to pin a folder, `a` to resume Auto, or submit an empty folder. A manual pin overrides automatic context. The protocol adds optional `review.directory` (resolved repository root) and `review.source`; existing clients can ignore them and mobile can reuse them.

Requires Claude hook support for command/args exec form and CwdChanged. Existing sessions must be relaunched to receive hooks. Codex/Gemini and sessions without hook reports retain the launch-folder fallback. Bash commands editing files via absolute paths do not emit Edit/Write events; Nesvo does not guess their target from prose or shell command strings. Disabled hooks likewise leave the fallback in effect. Changes remain scoped to staged, unstaged, or untracked, not agent-turn snapshots.

Reference: https://code.claude.com/docs/en/hooks
