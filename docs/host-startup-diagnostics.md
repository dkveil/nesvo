# Host startup diagnostics

Set `NESVO_STARTUP_DIAGNOSTICS=1` in the host process environment to enable
bounded startup-phase evidence. Unset and other values disable it. Use the normal
host arguments and data-directory ownership; this option changes neither.
Hidden helpers, build identity and CLI help/version return before activation.
No global setting, database record, provider command or additional thread is
created by tracing.

The host writes explicitly flushed stdout lines prefixed `NESVO_STARTUP_PHASE `.
Their fixed schema contains `schemaVersion:1`, increasing `sequence`, static
`phase`, `event:begin|end`, monotonic `elapsedMs`, nullable `durationMs` and
nullable `outcome:ok|failed`. A begin has no outcome. Explicit result handling
can record failure without changing the returned error; an unfinished/dropped
span never invents an end or success. Labels and numbers contain no SQL, paths,
prompts, pairing keys or raw errors. Ordinary startup output remains separate.

Phases cover runtime creation, workspace resolution, listener binding,
advertisement, pairing preparation/lock/permissions, metadata open, journal open,
the initial durable event, launcher discovery, state initialization, optional
webhook binding, runtime installation and readiness announcement. Binding a port
does not establish application readiness. The existing listening line remains
the readiness handshake. `journalOpen` deliberately covers initialization and
recovery together; it does not identify an individual SQL statement.

One process-local writer orders records. Its lock is released before startup work
or awaits. At most 128 records of 256 bytes each are emitted (32 KiB total).
Write/flush failure disables further tracing without retrying or replacing the
startup result. Tracing ends with readiness; no recurring observation or
broadcast is added. Disabled tracing has no active emitter or per-phase clock
read. An undrained diagnostic stdout pipe can still block, as ordinary synchronous
stdio can; this is not a startup performance guarantee.

## Controlled native test evidence

The SDK fixture explicitly opts in for each owned child and restart. It keeps
the same 60-second readiness deadline and owned kill/reap behavior. Its existing
stdout reader consumes prefixed records before matching the listening line and
continues draining after readiness; closing the pipe there could race the host's
remaining startup lines and cause a platform-specific `BrokenPipe`. A bounded
strict parser retains only known fields, labels, sequence and duration evidence.
Invalid/oversized/out-of-order records increment fixed rejection counters; their
text is never echoed.

`NATIVE_HOST_STARTUP_DIAGNOSTIC.startupTrace` reports records, active phases,
last completion, elapsed time and completeness. Each newly spawned child gets
an independent collector starting at sequence one. Existing files from an older
host do not establish progress by the replacement. No record means unknown;
an unmatched begin identifies only the last observed boundary. Scheduling,
diagnostic I/O or work within that boundary can all explain delay. Capped or
rejected output is explicitly incomplete. No timeout, retry, SQLite durability,
recovery or readiness policy is relaxed.

After building the native host/client, run the controlled fresh/restart scenario:

```text
cargo test --package nesvo --test mcp_host --locked startup_trace::startup_phase_records_identify_fresh_and_restarted_owned_host -- --ignored --exact --test-threads=1
```

It uses a private controlled host with no model prompts. It checks the phase
order, independent restart evidence, unchanged pairing key, normal authenticated
MCP access and owned cleanup. Pure tests cover disabled tracing, early drop,
write/flush failure, fixed bounds, strict parsing and private-input rejection.

## Schema initialization boundary

The journal applies its pending numbered migrations in one immediate SQLite
transaction. They hold DDL, additive columns and default budget insertion;
it does not dispatch work. Receipt and quota recovery remain before this batch,
and workflow/job recovery remains after it. Those recovery operations keep their
own existing transactions and ordering. WAL, synchronous FULL, foreign keys and
the existing busy timeout are unchanged.

A schema error rolls back the batch, including earlier additive columns and
defaults. It does not roll back previously committed receipt recovery. Fresh,
warm, published-schema migration and late-failure regressions verify preserved
host identity, workspace revision, raw specification bytes, generation pointers
and receipt recovery without duplicate events or new dispatch authority.
