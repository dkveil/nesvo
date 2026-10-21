# Agent session status

Claude sessions launched by Nesvo install session-scoped hooks alongside the existing automatic diff context hooks. Global Claude settings are not edited. The helper observes UserPromptSubmit, tool boundaries, PermissionRequest, AskUserQuestion, Notification, Stop and StopFailure. Initial SessionStart and Stop mean idle; compaction remains working. None means that the process exited or that a task succeeded. Subagent events cannot mark the parent idle. Silence never clears a confirmed running state.

Only lifecycle metadata and conversation/launch identities are stored in the private session directory. Prompts, responses and tool arguments are not persisted. A bounded launch-scoped SQLite journal is read asynchronously every 500 ms, outside the host mutex and PTY dispatch loop; the compatibility JSON shadow is diagnostic data rather than the new host's event source. Status broadcasts remain coalesced. Process exit has final precedence. Fresh visible UI evidence can supersede a different hook state after a short transition grace period, covering approvals. An idle prompt cannot override confirmed working just because output arrived or time passed: a real Ctrl+C/Esc interrupt followed by a newly rendered prompt is required for that fallback. Identical screen/hook states keep hook provenance. Losing a hook does not manufacture completion.

Periodic lifecycle and optional Claude quota reads share one short read
transaction per launch. Current launch/conversation scope is checked every time;
only immutable lifecycle-column capabilities and decoding of an identical quota
ticket plus stored bytes are cached. A quota table created after startup remains
discoverable. Rebind, missing/corrupt data and read failures remove cached and
visible quota instead of retaining an old success. Cache hits preserve original
receipt clocks and establish no new backend freshness or permission. Aggregate
numeric read counters are available in owner diagnostics as `lifecycleObserver`;
session-scoped callers cannot read host-wide counters.

The wire contract remains compatible with older v2 clients: confirmed reports use `source: screen` with additive `evidence: hook`. Older clients show an inferred state; updated clients show confirmed running/idle/blocked/question/failed. Attention events retain a legacy-compatible source. TUI labels prefixed with `~` are screen inferences; open/quiet are terminal I/O observations only.

## Coverage and limits

- New Claude sessions: lifecycle events, with current-screen fallback. Restarting the Nesvo client alone cannot install hooks into an already running Claude process. Launch a new Claude session for hook support.
- Existing Claude sessions: current prompt and permission-mode footer identify idle; the interrupt footer identifies work. A real cursor at the prompt is required for idle.
- Codex 0.156.0: launch-local native lifecycle adapter plus conservative screen inference. Native hooks require the provider's user trust review; configured is separate from observed. Other/unprobed versions retain screen/protocol fallback. See the adapter boundary below.
- Gemini: existing approval screen inference. Its BeforeAgent/AfterAgent hooks are the preferred future adapter, but require a separate launch-scoped settings implementation; no global settings are overwritten.
- Agents started manually inside a generic shell do not inherit a dedicated provider adapter.
- Hooks disabled by user/managed settings fall back to screen inference. Unknown is deliberately retained when there is no trustworthy evidence.

References: [Claude hooks](https://code.claude.com/docs/en/hooks), [Gemini hook reference](https://geminicli.com/docs/hooks/reference/).

## Codex native adapter boundary

For a successfully probed Codex 0.156.0, the host adds a launch-local inline
`hooks` config for SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest,
PostToolUse, Stop and Interrupt. `--no-daemon` keeps the executor and hook report
environment local to this managed process. Subscription login, user/project
hooks and native approval policy remain intact. No shared config is written,
hooks are not forced on, and hook trust is never bypassed. Unknown versions do
not receive unverified flags; doctor lists their actual probe outcome.

The helper receives metadata through stdin and a launch-local report path in the
environment. The hook definition contains a stable helper invocation rather than
an ephemeral report path. Windows uses a literal PowerShell encoded command to
preserve spaces/Unicode and stdin without shell interpolation of agent payloads.
The same private journal, 500 ms reader and coalesced host projection are used
for both providers. No transcript parsing or model-facing hook output is added.

Codex supplies `turn_id`, so duplicate pickup and late tool/Stop events are
filtered transactionally against the active native turn. Stop/Interrupt retire
the native fence; a late tool event cannot revive that turn. Same-conversation
compaction preserves the fence and remains working. Native Interrupt settles
the host turn/receipt as interrupted, never task success. Subagent IDs are
rejected before journaling; a worker's events cannot change its parent.

The installed 0.156.0 CLI accepts the generated TOML through its read-only
`features list` path. Controlled native CLI/helper/PTY/MCP tests establish
readiness and literal prompt correlation on Windows. They do not establish
actual-provider hook activation. A real no-prompt startup showed the adapter
configured but no hook after 12 seconds; that delivery/trust gate remains open.
Use `/hooks` in the original Codex CLI to inspect/review exact hook definitions.
Provider/managed settings may disable them. Missing delivery is diagnostic
evidence, not permission to manufacture idle or silently enable hooks.

Sources: [official hooks guide](https://learn.chatgpt.com/docs/hooks),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
Input schemas were checked against the installed release tag `rust-v0.156.0`.

## Program Status Protocol (F01)

The host consumes live OSC 7501 (draft 0.4) and answers its feature probe before
the primary-device-attributes sentinel. It owns both replies, including when no
client is connected. Those queries and reports are removed before client output
and transcript storage; subscribing/replaying cannot re-answer or reapply them.
On Windows the first ConPTY cursor query is answered at the canonical origin,
allowing startup without an attached terminal. Later cursor queries retain the
existing controller contract.

Parsing is incremental across PTY chunks, bounded to 4096 bytes per sequence,
256 LRU records and the protocol's field/text limits. Reports with invalid IDs,
base64 or control characters are rejected. Bidi formatting is removed from decoded
labels. Root and child records remain independent, with inherited app identity;
clear removes a subtree, RIS clears all records, and OSC 133 A/process exit ends
live records. Completed/error records survive as informational facets. They do
not establish task success. Reply bytes are constant, ordered and bounded; text
from a report is never written to terminal input or interpreted as commands.

Snapshots expose a bounded `programStatus` facet: root report, child count,
blocked-child count and up to 32 inherited app IDs. Root state is projected into
legacy `status.source: screen`, with additive `confirmedSource: osc7501`.
Older clients still accept it as inference; updated clients distinguish reported
state. Full child messages are not broadcast in aggregate. Program-reported
`done` currently projects to idle while preserving the completion record;
turn/unread/task modeling is tracked separately under F08.

The protocol parser is verified with hostile/fragmented fixtures and a real PTY
provider fixture, including independent children and reconnect. Real Claude
2.1.303 delivered a SessionStart hook after folder/MCP consent. This establishes
hook delivery, not a claim that every installed provider/version emits OSC 7501.
Real OSC negotiation/provider coverage remains an explicit stage-1 gate.

Dependency: `base64` 0.22.1 (already present transitively in Cargo.lock) provides
strict padded/unpadded UTF-8 field decoding without a custom codec.

## Diagnostics (F03)

`nesvo doctor` lists session integration health; `nesvo session explain ID`
explains one stable session ID. Append `--json` for schema version 1, or override
the private pairing file with `--pairing PATH`. `--help` is local and never opens
a connection. These commands authenticate but never attach, take control, send
input, or alter settings. An older host without the `diagnostics` capability is
rejected with an upgrade message before sending the additive command.

The authenticated `getDiagnostics {sessionId?,requestId?}` operation returns a
targeted `diagnostics {report,requestId?}` event. The report contains host/build
and helper identities, PID/launch identity, observed process age, selected status
and reason, last hook sequence/receive age, current screen hint, integration
delivery (`notObserved`, `missing`, `received`, `unreadable`, `malformed`,
`oversized`) and live OSC probe/report/rejection counts. It contains no pairing
key, lease, prompt, tool arguments, transcript, or report message text.

Delivery is cached asynchronously outside the state mutex. Helper failures write
only a constant private diagnostic marker and emit a constant stderr warning;
they still exit successfully so tracking failure cannot block the agent. The next
successful helper call clears that marker. A missing report does not claim that
the provider loaded its settings. Sequence ordering still identifies the legacy
wall-clock implementation until the F05 identity migration. Provider-version
probes and matched-rule IDs remain separate status-stage gates.

Explicit Claude quota capture has its own bounded attempt receipts and reader
health, separate from lifecycle delivery. Human `session explain` labels current
attempts, earlier completions and historical storage failures without printing
raw provider values. JSON preserves the same distinctions. See the
[capture delivery contract](harness-claude-quota-capture.md#capture-delivery-diagnostics);
these receipts do not establish backend freshness or permission to resume.

## Versioned screen rules (F04)

`apps/host/status-rules/v1.json` is an embedded literal catalog with schema,
revision, provider, source region and named match conditions. It is validated
and included in the host build identity. It cannot run scripts or read files.
Startup folder trust and MCP consent are explicit blockers. Matching only sees
the current screen; narrow tail/footer/cursor checks constrain the ordinary
provider rules. Screen-derived evidence remains inference and never authorizes
actions. `session explain` exposes the matched rule/revision/reason.

The corpus includes sanitized shapes observed with Claude 2.1.303 and existing
synthetic Codex/Gemini layouts. The Codex multi-question predicate remains a
tested code fallback pending catalog migration. Login/model-selection/viewer
screens and other provider versions are not certified by this initial catalog.

## Launch and conversation correlation (F05)

Each newly launched Claude process has a private journal bound to its host session,
an opaque launch ID, a provider conversation ID and a generation. SQLite assigns
strictly increasing event sequences inside bounded transactions. Observation
order between OSC and hooks is host-local, independent of wall-clock movement.
The default synchronous hooks await this short helper; delivery failure remains
fail-open and observable. Exact emission order from arbitrary asynchronous
third-party hooks is not claimed.

An empty `agent_id` is a root event; a nonempty or malformed one cannot update
parent status/context. Foreign-conversation events are rejected. Rebinding an
already known conversation requires SessionStart from clear/resume/compact rather
than a replayed startup. Context reports from a different conversation are also
ignored. Task/attempt authorization is a later orchestration boundary.

Journal-backed Claude and Codex helpers capture the host session, launch nonce,
optional bound provider and generation before reading stdin. The lifecycle write
compares every entry field inside its existing transaction before any binding,
turn, event or rejection-counter mutation. A callback delayed across a rebind
cannot stop newer work or rewind its conversation, including A → B → A. A stale
entry emits neither an event nor shadow status JSON. An unchanged unbound entry
can still establish the first lifecycle binding; context authority remains
separate. Existing native Codex turn checks still apply after the entry check.

This guards the interval between helper entry and journal append. A source-old
callback whose helper starts only after a rebind cannot be identified without
additional provider evidence. It does not establish Claude turn identity,
callback-start ordering within one generation, or status-file completion ordering
after an already accepted commit. Same-generation late Stop requires its own
provider correlation; this guard does not manufacture one.

The journal retains 1024 records, reads at most 256 per batch and reports cursor
gaps explicitly. Fast synchronous turns cannot overwrite each other between
polls. UI coalescing need not draw every short intermediate state; run/turn event
consumption is tracked separately. Diagnostics expose identities, cursor, gap,
rejections and shadow sequence. Only explicitly marked legacy scopes use JSON
compatibility; descriptor-less valid older journals retain lifecycle delivery.
Missing current storage never selects legacy mode. Cleanup validates ownership of the resolved private
temporary directory and briefly retries Windows read-handle races.

An interrupt plus a newly visible idle prompt settles the prior work observation.
That settlement persists after the short prompt-detection window; an old working
hook or protocol record cannot revive it on a later timer tick. New structured
evidence takes authority again. Silence alone never establishes that settlement.

Provider versions are probed once asynchronously at host startup through each
resolved launcher's literal `--version` argv. Probes have null stdin, no model
prompt, a two-second deadline and a 1024-byte output cap. Diagnostics cache only
the version token and checking/ready/unavailable outcome, never arbitrary output.
Listing capabilities or rendering does not spawn probes. Existing hooks, MCP,
authentication and configuration are not changed by this read-only probe.
