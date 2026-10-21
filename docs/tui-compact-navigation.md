# Compact navigation

The Calm workspace uses a 42-column sidebar (reduced on narrow terminals to preserve at least 48 terminal columns), a single-line plain `nesvo` heading, and single-row sessions. Provider marks are drawn from ordinary Unicode: Claude `✳`, Codex `◈`, Gemini `✦`, terminal `>`. These are portable identifiers, not vendor logo fonts. Each session reserves right-aligned columns for process age and a text status, preserving state without relying on color.

Set `NESVO_ASCII_ICONS=1` before starting the client to use `C`, `O`, `G`, and `>` when the terminal font lacks these marks. The choice survives reconnects. Full provider names remain in session tabs and palette preview metadata.

The command palette uses one row per result. Wide views reserve columns for project, process age and status. Narrow views omit project first, then age below 30 columns; status text remains visible at 20 columns or wider. Names are clipped by display width, including Unicode, before any metadata column. Provider colors, fuzzy title matches, a quiet purple selection across the entire row, and a separate preview improve scanning without switching the active session before Enter. Existing keyboard commands and mouse hit testing use the same row geometry as rendering.

Search selection follows a stable session, group or command identity. Incoming
status, output, rename and list changes cannot substitute another result under
Enter. If the selected result disappears or no longer matches, selection clears
and Enter stays in search with a notice. A deliberate arrow, click, query or
category change selects a current result again. F2 expansion preserves both the
query and the selected identity; preview alone does not change MRU. Revalidation
checks the selected identity directly rather than rebuilding and sorting the
entire result list for every host event.

Verification: unit/render tests cover adjacent row geometry, full-row highlight, Unicode names, provider fallback and column separation. Windows ConPTY smoke exercises search, sidebar, diff and resizing to 100x32 and 80x24. No macOS or Linux interactive verification is claimed.

In navigation mode, `[` narrows the sidebar and `]` widens it in four-column steps. The width is saved per host and constrained to keep at least 48 terminal columns. When review is visible, both keys resize the review panel instead, even while the sidebar has focus; its existing boundary movement is preserved (`[` grows the right panel leftward). In session input, these keys are passed through unchanged. Dialogs retain their own input handling.

## Runtime and status columns

`working` and `idle` describe the current agent state. `needs you` means the agent is waiting on a question, permission decision, or a detected quota limit. `failed` and `done` describe observed outcomes. A tilde marks screen inference (`~working`, `~idle`, `~needs you`); `unknown` remains explicit when only terminal I/O is known. A generic live shell is labeled `terminal`. Historical unread attention never overwrites a newer working state.

Time is the age of the session process, not CPU time or time spent generating tokens. The host supplies optional `uptimeSeconds` from a monotonic clock, frozen at process exit. The client advances a cached label locally, uses fresh host values after reconnect, and only redraws when the displayed minute changes. No timer reads or I/O occur during rendering and no periodic list requests are added. Older hosts without uptime show an em dash. All three views use the same row widget and semantics.
