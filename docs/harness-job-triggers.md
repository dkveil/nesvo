# External job triggers

F27 adds owner-managed generic webhooks and a GitHub adapter to the existing
host scheduler. Delivery admits an occurrence; it does not directly start a
process. Existing overlap, precheck, launch, budget, result and validation rules
apply. Payload fields never become prompts, commands, paths or tool grants.

## Listener and authorization

The separate listener is off by default, including with `--lan`:

```powershell
nesvo-host --workspace C:\work\project --webhook-port 8091
nesvo doctor --json
```

`--webhook-port 0` chooses an ephemeral port. Doctor and capabilities report
`jobTriggerListener:{enabled,address}` with the actual `http://127.0.0.1:PORT`,
or null when unavailable. It always binds IPv4 loopback independently of the main
host address. Unexpected listener exit clears runtime availability.

The sole route is `POST /v1/job-triggers/TRIGGER_ID`. Owner administration uses
the existing authenticated host API, CLI and MCP; this port accepts neither
pairing keys nor administration. There is no CORS, TLS or public-bind mode.
Registering an external account webhook or deploying a TLS proxy is separate.
GitHub's public service cannot reach a loopback address directly.

Create a job using the [job contract](harness-jobs.md). An external-only job uses
`"schedule":{"kind":"external"}` with no timer due date or calendar helper.
Once/cron/RRULE jobs can also have triggers. Save this strict trigger spec:

```json
{
  "title": "Main push checks",
  "jobId": "REPLACE_WITH_32_LOWERCASE_HEX_JOB_ID",
  "jobRevision": 1,
  "adapter": {
    "kind": "github",
    "repositoryId": 123456,
    "repository": "owner/repository",
    "event": "push",
    "actions": [],
    "branch": "main"
  }
}
```

Use the exact current job revision. Generate a separate cryptographically random
32-byte secret, encode it as 64 lowercase hexadecimal characters and save that
text privately. The **64 ASCII text bytes are the HMAC key**, not the decoded
bytes. Never reuse pairing keys, another route's secret or a retired secret.
The host retains secret digests permanently to reject reuse and erases retired
secret material; the private host database contains the current credential.

```powershell
nesvo job trigger create --key register-main-push --file trigger.json --secret-file trigger.secret --json
nesvo job trigger show TRIGGER_ID --json
nesvo job trigger enable TRIGGER_ID --key enable-main-push --revision 1 --json
nesvo job trigger list --json
```

Creation starts disabled at revision 1. Mutations require a stable key; replay
returns its original immutable response and changed intent under that key fails.
Edits require the current trigger revision and a specification file. Job identity
and adapter kind cannot change in place. Edits reauthorize the exact job spec.
Job enable/disable changes revision without invalidating unchanged spec authority;
changing the specification requires explicit trigger reauthorization.

Generic adapter: `{"kind":"webhook","event":"checks:requested"}`. Event names
use 1–64 ASCII letters, digits, `_`, `.`, `:` or `-`.

GitHub supports `push` with no actions, `pull_request` with explicit documented
actions, and `workflow_run` with exactly `["completed"]`. Numeric repository ID
and `owner/repository` both match signed payload data. Branch is required: null
explicitly means all branches. Filters use push `refs/heads/`, PR `base.ref` or
workflow `head_branch`. Signed payload shape is also validated: an unsigned event
header cannot relabel a workflow-dispatch payload as a push or a review as a PR.

## Delivery and recovery

Use HTTP/1.1, `Content-Type: application/json` (optional `charset=utf-8`) and fixed
`Content-Length`. Sign exact raw UTF-8 body bytes using HMAC-SHA256. Signature
values are `sha256=` followed by 64 lowercase hexadecimal characters. Never
reserialize a body after signing it.

Generic headers are `X-Nesvo-Delivery`, `X-Nesvo-Event` and
`X-Nesvo-Signature-256`. The strict body is
`{"schemaVersion":1,"id":"unique-event-id","event":"checks:requested","sentAt":UNIX_MS,"payload":{}}`.
Signed ID/event must match headers. New events require a signed time within five
minutes of host time. Authenticated historical replay does not expire. Payload
is bounded JSON data, never interpolated into instructions.

GitHub headers are `X-GitHub-Delivery`, `X-GitHub-Event` and
`X-Hub-Signature-256`, with standard GitHub JSON. GitHub signs the body, not those
headers, so exact body digests also deduplicate within a trigger when a delivery
header changes. First-seen freshness is unavailable for GitHub; old commit times
are not event timestamps. See GitHub's [signature contract](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
and [event payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

Fresh acceptance returns HTTP 202, replay 200 with the same immutable receipt:
schemaVersion 1, `ok:true`, `data.type:"workflow"`, `data.delivery`. The receipt
records internal `id`, sender `deliveryId`, `triggerId`, `bodyDigest`, credential,
trigger and job revisions, `acceptedAt`, `disposition`, `reason` and nullable
`occurrenceId`. Acceptance is not proof of execution or success.

Concurrent duplicates share one occurrence. An HTTP disconnect can follow a
committed acceptance: retry the identical event/body or read its sender ID.
Do not invent a new ID to compensate for a timeout.

```powershell
nesvo job trigger deliveries TRIGGER_ID --json
nesvo job trigger delivery TRIGGER_ID SENDER_DELIVERY_ID --json
nesvo job trigger mutation --key register-main-push --json
nesvo job history JOB_ID --json
```

Follow `nextOffset` on list/history pages. Responses do not disclose raw bodies,
signatures, secrets, prompts or launch profiles.

## Disable, rotate and revoke

```powershell
nesvo job trigger disable TRIGGER_ID --key disable-main-push --revision REV --json
nesvo job trigger edit TRIGGER_ID --key reauthorize-main-push --revision REV --file trigger.json --json
nesvo job trigger rotate TRIGGER_ID --key rotate-main-push --revision REV --secret-file new.secret --json
nesvo job trigger revoke TRIGGER_ID --key revoke-main-push --revision REV --json
```

Substitute the current revision. Rotation retires the old credential immediately,
including historical replay authentication. The current secret can authenticate
an identical historical event without creating another occurrence. Revocation
is permanent; enable or rotation cannot restore the route. Owner history remains
readable. These operations do not cancel admitted work; job cancellation does.

Authenticated well-formed new events while trigger/job is disabled, job spec
changed or filters mismatch receive immutable `ignored` receipts with reason
`trigger_disabled`, `job_disabled`, `job_config_changed` or `filter_mismatch`.
Later enabling/redelivery cannot convert them into execution. Overlap skip returns
`skipped` with an occurrence pointer. Invalid/revoked credentials, bad signatures
and malformed input create no accepted row.

## Bounds and compatibility

- Per database: 128 triggers, 4096 deliveries, 4096 ordinary owner mutation
  receipts. One permanent revocation per trigger reserves an additional receipt
  beyond journal capacity. No automatic eviction rearms old events.
- Ten fresh events per minute per trigger, including ignored events. Existing
  authenticated replay bypasses fresh limits. Backward clock fails closed until
  recorded admission time is reached.
- Eight connections, 32 headers/8 KiB, two-second header deadline, 256 KiB body,
  five-second connection deadline. Overload can close an unadmitted socket.
- No keepalive, transfer coding, upgrade, encoding or trailers. Duplicate security
  headers and mixed provider families fail. Hyper rejects conflicting lengths
  and normalizes equal duplicate lengths; all transfer coding is refused so
  normalization cannot hide conflicting framing.
- Bounded JSON errors: malformed 400, auth 401, oversize 413, media 415, rate 429,
  capacity/unavailable journal 503. Parser errors can close without a JSON receipt.

Support requires strict `jobExternalTriggers:true`, typed
`jobTriggerProviders:["webhook","github"]` and `jobScheduleKinds` containing
`external`. Old job operations keep their fingerprints. Ten owner-only MCP tools
mirror `job trigger`; knowing an ID never grants a scoped agent owner authority.

The host directly pins already present Hyper 1.12.0 (`server/http1`), hyper-util
0.1.21 (`tokio`) and http-body-util 0.1.5 for bounded async HTTP. Enabling the server
adds only httpdate 1.0.3 to the lockfile. Existing package versions and Windows
resolutions are retained. Existing ring verifies HMAC in constant time; there is
no new crypto, scheduler, model client or Node server.

## Verification scope

Local Windows verification covers 23 trigger domain/writer regressions, eight
HTTP boundary tests, client DTO/capability/schema cases and three real signed-HTTP
native scenarios. The full workspace passes 535 units and the serial native SDK
suite passes 53 cases, including one new graceful command-shutdown regression.
These are controlled Node CLI fixtures, not original model calls or external
GitHub account registration. Cross-platform publication and UI administration
remain separate gates; accepted job results still need their ordinary validation.
