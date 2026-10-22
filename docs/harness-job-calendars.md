# Host job calendars

The durable [job API](harness-jobs.md) accepts `once`, `cron` and `rrule`.
`jobScheduleKinds` advertises them. Updated clients refuse recurring requests
against an older once-only host before submitting a mutation. Existing once
definitions, occurrence history and original mutation acceptances remain valid.
Legacy schedule APIs/storage are unchanged. There is no new job UI in this slice.

## Schedule specifications

Replace the `schedule` in a job specification, retaining its explicit native
task profile, instruction, misfire, overlap and elapsed budget:

```json
{ "kind": "cron", "expression": "0 9 * * MON-FRI", "timeZone": "Europe/Warsaw" }
```

Cron uses five fields: minute, hour, day of month, month, weekday. Lists, ranges,
steps and names use Croner 4's grammar; matching day-of-month and day-of-week use
its default OR semantics. Seconds/year fields and macros are refused. The host
resolves wall times itself, so a DST gap cannot be silently shifted to a time
which does not match the expression.

```json
{
  "kind": "rrule",
  "rule": "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=12",
  "start": "2026-11-02T09:00:00",
  "timeZone": "Europe/Warsaw"
}
```

```json
{
  "kind": "rrule",
  "rule": "FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20271231T235959Z",
  "start": "2026-11-01T09:00:00",
  "timeZone": "Europe/Warsaw"
}
```

`timeZone` defaults to `Europe/Warsaw`, is stored explicitly and must name an
IANA zone. It never uses the host OS's timezone. `start` is an existing local
date-time, exactly `YYYY-MM-DDTHH:MM:SS`, resolving to an instant at/after the Unix
epoch. It supplies the original recurrence defaults. An RRULE is one uppercase
RFC5545 Gregorian rule, not an iCalendar file or recurrence set. A new or edited
definition must have a future occurrence. An old start is allowed within the
bounded search; `COUNT` still counts occurrences since that original start.

Supported parts: `FREQ`, `INTERVAL`, `COUNT`, `UNTIL`, `BYSECOND`, `BYMINUTE`,
`BYHOUR`, `BYDAY`, `BYMONTHDAY`, `BYYEARDAY`, `BYWEEKNO`, `BYMONTH`, `BYSETPOS`,
`WKST`. Invalid frequency/part combinations, duplicate/unknown parts, RSCALE/SKIP,
leap seconds, SECONDLY frequency and COUNT above 10000 are explicitly refused.
COUNT and UNTIL are mutually exclusive. Zoned `UNTIL` must be UTC
`YYYYMMDDTHHMMSSZ`, and that absolute instant is inclusive. There are no RDATE,
EXDATE or overridden instances yet. An inconsistent DTSTART/RRULE yields only
rule-matching candidates, not an extra forced DTSTART occurrence.

## DST and absolute identities

- Generated nonexistent local times are omitted, without consuming COUNT.
  Warsaw daily 02:30 skips 2027-03-28; a five-occurrence rule starting March 26
  finishes March 31. Invalid month dates likewise do not consume COUNT.
- A repeated local time means its first UTC instant only. Warsaw 02:30 on
  2026-10-25 runs at 00:30Z, never again at 01:30Z. The same policy applies to
  dense cron rules and to RRULE.
- Dense RRULEs iterate local wall time, like cron. A MINUTELY or HOURLY candidate
  in a gap is omitted and the search continues forward to the next existing
  candidate: Warsaw `FREQ=MINUTELY;INTERVAL=15;BYHOUR=1,2,3` goes from 01:45+01:00
  to 03:00+02:00 on 2027-03-28. In a fold each civil candidate keeps its first
  instant, so the repeated hour has no occurrences: Warsaw `FREQ=HOURLY;BYMINUTE=0,30`
  goes from 02:30+02:00 to 03:00+01:00 on 2026-10-25, and New York
  `FREQ=HOURLY;BYMINUTE=0` goes from 01:00-04:00 to 02:00-05:00 on 2026-11-01.
  Successive results are strictly increasing UTC instants.
- An explicitly provided RRULE start in a gap is refused; an ambiguous start
  resolves to the first instant. This strict input policy is distinct from
  RFC5545's interpretation of an explicitly supplied DATE-TIME in a gap.
- The persisted next due, occurrence due and deduplication identity use UTC
  milliseconds. Reopen/restart or clock rollback does not reinterpret an already
  persisted term or recreate an admitted occurrence.

Civil expansion comes from the calendar library. The host applies IANA resolution
before counting instances, and compares UNTIL as UTC. It does not copy the civil
iterator's naive UNTIL comparison into a zoned schedule.

## Sleep, changes and failure

After downtime, one automatic occurrence represents the latest rule-matching slot
at or before the timer snapshot. Its `coalescedFromAt` identifies the original
pending due when slots were merged. `dueAt` is the latest slot; the original
misfire/grace policy is checked against that slot. Older intermediate slots do
not create a model backlog or individual occurrence records. This bounded
coalescing policy is explicit; it is not a claim that every missed run executed.
The successor is strictly after the timer snapshot. Overlap skip/one-deep queue,
native admission, result validation and restart reconciliation retain the job
contract's behavior. A manual occurrence does not move the automatic calendar.

Calculations run off the serial SQLite worker. Applying a result checks the exact
job configuration revision, enabled state and original pending UTC cursor in the
same transaction as occurrence insertion and cursor advancement. An edit or
disable during evaluation wins. Timer advancement does not change the definition
revision. Each admitted occurrence keeps its original spec/revision.

`calendarState` is `ready`, `exhausted` or `blocked`; `calendarError` contains a
bounded code/message or null. Exhaustion means no future COUNT/UNTIL instances,
not worker success. A calculation error while advancing retains the already
confirmed due occurrence, sets a durable calendar error and clears the next
cursor. It never guesses a successor, hot-retries the bad rule or silently claims
it ended. Inspect with `nesvo job show JOB_ID --json`, then explicitly edit the
definition to repair it; enable alone does not clear that error. Temporary
`calendar_busy` leaves due intent intact for the next ordinary timer tick.
Original-key replay still returns its immutable acceptance even if a fresh
calendar evaluation is now exhausted, blocked or unavailable.

## Bounds and dependencies

The same host executable has a private pure calendar mode, entered before
provider discovery, host runtime, pairing or database initialization. Its parent
owns the input/output pipes; it inherits no environment or shell, performs no
model calls, and has no descendants. The adapter allows two concurrent helpers,
4096 input bytes, 2048 output bytes and 750 ms of execution. On timeout, excess
output, parser/protocol failure or process failure, it kills and reaps that exact
child. No helper runs on quiet timer ticks, in rendering or inside a SQLite
transaction. Once instants need no subprocess.

Calendar work also has candidate bounds: 4096 cron gap/fold candidates per
direction, 200000 RRULE candidates per evaluation (generated candidates, gap
candidates included), at most 100000 candidate values per civil period, and at
most 64 upcoming instants per request. The engine's own barren-period/year limits
are not trusted as evidence of rule exhaustion.

RRULEs without COUNT whose frequency is MINUTELY, HOURLY, DAILY or WEEKLY seek
instead of walking from the original start, whatever their `BYHOUR`, `BYMINUTE`,
`BYSECOND`, `BYDAY`, `BYMONTHDAY`, `BYMONTH`, `BYSETPOS` and `UNTIL` parts. The
expansion restarts two periods before the query instant on the original
`INTERVAL` lattice, which keeps every period's candidates and `BYSETPOS` positions
identical to the walk from the original start. When no earlier occurrence lies in
that window, a binary search over lattice periods (at most 64 probes) finds the
latest period holding one, so the previous slot of a sparse rule such as
`FREQ=MINUTELY;BYMONTH=1;BYMONTHDAY=1;BYHOUR=0` is exact without visiting the
months between. COUNT rules still walk from the original start because COUNT
counts from there; COUNT is at most 10000. MONTHLY and YEARLY rules also walk from
the start.

A search that would exceed its candidate bound, or a rule with more than 100000
candidates in one period, fails with `schedule_too_dense` and a message naming
both bounds. A rule the engine stops expanding without an occurrence, such as
`FREQ=MINUTELY;BYSECOND=0;BYSETPOS=2`, fails with `calendar_limit`; the adapter
deadline fails with `calendar_timeout`. None of them reports partial dates or a
false completion. Re-anchor or simplify deliberately, taking original COUNT
semantics into account. Subsecond scheduling is unsupported.

Three production dependencies are pinned to the source-reviewed/tested versions:

- `chrono-tz 0.10.4`: compiled IANA rules and explicit gap/fold resolution,
  independent of the OS timezone; its PHF data adds no external service.
- `croner 4.0.1` with only its Chrono feature: cron parsing and civil next/previous
  search, instead of a handwritten expression parser.
- `ical-rs 0.5.1` with only parsing enabled: validated Gregorian RFC5545 civil
  expansion, ordinal weekdays and invalid calendar dates, instead of a custom
  RRULE implementation. COUNT and zoned UNTIL are enforced after IANA resolution.

They match the workspace Rust 1.88 minimum. The lockfile adds 15 packages,
including these three, PHF and Croner's derive macros; existing package versions
are preserved. This adapter does not add a TUI or mobile dependency. IANA rule
updates require an intentional dependency update and repeated DST tests.
