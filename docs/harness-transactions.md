# Shared SQLite writer admission

The metadata store and durable journal use separate connections to the same
`metadata.sqlite3` database. WAL permits concurrent readers, but still has one
writer. Receipt/workflow mutations must reserve write access **before** reading
the state they intend to change, using SQLite `BEGIN IMMEDIATE`.

A deferred transaction can read while another connection owns the writer lock.
Its later read-to-write upgrade can return `database is locked` immediately,
without invoking the busy handler. Merely increasing busy timeout does not fix
that upgrade race. It could leave a native operation's caller with an uncertain
outcome, requiring original-key recovery despite no intended competing action.

Receipt initialization/accept/claim/finish, keyed workflow mutations and inbox
send/ACK now acquire write admission first. Pure inbox reads retain ordinary
read transactions. Work stays on the existing bounded journal thread, with the
existing 50 ms contention limit. There is no new retry loop, native input replay
or promise that an unavailable disk always accepts writes. A lost response still
requires original-key recovery and native effects remain outside transactions.

The regression test holds a competing writer and uses a busy-handler/channel
barrier, without sleeps, to release it only after receipt admission waits.
The former deferred implementation fails with `database is locked`; immediate
admission passes and preserves same-key receipt replay. Native integration's
earlier transient unconfirmed operation was not instrumented with an SQL code,
so its exact cause remains unproven even though this conflict is reproduced.
