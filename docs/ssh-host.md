# Linux host over SSH

Nesvo connects to an independent Linux host through your installed OpenSSH client. The host listens on a private Unix socket; it opens no public Nesvo port. SSH authenticates the computer and account. The database instance ID checks that a saved connection still reaches the expected Nesvo data directory; it is not an authentication credential.

## Prepare the Linux account

Use a dedicated account you control, with a working systemd user manager and Node.js 24.20.0 or a compatible pinned 24.x version. Check the repository's .node-version before distributing a new host build. Install and sign in to Claude Code and Codex separately on this account for the providers you intend to use. The desktop's provider login and local skills are not transferred to the server.

Confirm that `node`, `claude` and `codex` resolve in the account's PATH as applicable. The systemd service records the PATH used when generating its unit. The SSH bridge separately runs the fixed command `node <entry> connect`; Node must also be available in the account's noninteractive SSH PATH. Shell startup files, a desktop terminal and a systemd user manager may have different environments. Verify the actual connection path:

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes your-host 'node --version'
```

Keep provider login material in the provider's normal account-owned configuration. Do not put tokens, passwords or private keys in the unit, connection name or PATH. An encrypted SSH key must already be usable through your SSH agent; Nesvo does not prompt for a password or key passphrase.

## Install the host bundle

On a trusted development machine, use the pinned Bun version, install the locked dependencies and build the host:

```sh
bun install --frozen-lockfile
bun run --cwd apps/host build
```

Distribute `apps/host/dist/main.js` as a single bundle to an account-owned location on Linux, for example `$HOME/.local/lib/nesvo/main.mjs`. The `.mjs` extension makes its module format explicit when it is deployed without the repository's package.json. The bundle requires the supported Node runtime, installed provider CLIs and their existing login; copying it does not install those tools or authenticate their accounts.

Choose a persistent data directory and a separate private runtime directory. Use paths owned by this account, without symlinks. Nesvo requires private permissions and refuses a data directory already owned by another running host. Keep the runtime path short enough for a Unix socket, for example `/run/user/1000/nesvo` for UID 1000. The account's XDG_RUNTIME_DIR normally supplies the correct UID-specific directory.

Run the following on Linux under the intended account, after placing the bundle:

```sh
install -d -m 700 "$HOME/.local/share/nesvo"
install -d -m 700 "${XDG_RUNTIME_DIR:?}/nesvo"
install -d -m 700 "$HOME/.config/systemd/user"
NESVO_DATA_DIR="$HOME/.local/share/nesvo" \
NESVO_RUNTIME_DIR="$XDG_RUNTIME_DIR/nesvo" \
node "$HOME/.local/lib/nesvo/main.mjs" service-unit \
  > "$HOME/.config/systemd/user/nesvo-host.service"
```

The generator prints a unit; it does not write files, start a service or change system configuration. The shell redirection above writes only the chosen unit. Inspect it before enabling it. Its ExecStart captures the absolute Node executable and bundle path, and its Environment entries capture only the data directory, runtime directory and PATH. It invokes no shell and escapes systemd specifiers and literal path characters.

```sh
systemd-analyze --user verify "$HOME/.config/systemd/user/nesvo-host.service"
systemctl --user daemon-reload
systemctl --user enable --now nesvo-host.service
systemctl --user status nesvo-host.service
journalctl --user -u nesvo-host.service -n 50 --no-pager
```

Update the generated unit if Node, the bundle location or the provider PATH changes, then reload and restart it. A service restart interrupts active work; it does not replay messages or decisions. The daemon logs its readiness after acquiring its locks and listening on the private socket. A systemd `active` state alone does not prove that the daemon is ready.

## Keep the service alive after logout

Disconnecting a Nesvo client or its SSH bridge leaves the daemon and its tasks running. Logging out of the Linux account is a separate lifecycle event: without lingering, the system may stop the user manager and remove its runtime directory.

If the host must continue after the final login session ends, an administrator must review and enable lingering for this account through the system's normal policy, for example `loginctl enable-linger <account>`. Verify `loginctl show-user <account> -p Linger`, then verify service availability after logout and a fresh SSH login. Nesvo does not enable lingering or change machine-wide policy automatically. After a machine reboot, both lingering and the enabled user unit are needed for unattended startup under the usual systemd configuration.

`systemctl --user stop nesvo-host.service` deliberately stops this host and its work. The unit sends SIGTERM to the host first and allows up to 30 seconds for graceful cleanup. After that, systemd terminates remaining processes in this service's group. This boundary affects only processes owned by that service.

## Verify SSH identity and add the computer

Before using Nesvo, establish the server's SSH host key through your normal OpenSSH workflow. Compare its SHA256 fingerprint with a trusted independent source, such as the VPS console or your administrator, before accepting it. A key returned by a network scan alone does not establish identity. If a previously trusted key changes, investigate it instead of deleting the saved key automatically.

Nesvo requires an already verified known_hosts entry with StrictHostKeyChecking enabled. It never automatically accepts a new key, rewrites your SSH configuration or disables verification for localhost. Use an SSH key or agent. Connection settings may select an identity file and a separate existing known-hosts file for an advanced or isolated setup; Nesvo reads them through OpenSSH and does not create or update them.

Add the computer with its hostname, optional username, SSH port, absolute Linux bundle path and runtime directory. The entry and runtime paths are remote paths. Existing trusted SSH configuration may supply the key, agent or jump host. The transport disables agent/X11/port forwarding, terminal allocation, backgrounding and connection multiplexing for its bridge. It sends a fixed, quoted command and exposes no arbitrary SSH command field.

The first successful connection records the daemon's stable database instance ID. Later connections require the same ID; replacing the data directory is an explicit reconnection/configuration decision. Losing SSH makes the computer unavailable locally and leaves accepted work on the daemon. Reconnect and refresh its state before deciding what to do next. Nesvo does not resend mutations automatically; a request whose response was lost may already have taken effect.

The current host must already be installed and running. Provider sessions, accounts, skills, files and saved results stay on that host. Local remains a separate computer, and cross-host delegation, migration and synchronization are outside this stage.

The generated unit follows [systemd service execution rules](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) and [systemd environment quoting rules](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html).
