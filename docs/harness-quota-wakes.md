# One-shot quota continuation

`durableQuotaWake:true` advertises the owner-only `setWake` and `getQuotaWake`
commands. The legacy `quotaWake` flag alone is insufficient. The CLI and MCP use
the same host journal and live process fences:

```powershell
nesvo session wake SESSION --json
nesvo session wake SESSION --enable --json
nesvo session wake SESSION --disable --json
```

MCP exposes `nesvo_get_quota_wake` and `nesvo_set_quota_wake`, with `sessionId`
and, for the setter, required boolean `enabled`. Reading never dispatches input.
The old TUI toggle uses this durable implementation without changing its layout.

## Arming and release

This implementation currently supports native Codex sessions with the supported
launch-local lifecycle adapter, a bound root conversation and prompt correlation.
It captures the resolved executable/arguments, actual directory and explicit
Codex home at launch. Arming pins the matching bounded reader without replacing
the ambient limits display. The owner must inspect a fresh complete configured
subscription snapshot: one five-hour window at least 90% used with a future reset.
The first request can return `quota_wait` while that directory's reader starts;
refresh/query the actual directory and arm again after its observation arrives.

Optional Codex windows do not create a five-hour quota. A weekly-only or zero-window
full read can support ordinary configured-account job admission when the backend
explicitly permits it, but cannot arm or release this wake. A real five-hour window
can support wake without a weekly window; all supplied windows must remain valid.

An arm freezes opaque reader/context/account fingerprints, source revision,
reset evidence, native launch/conversation generation, human-control epoch and
the current input receipt when present. It is a deliberate adoption of the
**currently configured** account evidence, not proof of a running process's
historical login or a provider capacity reservation.

Reset time alone cannot release it. A newer complete matching read must have
**started after** the frozen reset deadline, positively allow ordinary usage,
report less than 90% five-hour usage and no exhausted window. Missing/stale/failed
reads hold; positively observed account/configuration changes disarm, including
a switch away and back between checks. The grace window ends five minutes after
reset. Polling never prompts a model and never adds an LLM heartbeat.

The target must still display the current quota banner and an empty Codex editor.
An unrelated dialog, hidden cursor, human draft, native program-status report,
conversation change, lifecycle gap or human takeover refuses input. Arbitrary
manually typed sessions retain the existing conservative draft restriction;
the feature does not silently clear an editor or claim all manual sessions safe.

## Receipts and recovery

One atomic claim reserves one normal send receipt with key `quota-wake:ARM_ID`
and the fixed text `Continue the previous task.`. The standard paste/Enter path
checks durable authority, fresh quota, conversation, human ownership and semantic
revision before **both** native writes and confirms their write acknowledgements.
The status timer no longer writes directly into a PTY. After paste, the only
nonempty editor accepted is the exact fixed continuation text.

The original correlated send remains retained while the provider picks up the
continuation. Only matching native prompt evidence interrupts the predecessor
with `quota_resumed`, the new receipt ID and real lifecycle source sequence.
Unconfirmed continuation retains uncertainty instead of claiming task success.
Inspect `operationId` and `predecessorId` through ordinary receipt queries.

Disable/takeover fences queued input immediately. Receipts and arm history remain
readable. Restart pauses every arm; elapsed clocks, account authority and native
ownership are never restored automatically. No receipt replay creates another
continuation. Capacity is bounded at 64 active arms and 4096 retained arms; full
retention refuses new intent while preserving existing history.

Claude's global cache remains display-only. The private launch-owned Claude
callback receiver records allowlisted optional windows and root/generation
identity, but callback time does not establish backend freshness or permission.
Default launches preserve the user's statusline; an optional
[declared-display capture](harness-claude-quota-capture.md) is scoped to one launch.
Claude/Gemini wake and job admission
remain separate unfinished provider integrations. This feature neither bypasses
provider limits nor purchases credits.
