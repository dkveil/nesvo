# Interface direction

Updated October 16, 2026 after the first preview. The product name is **nesvo**, chosen by the project owner. App display names, the repository and native binaries use this name. Internal storage and Expo identifiers are preserved where migration would affect existing installations or pairing; see [branding](branding.md).

- Background `#0B0B0B`, surfaces `#191919`, bubbles and selections `#242424`. White for primary actions and grays for supporting text. Reserve color for items needing attention, errors and terminal syntax.
- System typography on the phone. Conversation text at 16/26, row titles at 16, descriptions at 14. No decorative uppercase labels or colorful agent cards.
- The main list uses flat rows: topic, latest activity, agent and project. Include search and a filter for items needing attention.
- Side menu: sessions, computers and settings, with shortcuts to recent sessions. The new-session button is also available at the bottom of the screen.
- Conversation: a user bubble on the right, responses on a flat background, a rounded message field and a circular send button.
- Terminal: a compact header, large output area, special-key bar and command field. Real sessions continue to use the Rust host's PTY.
- Pairing: two short steps, QR scanning as the primary action and an option to paste a code.

The conversation view is a demo and is labeled accordingly in the app. It does not imply a working AI model integration. The visual changes add no model API connections and do not alter the original CLI login mechanisms.

Browser previews and tests do not replace checking the keyboard, safe areas and camera on a physical phone.
