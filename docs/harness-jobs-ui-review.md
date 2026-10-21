# Jobs presentation review

The Jobs layout reviewed as real Ratatui previews (list, details, history, form,
loading and error at 150×44 and 80×24) was approved by the owner on 2026-10-21 and
is now the production Jobs view. It keeps the 42-column sidebar, its narrow
fallback and one footer row. The test-only preview renderer and its ignored export
test were removed; `apps/tui/src/ui_jobs.rs` is the only renderer. Usage, keys and
host behavior are described in [the Jobs view](harness-jobs.md#jobs-view-in-the-tui).

Differences from the previews come from real data: the subtitle reads "Host jobs ·
run without an open client" instead of the fixture marker; next starts show the
once schedule's explicit offset (`UTC+02:00`) or UTC instead of an IANA zone name;
history shows host reason codes; Space reads "resume" for a paused definition;
and Advanced remains a label.

Unit tests render the composed workspace into a Ratatui test buffer at 150×44,
100×32 and 80×24 and drive keys through the controller. A real terminal smoke test
and mobile presentation are not yet verified.
