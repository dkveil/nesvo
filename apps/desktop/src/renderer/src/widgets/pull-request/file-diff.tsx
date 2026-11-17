import { Component, useMemo, type ReactNode } from 'react';
import type { DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs';
import { FileDiff, type DiffBasePropsReact } from '@pierre/diffs/react';
import type { PullRequestThread } from '@nesvo/contracts';

type ThreadAnnotation = DiffLineAnnotation<PullRequestThread[]>;

type DiffOptions = NonNullable<
  DiffBasePropsReact<PullRequestThread[], undefined>['options']
>;

const annotationsOf = (threads: PullRequestThread[]): ThreadAnnotation[] => {
  const grouped = new Map<string, ThreadAnnotation>();
  for (const thread of threads) {
    const side = thread.side === 'left' ? 'deletions' : 'additions';
    const key = `${side}:${thread.line}`;
    const existing = grouped.get(key);
    if (existing) existing.metadata.push(thread);
    else
      grouped.set(key, {
        side,
        lineNumber: thread.line ?? 0,
        metadata: [thread],
      });
  }
  return [...grouped.values()];
};

class DiffBoundary extends Component<
  { children: ReactNode; patch: string },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <pre className="overflow-auto bg-code-background p-3 font-mono text-xs leading-5">
        <code>{this.props.patch}</code>
      </pre>
    ) : (
      this.props.children
    );
  }
}

type PatchDiffProps = {
  diff: FileDiffMetadata;
  patch: string;
  threads: PullRequestThread[];
  wrap: boolean;
  renderThread: (thread: PullRequestThread) => ReactNode;
};

export function PatchDiff({
  diff,
  patch,
  threads,
  wrap,
  renderThread,
}: PatchDiffProps) {
  const annotations = useMemo(() => annotationsOf(threads), [threads]);
  const options = useMemo<DiffOptions>(
    () => ({
      theme: { dark: 'github-dark', light: 'github-light' },
      themeType: 'system',
      preferredHighlighter: 'shiki-js',
      diffStyle: 'unified',
      diffIndicators: 'classic',
      overflow: wrap ? 'wrap' : 'scroll',
      disableFileHeader: true,
      lineDiffType: 'word',
      tokenizeMaxLength: 100000,
      tokenizeMaxLineLength: 1000,
      unsafeCSS:
        ':host{--diffs-font-size:12px;--diffs-line-height:20px;--diffs-bg:var(--code-background);--diffs-fg:var(--foreground)} [data-diffs]{background:var(--code-background)} [data-code]{font-family:Consolas,monospace}',
    }),
    [wrap],
  );
  return (
    <DiffBoundary patch={patch}>
      <FileDiff<PullRequestThread[]>
        fileDiff={diff}
        options={options}
        lineAnnotations={annotations}
        renderAnnotation={annotation => (
          <div className="px-2">
            {annotation.metadata.map(thread => renderThread(thread))}
          </div>
        )}
        disableWorkerPool
      />
    </DiffBoundary>
  );
}
