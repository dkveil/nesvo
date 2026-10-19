# Native host MCP adapter

`nesvo mcp` serves MCP over stdio. It uses the existing Rust authenticated host
transport and the same command/error/receipt path as the CLI. It never embeds a
model client, starts another host, writes global provider configuration or adds
an HTTP listener. Running `nesvo` normally retains the TUI.

## Launch and authority

An agent-launched server should inherit `NESVO_AGENT_CONTEXT` from its managed
process, just like the CLI. Example per-session provider configuration:

```json
{
  "mcpServers": {
    "nesvo": {
      "command": "C:\\path\\to\\nesvo.exe",
      "args": ["mcp"]
    }
  }
}
```

This is an example, not an installed global registration. Use the provider's
per-launch configuration when F38 wires profiles. Do not put owner pairing keys
in worker prompts, arguments, logs or this JSON. For manual human testing only,
`--pairing PRIVATE_PATH mcp` explicitly selects owner access. Otherwise managed
context is selected automatically; invalid context fails closed. Catalog/help
work without a host. Each tool call authenticates afresh, so revocation is not
bypassed by an authorization cache.

Host policy always wins. The initial passive worker capability reads its own
session but cannot create children or inspect owner receipts. Advertising a tool
is not permission. Coordinator grants remain F11/F12 work. Current session uses
the process-injected ID, never UI focus; changing that hint cannot grant access.

## Current tools

| Tool                      | Host operation                                    |
| ------------------------- | ------------------------------------------------- |
| nesvo_list_sessions       | list visible sessions/groups/lifecycle            |
| nesvo_get_session         | inspect one stable process identity               |
| nesvo_get_current_session | get the injected process session                  |
| nesvo_read_session        | bounded terminal replay with byte cursors         |
| nesvo_explain_session     | status/readiness/provider diagnostics             |
| nesvo_read_diff           | host-side read-only diff with an explicit scope   |
| nesvo_read_events         | bounded durable metadata page with domain cursors |
| nesvo_create_session      | durable idempotent background create              |
| nesvo_send_prompt         | durable literal prompt submission without control |
| nesvo_wait_prompt         | passive correlated send milestone wait            |
| nesvo_get_operation       | lookup by operation ID or original caller key     |

Tools declare input/output schemas and effect hints. Results include text and
`structuredContent` with `schemaVersion:1`, `ok`, and `data` or `error`. Host/tool
failures use `isError:true` with stable codes; failed/unknown effects include the
receipt. Protocol/schema errors are distinct. Created means historical process
creation, not readiness, delivery or task success. After a lost response query
the original key, never invent a new one to retry. Domain and terminal cursors
are independent. Event gaps explicitly mean incomplete history. Reads neither
acknowledge results nor acquire control.

Send requires `sessionId`, stable `key` and literal `prompt` (8192 UTF-8 bytes,
no terminal controls). Wait takes exactly one `id` or original `key`, optional
`sessionId` guard, `until:delivered|received|started|settled` and `timeoutMs` within
1–60000. It binds receipt/turn evidence, never current idle. Milestone timeout or
terminal failure returns a tool error with the current receipt; unsupported
provider correlation returns `unsupported`. A shell write can confirm delivery
only. Set the MCP client's request timeout above the chosen wait plus connection
overhead. Accepted sends survive a lost reply and are never replayed. Human
ownership/drafts and unready/busy agents remain host-side refusals. Full safety
and phase semantics are in [durable operations](harness-operations.md).

## Protocol, bounds and dependencies

The official `rmcp 3.5.1` SDK declares Rust 1.88, matching the workspace. It handles
current `2026-07-28` metadata and legacy initialization. Native SDK client tests
exercise both the modern protocol and `2025-11-25`. A minimum-version compiler
run is not claimed.

- Direct `rmcp` dependency: defaults disabled, only server and stdio/async I/O.
  Version negotiation, schemas and wire lifecycle come from the maintained SDK,
  rather than a handwritten protocol. Client/child-process features are test-only.
  No macros, HTTP server, OAuth or model SDK is enabled.
- Direct `tokio-util` codec (already required by rmcp): the SDK default stdio reader
  has no line cap. Its codec is configured to reject lines above 64 KiB; malformed
  input closes the adapter before dispatching that input. Arguments are bounded
  to 24 KiB. Host-specific limits remain authoritative. Four calls can contact the
  host concurrently; extra calls fail busy instead of forming an unbounded queue.

Stdout contains only MCP frames, stderr generic diagnostics. Prompts/keys are not
logged. EOF ends the adapter. Disconnect/cancellation never requests input replay
or agent shutdown. Accepted host creates can still finish; inspect their receipts.
Per-request cancellation/protocol conformance beyond the tested SDK paths remains
an explicit audit item before claiming the complete F10 gate.

References verified for this implementation:
[stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio),
[tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools),
[versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning),
[official Rust SDK](https://github.com/modelcontextprotocol/rust-sdk).

## Verification and open gates

```powershell
cargo build --workspace --locked
cargo test --package nesvo --test mcp_host --locked -- --ignored
```

The test needs built native binaries, so CI explicitly runs it after build on
Windows/macOS/Linux. An official SDK client connects to a separate native MCP
subprocess and isolated host. It checks catalog, create/replay, the same receipt
through CLI, passive read/diagnostics/events, Git errors, wrong scope rejection,
legacy initialization, host loss, bad/oversized stdio and clean PTY cleanup.
Native prompt tests cover MCP send, CLI same-key replay, delivered wait and
unsupported shell response correlation. A separate controlled Claude helper/PTY
fixture exercises CLI Unicode/multiline send and timeout without false idle.
No model calls or changes to user sessions/provider configuration.

Actual provider prompt-correlation coverage, interrupt/stop, MCP event streaming,
durable task/results and actual provider-to-child orchestration remain F10/F17
gates. A model-driven evaluation corpus for those workflows is also pending.
