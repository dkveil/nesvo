# Mobile client

Follow the repository AGENTS.md. This active app uses Expo SDK 58; the ignored apps/mobile directory is historical and must remain untouched.

- Keep routes in src/app and non-route code in sibling folders. Use Expo Router and native React Native or Expo UI components.
- Check SDK 58 documentation and installed types before using Expo APIs. Use bunx expo install for SDK-compatible native dependencies.
- Keep pairing credentials in SecureStore. Require HTTPS except exact loopback 127.0.0.1 for emulator testing.
- Keep sessions and commands scoped to their paired gateway and computer. Reconnect reads authoritative snapshots; never replay mutations automatically.
- Preserve drafts and message identities after unknown outcomes. Operation and worker decisions apply only to the displayed run and request.
- Run mobile typecheck, scoped ESLint and dependency compatibility checks. Coordinate Metro, builds and emulator runs with the owner.
