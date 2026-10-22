# Host data-directory ownership

One upgraded host owns a pairing/data directory at a time, including when hosts
request different listening ports. Before reading/rotating keys, rewriting pairing
files or opening metadata, startup takes a nonblocking exclusive OS lock on
`host.lock`. Another owner fails with guidance to reuse the running host or choose
a separate `--pairing-dir`. This prevents a second host from reconciling the first
host's live metadata or replacing its pairing credentials.

The lock lasts through metadata-writer shutdown, including error/cancellation
paths. The OS releases it on process death. The filename deliberately remains:
an existing file is not evidence of a running host. Do not delete/replace it to
bypass a live lock; unlinking could create two independently locked files.

Windows uses `LockFileEx`; Unix uses `flock`. No PID polling, heartbeat, lock-file
rewrite or startup spin loop is needed. The new Unix direct dependency on `libc`
exposes the OS call already present transitively in the lockfile. Existing
`windows-sys` receives filesystem/I/O features. This preserves Rust 1.88 instead
of raising the minimum version for newer standard-library file-lock APIs.

A Unix `flock` belongs to the open file description, so a duplicated or forked
descriptor shares it. Rust opens the lock file close-on-exec on Unix and
non-inheritable on Windows, but a forked child still holds the shared lock until it
calls `exec`. The guard therefore ends its ownership with an explicit unlock on
drop: close-on-exec alone does not cover the interval between `fork` and `exec`.
See [Apple's flock(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html)
and [Linux flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html).

This is coordination between upgraded hosts, not fencing of an older binary
that never acquires this lock. Reuse or stop an older host deliberately before
starting an upgraded host against the same directory. Process/worker adoption
after host failure is a separate recovery decision; acquiring the directory
does not prove that every old provider process has exited.

Verification includes live exclusion, release with an existing filename and a
native isolated-host test: a conflicting `--rotate-key` launch on a different
port must fail without changing pairing, while the first host remains reachable.
After terminating only that test's empty host, the same directory/key must start
again. Native Windows is checked locally; Unix runtime coverage belongs to CI.
