# Quick start

nesvo currently runs from source. You need Node.js with npm, Rust 1.88 or newer and the native C/C++ build tools required by Rust dependencies on your platform. The mobile preview uses Expo Go; local Xcode or Android Studio is not required.

## 1. Get the source

```sh
git clone https://github.com/dkveil/nesvo.git
cd nesvo
npm ci
```

On Windows, use `npm.cmd` and `npx.cmd` if PowerShell blocks `.ps1` wrappers. You do not need to change Execution Policy.

## 2. Start the host

Open a terminal at the repository root and select an existing workspace:

```powershell
cargo run --manifest-path host/Cargo.toml -- --lan --workspace "C:\projects\my-app"
```

On macOS/Linux, use a path such as `--workspace /Users/you/projects/my-app`. The first build compiles Rust dependencies. `--workspace` sets the shell's starting directory; it is not a sandbox.

The host writes a private pairing JSON and QR code, normally under `host/.local/` when started from the repository. The terminal prints their paths. Keep the host running. See [host configuration](../host/README.md) for the address, port, storage and key-rotation options.

`--lan` makes the host reachable on the network. The phone must reach its advertised IP and port through the firewall. For the first test, use the same Wi-Fi. A privately configured VPN can provide reachability outside the LAN; nesvo does not configure it or provide a relay.

## 3. Open the terminal client

In another terminal at the repository root:

```sh
cargo run --manifest-path tui/Cargo.toml -- --pairing host/.local/pairing.json
```

If necessary, override only the host address with `--url ws://127.0.0.1:8787`, using its actual port. The pairing key remains in the private file.

Press `n` to create a shell, then `i` to acquire control. Ctrl+G returns to navigation and `q` detaches. See the [TUI guide](../tui/README.md) for groups, two-pane layouts, takeover and other shortcuts.

## 4. Open the mobile preview

```powershell
npm.cmd start
```

Scan Expo's QR with your phone. The app targets **Expo SDK 57**, aligned with the physical iPhone's App Store Expo Go on October 16, 2026. All native dependencies must match the selected SDK. A newer npm SDK can precede its store app; do not change just `sdkVersion` to imitate compatibility.

Expo Go on a physical iPhone requires the same Expo account in the app and CLI. To sign in on the computer:

```powershell
npx.cmd eas-cli@latest login --device
npx.cmd expo whoami
```

Complete the browser authorization, including any confirmation step, then sign into that account in Expo Go. Opening an Expo dashboard alone does not prove the CLI is authenticated. [Expo sign-in requirements](https://docs.expo.dev/troubleshooting/expo-go-sign-in-required/).

Inside nesvo, choose **Połącz komputer** (connect computer), then scan the host's QR or paste its JSON. **Expo's QR opens the app; the host's QR grants terminal access.** Open a session and choose **Przejmij sterowanie** (take control) before entering a command.

Other devices remain observers until they explicitly take control. Returning to the list releases control while the process continues. Stopping a session ends its process; restarting the host preserves groups but does not resurrect shells.

## Browser preview and device builds

Use `npm.cmd run web` to work on the UI in a browser. This does not verify native keyboard, camera, safe-area, clipboard or WebView behavior. Follow the [physical-device checklist](testing.md#physical-device-checklist).

EAS can compile iOS builds on hosted macOS while development happens on Windows. TestFlight requires Apple Developer enrollment, signing and App Store Connect configuration. No verified TestFlight release exists yet. See Expo's [development build guide](https://docs.expo.dev/develop/development-builds/introduction/) and [iOS submission guide](https://docs.expo.dev/submit/ios/).

The product rename preserves existing EAS and storage identifiers. See [branding and compatibility](branding.md). Read [security](../SECURITY.md) before sharing or exposing a host.
