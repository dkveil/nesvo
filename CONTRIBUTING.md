# Contributing to the prototype

1. Read AGENTS.md, the current Linear issue and its acceptance criteria.
2. Confirm that Damian accepted the preceding stage. Stage approval does not approve unrelated features.
3. Implement one small coherent task, using the existing workspace and current architecture.
4. Run the checks appropriate to its risk, following docs/testing.md.
5. Review git diff and the staged file list. Keep secrets, local state and build output out of Git.
6. Commit directly to master with a conventional English subject. No pull request is required during the prototype.
   Repeat steps 3 through 6 for each coherent scope within a stage. Prefer frequent, checked commits that can be reverted independently, keeping coupled changes together. Avoid both whole-stage catch-all commits and artificial one-line splits. Push completed checkpoints regularly.
7. Update the Linear issue with what changed, commit, verification and limitations.
8. Mark the stage In Review and present the working result to Damian. Only mark Done after his acceptance.

Do not add AI attribution to commits or PR descriptions. Do not change Git author identity.
Do not modify another worktree, apply someone else's stash, or clean ignored data.

Use Bun 1.4.0 and the Node version in .node-version. Commit bun.lock with dependency changes.
Keep new dependencies pinned, justified by the current task and compatible with all three desktop platforms.
The repository root uses an explicit file allowlist to protect local historical files. Add a new tracked root path deliberately when needed.

Code and documentation use English. Product copy and owner discussion currently use Polish.
