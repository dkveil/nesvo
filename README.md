<p align="center">
  <img src="apps/desktop/build/icons/128x128.png" width="72" height="72" alt="Nesvo logo" />
</p>

<h1 align="center">Nesvo</h1>

<p align="center"><strong>vibe with full control</strong></p>

Nesvo is one desktop app for running Claude Code and Codex side by side on this computer and your own servers. You decide what agents can do and which results to accept.

## Sessions

- **Claude Code and Codex** — Work with both agents using their native permission modes and your existing sign-ins.
- **Skills** — Pick a skill with `/` using native Codex skills or shared instructions in Claude Code.
- **Session groups** — Organize related sessions and set defaults for new ones.
- **History search** — Find messages across your computers and jump to the conversation.
- **Import conversations** — Resume existing Claude Code and Codex CLI conversations in Nesvo.

## Control

- **MCP servers** — Choose servers for each session, see their status, and select Authorize or Reconnect when needed.
- **Claude allow rules** — Approve recurring actions within a session or project.
- **Full access** — Opt in for a supported session after enabling the computer-wide setting.
- **Claude terminal view** — Follow live output from Claude Code in the session.
- **Worktrees and recipes** — Isolate Git work and reuse project setup.
- **Writable workers** — Delegate changes in separate worktrees, review each diff, and choose whether to merge.
- **Restart recovery** — Continue coordinators and interrupted workers on their existing threads after a host restart.

## Inbox

- **Inbox and rules** — Choose what reaches your Inbox and when agents wait for your decision.
- **Saved results** — Review the exact response and its diff, accept that version, or request corrections.
- **External Inbox items** — Send review requests from scripts, CI or other agents through the `nesvo` CLI or MCP and wait for a decision.
- **Lessons and gate rules** — Review proposals from incidents and workflow feedback, and see how often approved entries are used or cited.

## Automation

- **Workflows** — Chain steps with automated checks and human approval gates.
- **Automations and rituals** — Run tasks on a schedule or when a check changes, with editable templates for recurring work.
- **Pull requests** — Review diffs and publish reviews using your existing GitHub CLI sign-in.

## Insight

- **Costs and budgets** — See reported and estimated costs from local transcripts and set budgets to warn or block new turns.
- **Usage limits** — See your remaining provider allowance and reset times.
- **Running apps** — See servers started by your sessions and open local web previews.

## Anywhere

- **Remote computers** — Connect to your own Linux hosts over SSH and use their accounts, files and skills.
- **Phone access** — Pair your phone to follow existing sessions, send messages and make decisions.
- **Onboarding** — Check your providers, connect computers and choose starter Inbox rules and routines.

## Download

[Download page](https://nesvo.dev/) · [GitHub Releases](https://github.com/dkveil/nesvo/releases)

Windows and macOS builds are unsigned, so the operating system will warn when you open them.

## Development

```sh
bun install --frozen-lockfile
bun run dev
bun run check
```

[Documentation](docs/)

Licensed under the [MIT License](LICENSE).
