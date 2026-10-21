# Explicit Claude statusline capture

Default launches preserve the user's statusline. An authenticated owner can opt a
supported Claude launch into capturing its native quota callback while forwarding
an explicitly declared display program. This does not discover, edit or follow
global/project/managed statusline settings. The selected display is pinned for
this launch; choose the same executable and literal arguments as your display
if you want to preserve it.

Create a private JSON file on the **host**, outside version control:

```json
{
  "display": {
    "program": "C:/Tools/Python/python.exe",
    "args": ["C:/Users/owner/.claude/statusline.py"]
  },
  "padding": 0
}
```

Replace these example paths with the actual executable and script. Unix paths
are supported too. A shell script needs an explicit shell executable and literal
arguments; Nesvo does not guess or reinterpret a command string. Windows batch
shims are refused as display executables.

```powershell
nesvo session create "Project Claude" --program claude --cwd "C:/work/project" `
  --claude-quota-display-profile "C:/private/claude-display.json" `
  --key "project-claude-1" --json
nesvo session explain SESSION_ID --json
```

The same optional `claudeQuotaCapture:{displayProfile:absoluteHostPath}` field
is available in owner MCP create specifications and task/job/executor profiles.
`nesvo run launch` also accepts `--claude-quota-display-profile`. Clients require
exact capability `claudeQuotaCapture:true`. The host validates the installed
supported Claude version and refuses non-Claude or scoped-caller selection.
Children do not inherit it implicitly. The option grants no agent tools.

The bounded regular-file manifest is read for a new native receipt before Git
or spawn, then copied into the private launch scope. Replaying a receipt does
not reread a changed source manifest or launch another process. Omission retains
the old serialization and launch behavior.

## Display and quota are separate

The one launch-local `--settings` object retains the existing lifecycle hooks,
recovery hooks and native permissions, and adds only the explicitly requested
statusline wrapper. The declared display receives the same stdin, cwd and inherited
environment, including terminal dimensions. Within the documented limits its
stdout bytes and exit code are forwarded. Capture rejection or parsing/storage
errors do not themselves suppress the display. Input, execution and cleanup
failures produce a fixed diagnostic instead of exposing payloads or command text.

The receiver captures its root/generation ticket before reading input. Child,
foreign or rebound conversations cannot update another launch. Only allowlisted
optional quota windows are stored; the raw statusline JSON is not retained.
Missing windows remain unavailable.

The native `agent.name` descriptor can describe the main agent and does not by
itself identify a child. A matching root is still required; child IDs and task
payloads are excluded. Native rate-limit windows may be absent before the first
API response. An invocation before lifecycle root binding cannot establish that
binding itself and is rejected. Display output alone does not prove a recorded
callback; inspect `conversationIdentity` and `nativeQuotaCallback` separately.

Owner session diagnostics separate requested `claudeQuotaCapture` configuration
and its private-profile fingerprint from the actual `nativeQuotaCallback` scope,
sequence and snapshot. `observed:null` does not claim that display output was
seen. Callback receipt time is not backend freshness, account identity or
ordinary-use permission. This feature does not enable Claude quota-based job
admission or automatic wake. The compatible global cache remains a separate
display source.

## Capture delivery diagnostics

`session explain SESSION_ID` prints allowlisted capture summaries; `--json`
exposes the same owner-only evidence under `claudeQuotaCapture`. This is separate
from lifecycle hook delivery and the accepted `nativeQuotaCallback` snapshot.
No attempt is inferred from a display marker or a configured profile.

The additive `delivery` object retains at most three attempt slots:
`latestStarted`, `latestCompleted` and `latestRejected`, plus a nullable
`lastStorageFailure`. Each attempt has an independent `attemptSequence`,
`entryGeneration`, `boundAtEntry`, `state`, start/finish receipt clocks, nullable
`outcome` and nullable `parseReason`. Reservation happens before input is read.
An unfinished newer attempt stays `unconfirmed`; an older completion cannot
replace it. Diagnostic sequences are distinct from accepted quota sequences.

Completed outcomes are `recorded`, `rootUnbound`, `payloadScopeRejected`,
`scopeChanged`, `superseded` or `storageUnavailable`. A recorded attempt can
still report absent or invalid windows through `parseReason`; it is not a
promise of usable capacity. A rejected callback leaves the previous accepted
snapshot and its original receipt clocks intact. Accepted quota and successful
attempt completion commit in the same transaction.

The additive `reader` object reports `outcome`, `checkedAt` and
`storageFailureOutcome`. Outcomes distinguish `notPolled`, `readable`, `missing`,
`unreadable`, `invalidStoredData` and `scopeChanged`. Read failure clears the live
accepted quota instead of presenting cached data as current. A later successful
read can recover the previous snapshot without renewing its receipt clocks.
Older hosts omit these objects; the CLI says "reader not reported" rather than
claiming callback delivery. `observed:null` retains its previous meaning.

A write failure makes a best-effort, failure-only atomic sidecar in the existing
private launch directory, bounded to 1 KiB and tied to that exact launch. It
records only fixed stage/outcome labels, an optional attempt sequence and
receipt clocks. It never recreates a removed launch directory. The reader can
show that historical failure even when the journal cannot be opened. Recovery
does not turn the retained failure into a new current failure. If both storage
paths fail, only a fixed stderr warning can remain; persistence is not guaranteed
under complete filesystem failure.

The existing asynchronous observer reads these bounded records in its scoped
transaction. No new timer or diagnostic timestamp broadcast is added. Public
attempt records contain no conversation/launch IDs, command, profile path,
payload, prompt, account identity or raw storage error. These diagnostics grant
no quota admission, automatic wake or backend freshness authority.

## Bounds and removal

The manifest is at most 16 KiB. It requires an absolute executable and at most
32 arguments, each at most 4096 UTF-8 bytes and 8192 bytes in total, without NUL.
Optional `padding` is 0–32, `refreshInterval` is 1–3600 seconds and
`hideVimModeIndicator` is boolean. No refresh interval is added by default.

Forwarded input is at most 256 KiB and stdout 64 KiB. Stdin collection has a
two-second bound. The enclosed helper's lifetime is bounded, including framing
and display execution; cleanup terminates its owned process group/job and checks
reaping. Windows uses PowerShell to start the helper with raw inherited standard
handles rather than native-output text conversion. This adds opt-in startup
overhead; idle observation benchmarks do not measure active statusline cost.

To remove the capture, omit the option from the next launch/profile. Running
sessions are not silently restarted. No global settings backup or uninstall is
needed because none were changed. Native managed policy, trust or disabled hooks
can still prevent invocation; absence of a callback remains visible rather than
being reported as success. See [Claude's statusline contract](https://code.claude.com/docs/en/statusline)
for native behavior. No dependency was added.
