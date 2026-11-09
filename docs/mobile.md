# Mobile companion

The Expo app in `apps/mobile-client` connects to the same sessions as Nesvo Desktop. M1 covers pairing and computer/session selection, M2 covers history, activity and live updates, and M3 covers messages, Stop and one-time operation/worker decisions.

## Connection model

```text
Expo app on Android or iOS
  |
  | HTTPS commands + authenticated HTTP snapshot/event stream
  v
Opt-in gateway inside Nesvo Desktop
  |
  +--> Local host --> installed provider CLI
  |
  +--> connected SSH computer --> independent Linux host --> provider CLI
```

Keep the desktop running and the required SSH computer connected. Closing the phone or disabling Phone access closes the mobile transport without stopping host work. Closing the desktop retains the existing desktop lifecycle: Local work stops; independent remote work can continue. A standalone mobile gateway on the VPS is outside this delivery.

On desktop, open **Phone access**, enable access and create a pairing link. In the mobile app choose **Pair computer**, paste that link and name the device. The link expires after two minutes and works once. The desktop lists paired devices and can revoke each one. After restarting desktop, enable Phone access again; saved devices remain paired if the address and gateway identity remain the same.

The phone chooses a saved connection, then a computer and an existing conversation. Each action preserves its host, session, run and request identity. Worker navigation remains on the originating host. An offline snapshot is explicitly marked; messages and decisions stay disabled until fresh state arrives. Returning from the background reconnects and fetches authoritative history. Neither reconnection nor app startup repeats a message, approval or Stop.

## Run locally on an Android emulator

Install the pinned dependencies with `bun install --frozen-lockfile`. Start Nesvo Desktop with `bun run dev`, enable Phone access and leave it running. The default gateway is `http://127.0.0.1:48371`.

The primary Android client is a local development build of `apps/mobile-client` with the package `dev.dkveil.nesvomobile`. It is a debug build produced by Expo prebuild and Gradle on the PC; no EAS, Expo account or cloud service is involved, and the generated `android/` directory stays out of Git. Build and install it on the selected emulator:

```powershell
cd apps/mobile-client
bunx expo prebuild --platform android --no-install
cd android
./gradlew.bat app:assembleDebug -PreactNativeDevServerPort=8095 -PreactNativeArchitectures=x86_64
adb -s <emulator-serial> install -r app/build/outputs/apk/debug/app-debug.apk
```

The Metro port is compiled into the debug build, so Metro must use the same port. JavaScript changes only need Metro; rebuild after changing native dependencies or `app.json`. On Windows, the SDK's default CMake 3.22.1 ships ninja 1.10, which fails on long checkout paths with `ninja: error: mkdir(...): No such file or directory`. With Windows long paths enabled, point Gradle to CMake 3.31 or newer in `android/local.properties`, for example `cmake.dir=C:/Users/<user>/AppData/Local/Android/Sdk/cmake/3.31.6`. A clean prebuild removes that file.

Start Metro and forward Metro and the gateway through ADB:

```powershell
adb -s <emulator-serial> reverse tcp:8095 tcp:8095
adb -s <emulator-serial> reverse tcp:48371 tcp:48371
bun run mobile --localhost --port 8095
```

The gateway's loopback address reaches the PC through ADB reverse. Metro and the workspace gateway are separate services. Use the same explicit gateway port when restarting; a random port is useful only for isolated tests.

The debug build alone trusts user-installed certificate authorities, so a later private HTTPS gateway can be tested on the emulator. It also keeps loopback cleartext for the local gateway. Release builds keep the system trust store.

Expo Go SDK 58 remains an explicit option through `bun run mobile:go --localhost --port 8095`.

The native scenario uses a dedicated AVD named `Nesvo_D66`, the installed development build and a running Metro instance. It owns its Electron profile, provider fixtures, temporary workspace and newly created ADB forwarding rules. Each cold start force-stops the app and launches `dev.dkveil.nesvomobile/.MainActivity`:

```powershell
$env:NESVO_ANDROID_SERIAL = 'emulator-5580'
$env:NESVO_MOBILE_METRO_PORT = '8095'
$env:NESVO_MOBILE_SCREENSHOTS = '<absolute-output-directory>'
bun run smoke:mobile
```

To run the same scenario in Expo Go, set `NESVO_MOBILE_CLIENT=expo-go` and `NESVO_MOBILE_EXPO_URL=exp://127.0.0.1:8095`. On `Nesvo_D66`, that mode can leave the Android launcher in front after the cold-restart step. A failed run writes `failure-state.json` with the foreground activity and host session state. Another package in front, such as the launcher, indicates launch automation; the app in front with a missing control or unexpected host state indicates a product failure.

It does not create or stop an AVD, operate other emulators, clear app or Expo Go storage or use real provider accounts. Create and start the dedicated AVD first. Run `bun run build` before the scenario. Screenshots are taken after pairing so the one-time secret is excluded.

## Connect a physical device

The device needs a reachable HTTPS origin with a certificate trusted by its operating system. The app rejects external plaintext HTTP. Configure the desktop environment before launching Nesvo:

| Setting                        | Purpose                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `NESVO_MOBILE_PORT`            | Listener port; defaults to `48371`                                               |
| `NESVO_MOBILE_BIND`            | Listener address; defaults to `127.0.0.1`                                        |
| `NESVO_MOBILE_PUBLIC_URL`      | Reachable origin, such as `https://nesvo.example.com`; no path/query/credentials |
| `NESVO_MOBILE_TLS_CERT`        | Path to the PEM certificate for direct TLS                                       |
| `NESVO_MOBILE_TLS_KEY`         | Path to its PEM private key                                                      |
| `NESVO_MOBILE_TRUSTED_PROXY=1` | Explicit HTTPS-terminating proxy mode, allowed only with a loopback listener     |

For direct TLS, set both certificate paths, the bind address and the HTTPS public URL. For an HTTPS reverse proxy, keep Nesvo bound to loopback, set the HTTPS public URL and explicitly enable trusted-proxy mode. The proxy must forward HTTP and WebSocket upgrades to the local listener. Nesvo never disables certificate validation. Provisioning public routing, certificates and a physical phone is separate from the local emulator demonstration.

## Boundaries

- The phone stores tokens in SecureStore. The gateway persists token hashes and its stable identity in its private profile directory. Long-lived tokens never appear in pairing links or transport URLs. Mobile uses a bounded NDJSON HTTP event stream with redirects rejected; an authenticated WebSocket endpoint remains available to other clients.
- Pairing is initiated explicitly on desktop. Revocation closes authenticated streams and rejects subsequent requests. Forgetting a connection on the phone removes its local credentials; revoke it on desktop to remove the server grant.
- The gateway exposes history and only four mutation types: send a message, stop a run, respond to an operation approval and decide a worker proposal. It does not expose filesystem operations, arbitrary shell execution, provider login, session creation or connection administration.
- Messages keep their client-generated ID across an uncertain acknowledgement. An explicit retry checks the host state; automatic mutation retry is absent. Drafts remain in memory across navigation and network loss, not across process termination.
- Operation approvals are distinct from saved-result acceptance. Full result review/diffs, skill selection, file editing, push notifications and app-store distribution remain desktop-only or deferred.
- Responses and event buffers are limited to 8 MiB, requests to 256 KiB, workspace snapshots to 512 sessions, paired devices to 16 and simultaneous clients to eight. An exceeded limit reports an error rather than silently truncating authoritative state.
- Mobile source targets Android and iOS. Android emulator evidence does not certify iOS, a physical device, TLS deployment or an actual VPS.
