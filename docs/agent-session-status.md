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
- Gemini 0.65.0: launch-local lifecycle adapter through an extension the owner links once, plus versioned screen rules. Other versions and unlinked installs keep screen inference only. See the adapter boundary below.
- Agents started manually inside a generic shell do not inherit a dedicated provider adapter. A shell whose prompt emits OSC 133 marks is idle at its prompt and working during a command; see [provider status signals](provider-signals.md) for every signal's source.
- Hooks disabled by user/managed settings fall back to screen inference. Unknown is deliberately retained when there is no trustworthy evidence.

References: [Claude hooks](https://code.claude.com/docs/en/hooks), [Gemini hook reference](https://geminicli.com/docs/hooks/reference/).

## Freshness

Every projected session state carries a freshness record for clients that
negotiate it: `observedAt` (host epoch milliseconds at which the selected
evidence was received), `ageMs` at projection time, `source`, `stale`,
`boundMs` and `lastKnown`. The bounds live in one table, `BOUNDS` in
`apps/host/src/freshness.rs`, which capabilities also advertise as
`sessionFreshnessBounds`.

| Source    | Selected state                                                  | Measured from                       | Stale after                                                                |
| --------- | --------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| `hook`    | provider lifecycle hook (Claude, Codex, Gemini)                 | last successful launch-journal read | 4000 ms: twice the 2 s lifecycle drain bound; the reader runs every 500 ms |
| `process` | observed process exit                                           | exit observation                    | never; exit is final                                                       |
| `journal` | last hook record once the journal is no longer read             | that record's host receipt          | 4000 ms, so a disconnected projection is always stale                      |
| `unknown` | screen rule, shell prompt mark, OSC 7501 report or terminal I/O | last state transition               | no bound; no freshness claim                                               |

Providers send no heartbeat. Agent silence while the journal is still read is
not staleness: a long tool call stays `working` with a growing age, consistent
with the rule that silence never clears confirmed work.

Disconnect policy: when the host has not confirmed the launch journal for longer
than the hook bound (read failure, unreadable or removed journal, stalled
reader), the projection switches to `source: journal`, `state: unknown` and
`stale: true`, and keeps the previous state as `lastKnown {state, observedAt}`.
`lifecycle.agent.current` becomes null with `freshness: unknown`. No progress,
idle or completion is inferred. The next successful read restores the hook
projection with the last record or a newer one. Process exit always wins.
Attention, readiness and turn tracking keep their own rules and are not changed
by this projection.

Negotiation: a client sends `getCapabilities {sessionFreshness:true}`. The host
advertises `sessionFreshness:true`, sends that client one fresh snapshot after
its first opt-in, and adds the record only to that connection's `sessions`
snapshots and `session` replies. `ageMs` is measured by the host at projection, so
clients add only their own elapsed time; `boundMs` is the source's stale bound or
null.
Clients that do not opt in receive the previous shape and state unchanged; older
hosts ignore the field.

The TUI marks a stale row `?working` (the last known state) and shows the
evidence age (`!12m` when stale); the pane footer reads `hook 2m`,
`exit 3m ago` or `stale · last working 12m ago`. The mobile dashboard reuses
the freshness badge with `Last known working`, and renders as before when the
record is absent or its source is `unknown`.

Host tests cover the bounds, transitions and disconnect policy with Claude,
Codex and Gemini hook payloads through the production state mappers. The live
lifecycle matrix with real provider hook delivery (prompt, approval, interrupt,
clear, exit and journal loss, compared against `nesvo session explain`) has not
been run and stays with the owner.

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

## Gemini native adapter boundary

Gemini CLI 0.65.0 has no per-launch settings overlay. Its settings path
overrides replace the managed system layers and are skipped unless the file
passes the provider's ownership checks, and `GEMINI_CLI_HOME` moves login,
trust and history together. The adapter therefore ships one extension,
`nesvo-lifecycle`, that the owner links once. At startup the host writes its
source to `gemini-extension/` in the private pairing directory and rewrites
only bytes that differ from the expected definition. The host never links or
enables it, never passes `--consent` or `-e`, and never edits Gemini settings,
trust or approval policy. Owner step:
`gemini extensions link <pairing>/gemini-extension`, then accept the provider's
hook review.

The extension subscribes to SessionStart, BeforeAgent, AfterAgent, BeforeTool,
AfterTool and Notification with one command naming the host's canonical path
and pairing directory, never the environment (project `.env` files can add to
it; exact-name `advanced.excludedEnvVars` skips `.gemini/.env`). A moved host
rewrites the source and reports `stale` until the owner relinks once (uninstall
`nesvo-lifecycle`, then link). The helper appends only as the recorded executable
for an existing launch scope there named by `NESVO_LIFECYCLE_REPORT`; it always
prints `{}`, exits 0, never writes stderr and leaves only a constant failure marker.

Hooks are configured only for exactly 0.65.0 (previews and other releases are
unsupported, with the probed version in the reason) and only while the
extension metadata links to this host's unmodified source. Diagnostics report
this as `geminiIntegration`: ready, version, extension state, source, reason
and `turnIdentity: unsupported`. Configured is separate from observed: hooks
disabled in Gemini settings, a disabled extension or strict environment
sanitization appear as missing delivery, never as idle.

Each launch passes a fresh random `--session-id` and pre-binds the journal to
it. Callbacks from any other native session are rejected, including child
Gemini processes that inherit the environment. Only SessionStart `clear` (the
provider's `/clear` creates a new ID) rebinds and fences the old generation.

| Native event                       | Projection                                            |
| ---------------------------------- | ----------------------------------------------------- |
| SessionStart `startup` or `resume` | identity and delivery only; startup can precede login |
| SessionStart `clear`               | idle                                                  |
| BeforeAgent, BeforeTool, AfterTool | working                                               |
| AfterAgent                         | idle: response loop ended, never done or task success |
| Notification `ToolPermission`      | blocked, permission                                   |
| SessionEnd, PreCompress, model     | ignored; process exit stays authoritative             |

Gemini hook input has no turn, prompt or agent ID, so turn identity is
unsupported: no host turn, prompt receipt or settled response is derived, and
native event names keep other providers' Stop/turn handling from consuming
them. There is no StopFailure or Interrupt hook. Cancellation, errors and denied
approvals keep the last state until the next event, a visible screen rule or
process exit; after an approval, blocked remains until the next tool or agent
event. Built-in subagents share the session, so tool events only ever mean
working. AfterAgent precedes other hooks' retry decisions and can be followed by
more work. Prompts, responses, tool arguments and transcripts are never stored
or read.

Screen rules (revision 2026-10-22.1) cover the 0.65.0 sign-in choice and
authentication wait (blocked, rule reason `login`), model selection (question),
folder trust (blocked, setup), command, edit, fetch and MCP approvals
(blocked, permission), the response timer (working) and the empty input prompt
(idle, refused while the timer, an embedded shell or an approval choice is
visible). Their fixtures are synthesized from strings and layout in the installed
0.65.0 package, not captured from a running session. Esc followed by a newly
drawn empty prompt settles a cancelled response; an empty prompt alone never
overrides confirmed work.

No real Gemini hook delivery has been observed yet: the provider has no login on
this host. Live acceptance needs the owner's login and extension link, then one
prompt with a tool approval, `/clear` and exit, compared against
`nesvo session explain`.

Sources: [hook reference](https://geminicli.com/docs/hooks/reference/),
[extension reference](https://geminicli.com/docs/extensions/reference/). Input
shapes, hook runner, settings loader and extension loader were checked in the
installed 0.65.0 package.

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

The corpus includes sanitized shapes observed with Claude 2.1.303, existing
synthetic Codex layouts and Gemini 0.65.0 login, model-selection, folder-trust
and approval shapes synthesized from the installed package. The Codex
multi-question predicate remains a tested code fallback pending catalog
migration. Other providers' login/model-selection screens, viewer screens and
other provider versions are not certified by this catalog.

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

A Gemini journal is pre-bound to the fresh native session ID passed at launch;
startup or resume callbacks from another ID are rejected and only a provider
clear rebinds. Gemini supplies no turn identity, so none is inferred.

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

Reverse completion of compatibility JSON writes cannot reorder the current
host's canonical lifecycle. Its shadow reader updates delivery diagnostics and
`shadowSequence` only; lifecycle, turn and input correlation consume the ordered
journal batch. A journal read failure does not fall back to JSON status. This
does not protect an old JSON-only host or identify a source-old callback whose
helper first enters after rebinding: a permitted clear/resume/compact event can
then acquire the current ticket. Those are separate compatibility/provider
identity limits rather than a current shadow-file status regression.

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
prompt, a ten-second deadline and a 1024-byte output cap. The deadline only reaps a
hung CLI: a Node-based CLI can need more than two seconds to answer under load,
and a timed-out probe stays unavailable until the host restarts. Diagnostics cache only
the version token and checking/ready/unavailable outcome, never arbitrary output.
Listing capabilities or rendering does not spawn probes. Existing hooks, MCP,
authentication and configuration are not changed by this read-only probe.
