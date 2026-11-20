<p align="center">
  <img src="apps/desktop/build/icons/128x128.png" width="72" height="72" alt="Nesvo logo" />
</p>

<h1 align="center">Nesvo</h1>

<p align="center"><strong>vibe with full control</strong></p>

Nesvo is one desktop app for running Claude Code and Codex side by side on this computer and your own servers. You decide what agents can do and which results to accept.

## Download and install

Download Nesvo from [nesvo.dev](https://nesvo.dev/) or get the installers from [GitHub Releases](https://github.com/dkveil/nesvo/releases).

**0.0.1-alpha.1** is an early pre-release for testing. Builds are unsigned and updates are manual.

| Platform            | File                      |
| ------------------- | ------------------------- |
| Windows x64 (NSIS)  | `Nesvo-Windows-Setup.exe` |
| macOS Apple silicon | `Nesvo-macOS-arm64.dmg`   |
| macOS Intel         | `Nesvo-macOS-x64.dmg`     |

Before opening an installer, compare its SHA-256 with the matching entry in `SHA256SUMS.txt`. Use `Get-FileHash -Algorithm SHA256` on Windows or `shasum -a 256` on macOS.

- **Windows** — If SmartScreen warns, choose **More info → Run anyway** if offered.
- **macOS** — Move Nesvo to Applications, then Control-click it and choose **Open**. If macOS still blocks it, use **System Settings → Privacy & Security → Open Anyway**.

The [macOS install script](docs/web.md#macos-install-script) verifies the checksum before installing.

```sh
curl -fsSL https://nesvo.dev/install.sh | sh
```

## Sessions

- **Claude Code and Codex** — Work with both agents using their native permission modes and your existing sign-ins.
- **Skills** — Pick a skill with `/` using native Codex skills or shared instructions in Claude Code.
- **Session groups** — Organize related sessions and set defaults for new ones.
- **History search** — Find messages across your computers and jump to the conversation.
- **Import conversations** — Resume supported Claude Code and Codex conversations from their CLIs, T3 Code v2, or Agent Deck.

## Control

- **MCP servers** — Choose servers for each session, see their status, and select Authorize or Reconnect when needed.
- **Claude allow rules** — Approve recurring actions within a session or project.
- **Full access** — Opt in for a supported session after enabling the computer-wide setting.
- **Claude terminal view** — Follow live output from Claude Code in the session.
- **Worktrees and recipes** — Isolate work and reuse project setup with Git or a trusted worktree tool.
- **Project trust** — Review repository tools and grant specific hooks or MCP tools in supported read-only sessions.
- **Writable workers** — Delegate changes in separate worktrees, review each diff, and choose whether to merge.
- **Coordinators and recovery** — Follow child sessions in Flows, let idle coordinators pick up updates, and resume interrupted work on the same threads after a host restart.

## Inbox

- **Inbox and rules** — Route approvals, questions and results for review. Reply or decide from the Inbox.
- **Saved results** — Review the exact response and its diff, accept that version, or request corrections.
- **External Inbox items** — Send review requests from scripts, CI or other agents through the `nesvo` CLI or MCP and wait for a decision.
- **Lessons and gate rules** — Review proposals from incidents and workflow feedback, and see how often approved entries are used or cited.
- **Settings by chat** — Ask for a configuration change, review the proposal, or undo supported edits from history.

## Automation

- **Workflows** — Reuse test checks across projects, branch on results, and collect decisions with approval forms. [Workflow guide](docs/workflows.md)
- **Decision memory** — Opt in to reuse past decisions in recommendations and choose which gates require a person. [Decision memory and gate trust](docs/workflows.md#decision-memory)
- **Automations and rituals** — Run tasks on a schedule or when a check changes, with editable templates for recurring work.
- **Session messages and watchers** — Route messages from external tools or explicitly start a watcher to send updates to sessions.
- **Pull requests** — Review diffs and publish reviews using your existing GitHub CLI sign-in.

## Insight

- **Costs and budgets** — See reported and estimated costs from local transcripts and set budgets to warn or block new turns.
- **Usage limits** — See provider allowances and reset times, and choose when low remaining quota should pause new turns.
- **Running apps** — See servers started by your sessions and open local web previews.

## Anywhere

- **Remote computers** — Connect to your own Linux hosts over SSH and use their accounts, files and skills.
- **Phone access** — Pair your phone to follow existing sessions, send messages and make decisions.
- **Onboarding and setup profiles** — Connect providers and computers, then review and reuse setup profiles across machines.

## Development

```sh
bun install --frozen-lockfile
bun run dev
bun run check
```

[Documentation](docs/)

Licensed under the [MIT License](LICENSE).
