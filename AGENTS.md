# Nesvo engineering rules

## Current scope and owner gates

This repository contains the approved desktop prototype, planned for November 16, 2026.
P0 and P1 are accepted. The current stage is P2, the first real Claude Code session. Read docs/roadmap.md and the linked Linear issue before starting a package.
Finish a small stage, provide a working demonstration and evidence, then wait for Damian's acceptance before starting the next stage.
In Review means ready for the owner; Done requires his explicit acceptance. Keep Linear status and STATUS comments current.
Discuss changes in Polish. Write code, repository documentation and commit messages in English.

## Stack and boundaries

- TypeScript strict, Electron desktop, React renderer, base shadcn components, Bun workspaces and scripts.
- Node.js host with Effect for resource ownership and service composition; SQLite persistence.
- Electron supplies the Node runtime for its host utility process. The standalone host targets the version in .node-version.
- packages/contracts owns Zod schemas and inferred public types. It imports no UI, Electron, Effect or host implementation.
- Keep Effect inside apps/host. Electron adapters call the host entry point; renderer and simple domain rules use plain TypeScript.
- UI calls a narrow preload API. Never expose a generic IPC channel, shell, filesystem or Node API to the renderer.
- Host state is authoritative. Validate process and provider boundaries. Never treat CLI prose as a trusted command.
- Future provider adapters run the user's installed tools with their existing login. No new required model API key.
- Grow domain modules and renderer feature slices only when a concrete feature needs them. Do not scaffold empty layers.

## Product and design

Use base shadcn components with neutral dark defaults. Black is the primary appearance, including native window chrome.
Keep the workspace minimal: flat session rows, few badges, conversation-first space and session details on demand. Minimal Geist alignment may be accepted by Damian.
Do not restore the previous logo, palette or theme. Present UI changes for acceptance before expanding them.
Keep technical runtime details out of product flows unless they help the operator make a decision.
P2 uses real host-owned sessions and installed Claude Code with existing login. Keep analysis read-only (Read, Glob, Grep), without shell, edits or implicit permission bypass. Interactive permissions belong to P3. Never present fixture output or account-limit errors as successful model execution; review and delegation remain future stages.
Repository content describes Nesvo and its implementation. Keep external product comparisons and research elsewhere.
Preserve required third-party license notices.

## Delivery

During this prototype, work directly on master with small conventional commits. Do not create pull requests.
Commit frequently at coherent scope boundaries instead of collecting a whole stage in one commit. Each commit should capture one understandable, checked change that can be reverted independently; keep tightly coupled changes together. Do not split work by arbitrary line counts or target a commit quota.
Push completed checkpoints regularly so recovery does not depend only on the local checkout. Repeat the edit, check and commit cycle within a stage; owner acceptance still happens at the stage boundary.
Damian is the commit author. Never add AI signatures, Co-Authored-By trailers, generated-by footers or session links.
Before committing, inspect the staged diff, run applicable checks, and verify no private files are staged.
Do not edit another worktree, restore a stash, clean ignored directories or operate existing runtime processes.
Keep .nesvo, .claude/worktrees, host/.local and target/ data intact; do not use port 8789.
The archived baseline is a reference in Git, not an active workspace.

## Testing and quality

Follow docs/testing.md. Tests are selective and risk based.
No coverage target, test-per-function policy, routine component snapshots or duplicated implementation tests.
Prefer a small integration check at a changed critical boundary and a single main desktop scenario.
For a cosmetic change, use a visual check; do not add a unit test.
Run bun run check and bun run build for a foundation change, plus the relevant host or desktop check.
Do not repeatedly run unchanged broad suites. Do not invoke archived build or test commands.
A successful build is not proof of native runtime behavior or owner acceptance. Report each OS separately.

Use ESLint and Prettier. Keep TypeScript filenames kebab-case, components/types PascalCase and values camelCase.
Write readable code without inline comments; explain significant choices in docs.
Use the root scripts and bun install --frozen-lockfile. Do not upgrade global tools or silently change pinned versions.
