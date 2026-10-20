# Jobs presentation review

The proposed Jobs surface is a design-review renderer, not an activated feature.
The running TUI still exposes the older scheduled-session view; durable job
operations currently use the shared CLI/MCP API. Production activation awaits
owner approval of the material visual change.

The test-only renderer composes the real workspace `ui::render` and geometry
with a pure Jobs surface. It preserves the approved 42-column sidebar where it
fits, the existing narrow fallback, and one footer row. Every export explicitly
marks fixture data and `productionActivation:false`. No provider or model runs.

It proposes definitions with a selected profile, details, occurrence history,
a creation form, and narrow loading/error views. A definition's enabled flag is
separate from occurrence execution state. `needsValidation` is not success;
quota waiting does not imply an allocated Run or attempt.

Export deterministic Ratatui cells to an existing absolute folder outside this
repository:

```powershell
$env:NESVO_JOBS_PREVIEW_DIR = 'C:/path/to/owned/design-review'
cargo test -p nesvo --bin nesvo --locked ui::jobs_preview::export_jobs_review_mockups -- --ignored --exact
```

The manifest describes each 150×44 or 80×24 scenario. Scenario JSON contains
`width`, `height`, actual `sidebarWidth` and row-major `cells` with symbol,
foreground/background colors and text modifiers. Image conversion must render
these cells without inventing UI content. Export I/O is confined to the explicit
ignored test; rendering performs no I/O.

Before activation, wire the durable host API with request correlation, stable
selection IDs, retained idempotency keys and revision-conflict handling. Preserve
PTY input, modal isolation and return focus. Test 100×32 in addition to the export
sizes, then perform a real terminal smoke test. Preview export alone does not
verify interaction, scheduling or mobile presentation. No dependency was added.
