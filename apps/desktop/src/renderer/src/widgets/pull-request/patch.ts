import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';
import type { PullRequestFile, PullRequestThread } from '@nesvo/contracts';

export function parseFilePatch(
  file: PullRequestFile,
  cacheKey: string,
): FileDiffMetadata | null {
  if (!file.patch) return null;
  const before = file.previousPath ?? file.path;
  const header = [
    `diff --git a/${before} b/${file.path}`,
    file.status === 'added' ? '--- /dev/null' : `--- a/${before}`,
    file.status === 'removed' ? '+++ /dev/null' : `+++ b/${file.path}`,
  ].join('\n');
  try {
    return (
      parsePatchFiles(`${header}\n${file.patch}\n`, {
        cacheKeyPrefix: cacheKey,
        throwOnError: true,
      }).flatMap(patch => patch.files)[0] ?? null
    );
  } catch {
    return null;
  }
}

export function inlineThreadLines(
  diff: FileDiffMetadata,
  threads: PullRequestThread[],
) {
  const visible = (thread: PullRequestThread) => {
    if (thread.isOutdated || !thread.line) return false;
    const line = thread.line;
    return diff.hunks.some(hunk =>
      thread.side === 'left'
        ? line >= hunk.deletionStart &&
          line < hunk.deletionStart + hunk.deletionCount
        : line >= hunk.additionStart &&
          line < hunk.additionStart + hunk.additionCount,
    );
  };
  return {
    inline: threads.filter(visible),
    detached: threads.filter(thread => !visible(thread)),
  };
}
