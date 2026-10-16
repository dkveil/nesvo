# Interface direction

Updated October 16, 2026 after the first preview. The product name is **nesvo**, chosen by the project owner. App display names, the repository and native binaries use this name. Internal storage and Expo identifiers are preserved where migration would affect existing installations or pairing; see [branding](branding.md).

- Both clients present a terminal workspace. Use compact panels, flat grouped rows and small corner radii, with a large usable terminal surface.
- Use the shared Ultraviolet tokens: background `#17171A`, panels `#1E1E22`, text `#EAE8EE` and accent `#A34DFF`. Violet marks focus, the cursor and active controls; independent green, amber and red carry success, attention and failure states. Text and symbols accompany color.
- The launch area uses the approved vector logo and a panel with a strong violet left edge plus a separate thin neutral line. Apply this restrained treatment to prompt fields and active panels; no gradients, glow or decorative shadows. The new-session field names a session and opens the existing launcher, rather than pretending to submit an AI task.
- Use platform monospace for workspace headings, paths, terminal controls and metadata. Keep mobile touch targets at least 44 points and forms scrollable above the keyboard; visual density must not reduce hit targets.
- Grouped sessions use flat two-line rows with a status dot, name, program and directory. A short unboxed status label keeps state understandable without relying on color. Group headings are quiet separators; avoid nested cards. The large logo and launch field appear only when the workspace has no sessions.
- Recent sessions in the navigation drawer retain the same status, program, group path and working directory. Program colors come from shared semantic tokens: neutral Terminal, warm Claude, blue Gemini and teal Codex. They distinguish programs without replacing status labels or adding decorative badges.
- Motion communicates feedback and live activity: short button press feedback, native screen transitions and quiet dialog fades. Only a visible, live working session pulses; fictional demo states remain static. Respect reduced motion and pause ongoing animations in the background. Terminal output and grid dimensions never animate.
- Session screens open directly into the terminal, with no conversation tabs. Keep the header, directory row, special keys and single-line command field compact so terminal output receives the remaining height.
- TUI controls work with both keyboard and mouse. Rendered button bounds and hit testing share geometry. A dialog blocks background actions; selecting a program or row does not submit, and destructive actions retain confirmation.
- The TUI starts with a quiet menu for workspace entry, appearance and mobile pairing. F1 returns to it; Esc detaches without ending host processes, while a form consumes Escape to cancel. The workspace uses a narrow session tree, thin separators and compact contextual actions rather than nested panel frames.
- Pairing, program selection and directory editing use the same compact visual language on mobile. Special keys and the command field remain accessible above the keyboard. Provide an explicit keyboard-dismiss action that blurs both the command field and embedded terminal without clearing the draft or releasing control.

Status has an explicit evidence source. Activity means recent terminal I/O or silence, not a claim about an agent's internal progress. Screen-based states are conservative inferences from known visible CLI prompts. Process states come from actual termination. Unknown is preferable to inventing completion or approval requests. Status never authorizes an action or automatically submits input.

Demo sessions are explicitly fictional. The visual changes add no model API connections and do not alter the original CLI login mechanisms.

Browser previews and tests do not replace checking the keyboard, safe areas and camera on a physical phone.
