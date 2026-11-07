# Preserved baseline

The previous tracked source is preserved at the annotated tag:

```text
archive/pre-prototype-2026-11-07
78b0091
```

The tag is pushed to origin. The active default branch is master.
Use git show or inspect the tag on GitHub when a prior implementation detail is useful.

The initial prototype commit replaces the active tracked source while retaining Git history.
Existing local historical files may remain ignored. They are not workspace packages and must not be used by the new build.
Private runtime state, stashes, target data and other worktrees are preserved.
Fresh clones contain only the current tracked foundation.

The previous look and assets are not part of the prototype. Future features require the acceptance gates in docs/roadmap.md.
