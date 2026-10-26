# Native Windows session process ownership

F39/F42 resource cleanup also requires ending owned provider/MCP descendants,
not merely the root process. Each newly spawned Windows PTY root is enrolled in
a private unnamed Windows job immediately after portable-pty returns its handle,
before the host starts its input/output/wait threads. Normal later descendants
join that job through Windows process inheritance.

Native stop requests termination of this exact job. A natural root exit also
requests termination of its remaining job members before publishing the observed
root exit. Existing receipt semantics remain: a stop request is acceptance, and
an observed root exit is not proof that every descendant has finished cleanup.
The OS job uses kill-on-last-handle-close so a host process death releases its
owned job members. The host's wait and PTY killer share one owned job handle;
cloning the killer cannot fail by attempting another OS handle duplication.

No process-name enumeration, PID-based tree killing, global console operation,
breakaway permission, UI restriction, CPU/memory limit or priority change is used.
Other sessions have separate jobs. This does not make Nesvo a sandbox or change
provider tool permissions. Unix keeps the existing portable-pty process-group
behavior. Windows builds use additional features of the existing `windows-sys`
dependency, without adding a package.

## Console host lifetime and teardown order

portable-pty 0.9.0 loads `conpty.dll` by bare name, so a third-party copy on
`PATH` (WezTerm ships one with its `OpenConsole.exe`) silently replaced the
system ConPTY. That console host is not a job member and waits for the answer to
its startup cursor query; when its pipes closed first (host exit, a dropped
session or a test ending) it spun at full CPU forever and `ClosePseudoConsole`
blocked waiting for it. Before the first pseudo console the host therefore
restricts its DLL search to System32, so every session uses the system
`conhost.exe`, which exits when its pseudo console closes or the host process
dies. Teardown runs in this order: a stop answers a still pending startup query
and terminates the session job; the wait thread observes the root exit,
terminates remaining job members and closes the pseudo console before publishing
the exit; dropping a session closes its input channel and then the pseudo console
if the exit was not observed; the output reader keeps draining until EOF even
after its event channel is gone, because `ClosePseudoConsole` waits until its
final frame is read. Resizing an exited session's released console is a no-op.

## Graceful shutdown settlement

A graceful host stop does not return while a session job may still hold files.
Each native session job is recorded in a host ledger under its session id. Every
termination request (stop, natural root exit, dropping the last session handle)
first pins the job's current members by handle, rechecking each opened process
with `IsProcessInJob` so a reused id is never pinned, and then terminates the
job. The ledger entry is released only when the last session handle is gone:
the wait thread holds one until it has closed the pseudo console, the session
holds one until it is dropped, and the output reader holds one until its pipe
reaches end of stream, which happens when the console host closes its side.
`ClosePseudoConsole` on current Windows 11 builds can return while the console
host is still running, so its return alone is not treated as the release. The
host does not identify the console host by name or id. Dropping the last handle
also terminates the job, so the former kill-on-close behaviour is unchanged.

After the terminal cleanup workers, shutdown waits for every recorded job until
its console handle is released, the job reports zero active processes and every
pinned member handle is signaled. The wait is event driven: once the console
handle is released it associates a private completion port with the job, and
every wake first pins the job's current members again, so a descendant started
after the termination request is held by handle too. While pinned members remain
it waits on their handles directly; with none left it waits on the completion
port for the next job notification. Pinning reads the job's process list at that
moment, so a member that starts and exits between two reads is never pinned and
settlement relies on the job's active-process count alone for it. It shares the
existing eight-second terminal cleanup bound instead of adding a clock of its own. A job still unsettled at that bound
is reported on the host log by session id, for example `Session job ID still had
active processes at the shutdown bound`, and the host still exits; kill-on-close
then ends any remaining member when the host process ends. On Unix the job is
the session's process group (portable-pty makes the root a session leader);
shutdown waits for the group to have no members, rechecking with a short capped
backoff because Unix has no group-exit notification. The Unix stop signal is
unchanged.

## Failure and boundary conditions

Job creation/configuration/enrollment failure refuses the launch with context
and attempts termination through the already-owned root handle. It never falls
back to silently claiming process-tree containment. The adapter calls Win32
directly because portable-pty 0.9.0's Windows root killer reverses the successful
`TerminateProcess` return condition.

This enrollment is **after** native spawn: portable-pty 0.9.0 does not expose
atomic job enrollment or suspended startup. Descendants created before enrollment
are not retroactively claimed. Processes created through external brokers/WMI
are also outside ordinary job inheritance. The host does not identify or kill
such processes by guessing a name/PID. Those limitations remain relevant to
original-provider cleanup measurements and future atomic launch work.

Nested jobs require Windows 8/Server 2012 or later and compatible enclosing job
policy. An incompatible enclosing job can refuse enrollment. Unnamed handles
are noninheritable and remain within the host; callers cannot choose a job or
obtain its termination capability.

The implementation follows Microsoft's [job lifetime and process inheritance](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[process enrollment](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)
and [job termination](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)
contracts. It does not claim containment of all possible brokered processes.

## Verification

A Windows native unit test launches the current Rust test executable through real
ConPTY, using a separately selected ignored fixture entry point. It needs no
Node, shell or original model. Root, child and grandchild each publish their PID
and native creation timestamp in a private temporary directory. The test pins
and checks exact process handles before observing termination; failure cleanup
uses those retained handles, never a reusable PID.

Both explicit stop (including a repeated kill) and natural root exit must end
all three observed identities within five seconds while another independent PTY
stays alive. The real terminal protocol decoder answers ConPTY startup queries.
The targeted Windows scenario passes. Full host/SDK/CI coverage and an additional
original-provider cleanup result are separate evidence; this does not erase the
earlier failed five-second original-model cleanup observation.

A second native fixture is an owned host process holding a ConPTY job. Abruptly
terminating that exact host handle must also end its pinned root/child/grandchild
within five seconds, without cooperation or inherited job handles. This scenario
passes locally as well; it exercises OS handle lifetime rather than graceful
host shutdown alone.

Console hosts are observed only by tests: a detached fixture process lists its
direct `conhost.exe`/`OpenConsole.exe` children through a process snapshot and
pins them by handle, rejecting any created before the fixture. A host-state
fixture with two shell sessions must have exactly two system console hosts and no
loaded `conpty.dll`; stopping one session ends exactly one of them within five
seconds and dropping the state ends the other. The host-death fixture adds a
pseudo console whose startup query is never answered, and both of its console
hosts must end within five seconds of the hard kill. A second run of the console
fixture shuts the host state down gracefully instead of dropping it: the session
job ledger must settle with nothing to report, and the remaining console host
must end within five seconds. Host unit tests drive the
ledger with an owned descendant held by its standard input: settlement returns
only after the console handle is released and the descendant has exited, and a
zero bound reports the named job instead of waiting.

The Windows CI jobs add a coarser, process-list based check around their test
steps: `scripts/console-orphans.ps1` fails the job when a console host created
during the tests outlives its owning process ([contributor gates](engineering.md#contributor-gates)).
