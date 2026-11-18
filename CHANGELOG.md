# Changelog

## 0.0.1 (alpha)

- Desktop sessions with streaming chat, per-turn permissions, reusable skills, and native MCP servers and hooks in writable sessions.
- Plan-first workers, a review inbox with revision-bound decisions, saved diffs, and history restored on restart.
- Local and SSH-connected hosts, session groups, history search, usage and cost reports, and budgets.
- A workflow editor, scheduled automations, change-triggered automations, and pull request review from the desktop.
- Tracked repositories per computer, listed together on the Pull requests page with a repository filter, and offered as checkouts for review automations.
- Agent-assisted pull request reviews with reviewer profiles, layered conventions, editable draft findings and one-step publishing, started per pull request, in bulk or by an automation.
- Claude Code operation approvals answered once from the inbox or the conversation.
- Inbox rules: Markdown rule files that hold commands, pull request actions, MCP tool calls and workflow steps, or notify and ask on plans, reports, questions, finished sessions, checks, changed files and run cost, with suggestions in onboarding and an editor in Settings.
- Decision routing: decisions of child sessions can appear as cards in the parent conversation, in the Inbox or both.
- Session worktrees with `.worktreeinclude`, approved setup scripts, cleanup of orphaned checkouts, and forks into a new worktree.
- Fork, restart, compact, delete with undo, export as Markdown, and open in the system terminal.
- Resume failed, interrupted or stopped sessions in their provider conversation after confirming the continuation message, one at a time or in bulk.
- Finish worktree sessions after their pull request is merged: clean checkouts are removed, the local branch is deleted and the session is archived, from the session or in bulk from Clean up.
- Attachments of any file type in the composer (images and PDF files as native input where the provider supports it, other files as read-only references), and a context window indicator from provider-reported usage.
- Provider accounts per session, import of existing CLI conversations, and search across CLI transcripts.
- A command palette with session actions, keyboard navigation, status filters, and tray attention badges.
- About, Defaults, Notifications and Data settings, rotating logs, automatic host restart and reconnect, and database backups before migrations.
- Owner lessons: incidents recorded from stuck sessions, rejected plans, failed workflow steps, sensitive probe findings, costly turns and stage report remarks, lessons proposed by a chosen model on demand or once a day, approved in the Inbox into lesson files in the workflows folders and added to scoped prompts until their review date.
- Paired mobile access to existing sessions, plus unsigned Windows and macOS installers with SHA-256 checksums.
