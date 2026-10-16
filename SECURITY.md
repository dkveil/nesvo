# Prototype security

The host grants shell access with the permissions of the user who started it. `--workspace` sets the initial directory; it is not a sandbox. Use the prototype on a trusted local network or private VPN. Do not expose the host port to the public internet.

The QR code / JSON contains the shared terminal access key. Do not publish it, `.local/` files, screenshots of the code or recordings of the pairing screen. “Zapomnij host” (Forget host) removes the app's saved entry; it does not revoke the code on the computer. Key generation and rotation are described in [host configuration](apps/host/README.md).

Command and output contents are encrypted with XSalsa20-Poly1305 (secretbox). The protocol includes a random connection challenge, message direction and sequence. It does not conceal addresses, traffic sizes or timing, and does not provide forward secrecy. It has not undergone an independent audit. The person scanning must verify that the code comes from their computer.

The prototype uses WebSocket transport with encrypted payloads. Android permits `ws://` through `usesCleartextTraffic`; iOS has a local-network exception. The terminal renderer does not connect directly to the host, does not load resources from CDNs and has its own restrictive CSP. A public service would require TLS, device and key lifecycle management, abuse limits and a protocol audit.

On the phone, the secret is saved in SecureStore. In the browser, it stays in memory only. It is never placed in a URL, localStorage or logs. Terminal output can contain sensitive data; its bounded buffer stays in host memory.

## Dependency status

The npm audit on October 16, 2026 still reported advisories in transitive Expo tooling dependencies: `braces`, `node-forge` and `uuid`. Passing tests does not mean the audit has no findings. At the time of the check, npm's proposed automatic fix included an incompatible change to Expo 44; it was not applied. The tests' `ws` dependency has been updated to 8.22.0. The execution host is a separate Rust program.

Before publishing binaries or distributing a production build, rerun `npm audit` and check Cargo dependencies. Security reports must not include pairing keys or private session output.
