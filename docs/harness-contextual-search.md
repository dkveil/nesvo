# Contextual session search

F31 adds advisory repository and branch evidence to the existing shared session
matcher. Session name, provider, cwd and group terms keep their existing meaning
and ranking. Both quick search and the expanded palette accept current ready
repository/branch labels; detached repositories contribute only their name.
Checking, unavailable, stale, malformed or omitted metadata adds no terms.

The source is explicitly the native launch directory, not an inferred current
agent directory. A later Edit/Write review location does not become search
metadata. This first slice does not follow provider cwd changes. No new shortcut,
layout, icon, sidebar width or ranking weight is introduced.

Opening search deliberately emits one existing authenticated `list` request while
connected. Query edits, paste, F2 expansion, rendering and PTY output do not request
Git work. A correlated successful local create response also requests one list;
foreign or duplicate replies do not. Query and exact selected session identity
survive unrelated metadata updates, including the same workspace revision. If a
selected session loses its only matching branch, selection clears; Enter cannot
open a substitute or resurrect the old cursor without deliberate navigation.

The additive DTO is specified in [protocol v2](protocol-v2.md) and the published
CLI/MCP JSON schema. All six fields are required inside a present object. Runtime
label bounds count UTF-8 bytes; JSON Schema `maxLength` counts characters, so the
runtime boundary remains stricter for multibyte labels. TUI optional-evidence
parsing and mobile strict optional-field parsing intentionally differ on malformed
present data. Both remain compatible with old hosts omitting the field.

## Integration status

The client matcher, request intentions, DTO validation, schema and bounded host
source are implemented. Controlled native Windows acceptance covers the actual
host/helper/Git path, official MCP SDK, owner CLI and one real cooldown/reconnect
boundary. Ordinary Git fixtures additionally cover linked worktrees, detached
HEAD and a non-repository. This evidence does not establish physical-phone or
interactive macOS/Linux acceptance. The source remains the launch directory;
current provider cwd tracking is a separate limitation. No dependency, Expo API,
SDK, launch authority or provider configuration is changed.

## Host inspection contract

The host retains the canonical launch path and a private incarnation token for
every session. Only authenticated connection and explicit authorized List create
metadata demand. Current visibility is checked again before claiming queued
work and accepting a result. A removed/recreated process cannot inherit an old
inspection, even with the same session ID/path. New authorized demand arriving
while an orphan inspection drains keeps its own ticket. Directory-sharing
sessions coalesce; different linked worktrees keep distinct branch observations.

There are at most sixteen subscriptions/directories/queued keys and one active
inspection. Every outcome has a thirty-second monotonic cooldown. Successful and
recognized-negative observations expire to stale without Git I/O; stale labels
are not searchable. Rendering, PTY output and publication never request Git.
Disconnect drops queued interest; an admitted read may finish bounded cleanup,
but cannot schedule another read. Elapsed wall time never renews evidence.

Inspection uses literal `rev-parse --path-format=absolute --show-toplevel
--git-common-dir` and `symbolic-ref --quiet HEAD` builtins, no shell composition,
network, hooks, changes or direct model APIs. An unborn symbolic branch is valid;
detached HEAD contributes no invented branch. Root/common paths and errors stay
private. For conventional `.git` common directories, linked worktrees share the
main checkout's name; otherwise the observed root basename is the fallback.
Unrecognized errors or output are unavailable, not proof of no repository. See
the upstream [path output](https://git-scm.com/docs/git-rev-parse) and
[symbolic-ref](https://git-scm.com/docs/git-symbolic-ref) contracts.

Read output and stderr are bounded. Inherited repository-routing, command-config
injection and Git trace destinations are cleared; normal user/system safety
configuration remains in force. No `safe.directory` override is added. One
three-second deadline spans capacity admission and both commands; cleanup has
two further seconds. Unconfirmed cleanup retains the one global slot instead
of treating timeout as process exit. Windows must enroll a waiting helper before
releasing Git: the standard [Git wrapper](https://gitforwindows.org/git-wrapper.html)
can spawn another process, while [job inheritance](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
applies after association. An uncontained direct-wrapper launch is not accepted
as verified cleanup.

Optional context is attached after baseline admission and recipient filtering.
The baseline's 48 KiB admission budget is unchanged. Whole objects in stable ID
order use at most 8 KiB additional serialized JSON within a 60 KiB snapshot
target, leaving envelope headroom below the existing 64 KiB plaintext bound.
Clipping omits optional objects; it never rejects an otherwise admissible launch
or invents a branch. Metadata has no durable event, authority, readiness or
workflow effect. Host shutdown seals demand before draining the retained worker.
