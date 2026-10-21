# Contextual session search

F31 adds advisory repository and branch evidence to the existing shared session
matcher. Session name, provider, cwd and group terms keep their existing meaning
and ranking. Both quick search and the expanded palette accept current ready
repository/branch labels; detached repositories contribute only their name.
Checking, unavailable, stale, malformed or omitted metadata adds no terms.

The source is explicitly the native launch directory, not an inferred current
agent directory. A later Edit/Write review location does not become search
metadata. This first slice does not follow provider cwd changes. No new shortcut,
layout, icon, sidebar width or ranking weight is introduced.

Opening search deliberately emits one existing authenticated `list` request while
connected. Query edits, paste, F2 expansion, rendering and PTY output do not request
Git work. A correlated successful local create response also requests one list;
foreign or duplicate replies do not. Query and exact selected session identity
survive unrelated metadata updates, including the same workspace revision. If a
selected session loses its only matching branch, selection clears; Enter cannot
open a substitute or resurrect the old cursor without deliberate navigation.

The additive DTO is specified in [protocol v2](protocol-v2.md) and the published
CLI/MCP JSON schema. All six fields are required inside a present object. Runtime
label bounds count UTF-8 bytes; JSON Schema `maxLength` counts characters, so the
runtime boundary remains stricter for multibyte labels. TUI optional-evidence
parsing and mobile strict optional-field parsing intentionally differ on malformed
present data. Both remain compatible with old hosts omitting the field.

## Integration status

The client matcher, request intentions, DTO validation and schema are implemented.
Host inspection/cache/runtime integration and its native Git/SDK acceptance are
tracked separately under F31; these client checks alone do not establish an
end-to-end working metadata source or physical-phone acceptance. No dependency,
Expo API, SDK, launch authority or provider configuration is changed.
