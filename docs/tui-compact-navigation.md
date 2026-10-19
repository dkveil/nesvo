# Compact navigation

The Calm workspace uses a 30-column sidebar (reduced on narrow terminals), a 19-column static pixel wordmark, and single-row sessions. Provider marks are drawn from ordinary Unicode: Claude `✳`, Codex `◈`, Gemini `✦`, terminal `>`. These are portable identifiers, not vendor logo fonts. A separate right-aligned status symbol preserves state without relying on color.

Set `NESVO_ASCII_ICONS=1` before starting the client to use `C`, `O`, `G`, and `>` when the terminal font lacks these marks. The choice survives reconnects. Full provider names remain in session tabs and palette preview metadata.

The command palette uses one row per result. Wide views reserve columns for project and status; narrower views omit project first, then retain details in the preview/context. Provider colors, fuzzy title matches, full-width selection, and a separate preview improve scanning without switching the active session before Enter. Existing keyboard commands and mouse hit testing use the same row geometry as rendering.

Verification: unit/render tests cover adjacent row geometry, full-row highlight, Unicode names, provider fallback and column separation. Windows ConPTY smoke exercises search, sidebar, diff and resizing to 100x32 and 80x24. No macOS or Linux interactive verification is claimed.

In navigation mode, `[` narrows the sidebar and `]` widens it in four-column steps. The width is saved per host and constrained to keep at least 48 terminal columns. When review is visible, both keys resize the review panel instead, even while the sidebar has focus; its existing boundary movement is preserved (`[` grows the right panel leftward). In session input, these keys are passed through unchanged. Dialogs retain their own input handling.
