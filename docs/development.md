# Development

## Toolchain

Use Node.js 24.20.0 and Bun 1.4.0. Dependencies and lockfile are committed.
TypeScript 6.0.3 is pinned to the supported range of the selected ESLint integration.
Run commands from the repository root. Bun manages the workspace and scripts; Electron runs the packaged desktop and host.

```sh
bun install --frozen-lockfile
bun run dev
```

The initial screen is a connection check, not the final P1 application layout.
It uses stock neutral shadcn Button, Card and Badge components.

## Build and check

```sh
bun run check
bun run build
bun run smoke:desktop
bun run package:dir
```

On Linux without a display, use xvfb-run -a bun run smoke:desktop.
Native packages are unpacked directories in apps/desktop/release. P0 does not provide signed installers or automatic updates.

For a packaged Windows check in PowerShell:

```powershell
$env:NESVO_PACKAGED_EXECUTABLE = (Resolve-Path 'apps/desktop/release/win-unpacked/Nesvo.exe').Path
bun run smoke:desktop
Remove-Item Env:NESVO_PACKAGED_EXECUTABLE
```

Optional NESVO_SCREENSHOT saves the smoke scenario's visible state to an explicit path.
The scenario starts a hidden window and uses an isolated temporary directory.

## Standalone host

Build first. Then set NESVO_DATA_DIR to a dedicated directory and run bun run host.
Each stdin line is a JSON object with a UUID id and method health or shutdown.
Responses are JSONL on stdout; diagnostics go to stderr. Closing stdin also closes the host.

## Local data

The desktop stores its host database under Electron's userData directory, in host/nesvo.sqlite.
On Windows this normally means %APPDATA%/Nesvo/host.
NESVO_DATA_DIR overrides the desktop userData directory, or the standalone host data directory.
Use different directories for standalone and desktop development. Never point test runs at your real data.

P0 has no migration from historical application data. Existing private directories and worktrees remain untouched.
Do not run git clean or delete ignored files as part of setup.

## Troubleshooting

If the initial screen reports no connection, retry once and inspect the terminal used to start development.
An incompatible database fails closed; do not delete it to hide the error.
Quit the desktop to stop its utility host. On macOS, closing the last window alone does not quit the app.
Development IPC and the host expose no network port. The renderer development server uses an available Vite port.
