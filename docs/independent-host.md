# Independent Linux host

R1 separates the host lifetime from client connections. It is a transport foundation for the approved Local + VPS extension. Desktop Computers/routing, SSH integration and service installation are subsequent owner-reviewed stages. The existing local desktop host still stops with its application.

## Run an isolated host

Use the Node version in `.node-version` and the built `apps/host/dist/main.js`. Build it with `bun run --cwd apps/host build`. The daemon needs two separate, private directories owned by the service user. New directories are created with mode 0700; existing shared directories and symlink paths are refused. The runtime directory should be short because Unix socket paths have a platform limit.

```sh
export NESVO_DATA_DIR="$HOME/.local/share/nesvo-host"
export NESVO_RUNTIME_DIR="$HOME/.nesvo-runtime"
node apps/host/dist/main.js daemon
```

The daemon prints one `daemon-ready` JSON record after database ownership and socket binding succeed. Keep this process alive independently of its clients. R1 does not install a background service or promise survival of server reboot, terminal logout, OOM or provider limits. Managed Linux service installation and logout persistence belong to R3.

In another terminal, connect with the same OS user:

```sh
export NESVO_RUNTIME_DIR="$HOME/.nesvo-runtime"
node apps/host/dist/main.js connect
```

The bridge prints `connected` with the stable database `instanceId` and protocol version. It then accepts existing JSONL host requests and returns responses/events. `NESVO_EXPECTED_INSTANCE_ID` can pin a previously observed UUID. A mismatch or unsupported protocol is refused before commands. The ID is a consistency check, not authentication: access is currently restricted by the private Unix socket directory to the same OS user. R3 adds verified SSH as the remote authentication and encryption boundary. There is no TCP listener or public Nesvo port.

Closing bridge stdin or killing the bridge detaches that client. It neither shuts down the daemon nor stops provider work. `shutdown` from a client is refused. Stop the daemon deliberately with SIGTERM or SIGINT; it closes clients and performs the existing owned-provider cleanup. Only one daemon may own a data directory or runtime directory. Stale socket cleanup happens only after both ownership checks succeed; unrelated files are not removed.

## Reconnection semantics

The daemon calls the existing host runtime once. Client requests enter its process-owned queue, using internal correlation IDs. Replies go only to their originating connection; full session/review events go to connected clients. Client-supplied message, decision, session and run IDs remain unchanged. Detaching a client removes its reply destination but retains accepted-operation accounting until the host settles the operation.

After reconnecting, read `list-sessions` and `list-reviews` and observe new events. Buffer events while the initial snapshots load, then reconcile by the existing entity revision/timestamps. A connection becoming ready does not mean the client has synchronized its data. R2 owns this desktop synchronization and host-keyed routing. R1 retains no client-side offline cache or event replay log.

The bridge never reconnects or retries commands automatically. If a connection is lost after sending a mutation, its outcome is unknown until refreshed from the host. Reuse existing semantic message/decision IDs only for a deliberate retry; a fresh transport request ID is not an idempotency key. Never automatically replay Stop, messages or approval decisions. Offline does not mean stopped.

## Bounds and trust

- At most 8 connected clients, 32 pending requests per client and 128 pending requests in the runtime, including detached requests.
- A handshake must arrive within 10 seconds. Incoming JSONL frames are limited to 1 MiB; malformed or oversized frames close only that client.
- Invalid request shapes return a private error. Reusing an in-flight transport ID closes that connection to avoid ambiguous replies.
- Outbound frames/buffers are limited to 64 MiB. A slow or oversized connection is disconnected instead of blocking provider persistence or other clients. Large histories may need pagination before exceeding this prototype bound.
- The entire OS user is the trust boundary. Clients of that user can read and act on its sessions. Separate users/tenants, web access, pairing tokens, migration and cross-host delegation are not implemented.

Provider installation, login, repositories and skills belong to this host. Client credentials and local files are not transferred.

## Evidence

The focused Linux integration scenario uses real Unix sockets, a separate daemon process, SQLite and controlled provider processes. It covers detach/reconnect, worker and approval identities, response isolation, invalid connections, data ownership and explicit daemon shutdown. It is separate from the existing local lifecycle cases and does not use model accounts. Successful fixture execution is not evidence of real model output or of a purchased VPS. See `docs/platforms.md` for the recorded results.
