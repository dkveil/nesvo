# Provider quota observations

`providerQuotaObservations:true` advertises the owner-only `getProviderQuota`
command, `nesvo quota` and `nesvo_get_provider_quota`. These share one host
observer; clients do not run local provider commands against a remote path.
Only installed providers appear. This is account quota metadata, not context
window usage, network reachability or a promise that a model call will succeed.

```powershell
nesvo quota --json
nesvo quota --program codex --refresh --json
nesvo quota --program codex --json
```

The MCP tool accepts optional `program:"codex"|"claude"|"gemini"` and
`refresh:false`. Setting `refresh:true` requires an explicit program. Older hosts
fail the capability check; neither client falls back to an unverified source.
Scoped worker/coordinator credentials cannot read or refresh this owner view.
Owner `doctor --json` also includes `providerQuota`; scoped session diagnostics
omit it.

## Sources and bounds

- Codex: the resolved original CLI's local `app-server`, with an explicit host
  folder and `CODEX_HOME`. The only RPCs are `initialize`, `initialized`,
  `account/read` with `refreshToken:false`, `config/read` with the actual folder
  and `includeLayers:false`, and the full `account/rateLimits/read`.
  Sparse quota notifications cannot create a full
  observation or renew permission. No login, auth refresh, turn or model RPC is
  issued. The host does not read credential files.
- Claude: the existing quota-only `.rate-limits.json` status-line cache under
  `CLAUDE_CONFIG_DIR` or the user's `.claude` directory. Nesvo does not install or
  modify a status-line producer. Missing/invalid cache remains unavailable. Reads
  accept regular files only, validate the opened handle and have a two-second
  deadline; special files cannot hold the observer in a blocking pipe read.
- Gemini: no implemented structured source; its installed entry explicitly
  reports `unsupported`. It is not displayed as zero usage.

Codex reads have an eight-second deadline, a 256 KiB line bound, 1 MiB aggregate
bound and 64-frame bound. Cleanup has a two-second observation bound. Unconfirmed
cleanup keeps the exact child and sole-reader permit until reaped; a later read
cannot create a parallel replacement. Provider error bodies are not published.
Normal polling remains 120 seconds for Codex and 15 seconds for Claude. Owner
refreshes share these observers, coalesce while queued/in progress and have a
five-second minimum interval between read starts. They never prompt a model.

Refresh acceptance is asynchronous. The reply contains current `providers` and
`refresh:{program,state,revision,retryAfterMs}`. `queued` or `pending` identifies
the target next revision; query again to observe completion. `cooldown` admits
no new read and returns the current revision plus the remaining wait. Refresh
does not mean that quota is available. A source attempt, including an unchanged
result or failure, increments its revision.

## Freshness and authority

Each view separates `attemptedAt` from the last successful `observedAt` and the
original cache `sourceAt`. Codex freshness uses monotonic time from read start,
with a 180-second bound. Claude also retains its original cache age, bounded at
900 seconds, and rejects excessive future timestamps. Repeated reads cannot
renew an unchanged cache. Clock rollback cannot extend the original deadline;
an elapsed reset requires a newer observation rather than inferred recovery.

`status` describes metadata health: `checking`, `ready`, `partial`, `unavailable`
or `stale`. `freshness`, `reason`, `complete`, `expiresAt` and `ageMs` explain it.
A failure immediately removes positive permission, even if last-known windows
remain in diagnostics. The compatible `providerLimits` panel clears unavailable
or stale values instead of presenting them as current.

`ordinaryUsageAllowed` is nullable backend evidence from a full Codex response.
It is never reconstructed from percentages or reset times. Reader eligibility
additionally requires complete current windows, no exhausted window or explicit
spend/rate denial, and nonempty account/context metadata. Missing and null
windows remain distinguishable internally; malformed present windows invalidate
the result instead of disappearing from the list.

Every public view says `scope:"readerSnapshotOnly"`. `ordinaryUsageEligible`
describes this snapshot only. It does **not** bind the reader's account to a
historically running native session, reserve provider capacity, launch a job or
authorize continuation. Jobs can still be refused by the original provider.
The separate explicit [configured-account job policy](harness-quota-jobs.md)
uses this evidence together with route inspection and final native checks.
Legacy direct-PTY wake still has its separate receipt-backed acceptance gap.

Raw account IDs, home directories, argv, paths and provider errors are never in
this view. `accountFingerprint` and `contextId` are opaque HMAC values scoped to
one host epoch, not portable identities or credentials. Nothing restores quota
authority across a host restart.

The existing explicit quota wake now disarms on successful human acquisition,
known reader account/context changes and host shutdown, including acquire/release without typing. A failed quota read
cannot refresh its legacy freshness timestamp. Its existing volatile/direct-PTY
continuation is not the durable receipt-backed quota queue required by full F44.

No dependency was added. Controlled native acceptance uses private Node RPC/PTY
fixtures and the official MCP SDK, not original model calls or user settings.
