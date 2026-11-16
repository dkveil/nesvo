import { Component, useMemo, type ReactNode } from 'react';
import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs';
import { FileDiff, type FileDiffOptions } from '@pierre/diffs/react';

type Props = {
  name: string;
  before: string;
  after: string;
};

class DiffBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const options: FileDiffOptions<undefined, undefined> = {
  theme: { dark: 'github-dark', light: 'github-light' },
  themeType: 'system',
  preferredHighlighter: 'shiki-js',
  diffStyle: 'unified',
  diffIndicators: 'classic',
  overflow: 'wrap',
  disableFileHeader: true,
  hunkSeparators: 'line-info',
  lineDiffType: 'word',
  tokenizeMaxLength: 100000,
  tokenizeMaxLineLength: 1000,
  unsafeCSS:
    ':host{--diffs-font-size:11px;--diffs-line-height:18px;--diffs-bg:var(--code-background);--diffs-fg:var(--foreground)} [data-diffs]{background:var(--code-background)} [data-code]{font-family:Consolas,monospace}',
};

function parse(name: string, before: string, after: string) {
  try {
    return parseDiffFromFile(
      { name, contents: before },
      { name, contents: after },
      undefined,
      true,
    );
  } catch {
    return null;
  }
}

export function ProposalDiff({ name, before, after }: Props) {
  const fileDiff = useMemo<FileDiffMetadata | null>(
    () => parse(name, before, after),
    [name, before, after],
  );
  const fallback = (
    <pre className="px-2.5 py-2 font-mono text-2xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
      {after}
    </pre>
  );
  return (
    <div
      data-assistant-diff={name}
      className="max-h-60 min-w-0 overflow-auto rounded-md border bg-code-background"
    >
      {fileDiff && fileDiff.unifiedLineCount > 0 ? (
        <DiffBoundary fallback={fallback}>
          <FileDiff fileDiff={fileDiff} options={options} disableWorkerPool />
        </DiffBoundary>
      ) : (
        fallback
      )}
    </div>
  );
}
