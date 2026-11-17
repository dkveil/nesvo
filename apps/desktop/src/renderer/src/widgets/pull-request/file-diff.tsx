import {
  Component,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from '@pierre/diffs';
import { FileDiff, type DiffBasePropsReact } from '@pierre/diffs/react';
import type { PullRequestThread } from '@nesvo/contracts';
import { Plus } from 'lucide-react';
import {
  lineRangeOf,
  selectedLinesOf,
  selectionSide,
  type LineDraft,
  type LineRange,
} from './line-comment';

type DiffNote = { threads: PullRequestThread[]; draft: boolean };

type NoteAnnotation = DiffLineAnnotation<DiffNote>;

type DiffOptions = NonNullable<
  DiffBasePropsReact<DiffNote, undefined>['options']
>;

const annotationsOf = (
  threads: PullRequestThread[],
  draft: LineDraft | null,
): NoteAnnotation[] => {
  const grouped = new Map<string, NoteAnnotation>();
  const noteAt = (side: NoteAnnotation['side'], lineNumber: number) => {
    const key = `${side}:${lineNumber}`;
    const existing = grouped.get(key);
    if (existing) return existing.metadata;
    const created: NoteAnnotation = {
      side,
      lineNumber,
      metadata: { threads: [], draft: false },
    };
    grouped.set(key, created);
    return created.metadata;
  };
  for (const thread of threads)
    noteAt(
      thread.side === 'left' ? 'deletions' : 'additions',
      thread.line ?? 0,
    ).threads.push(thread);
  if (draft) noteAt(selectionSide(draft.side), draft.line).draft = true;
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

const stopPointerDown = (element: HTMLButtonElement | null) => {
  if (!element) return;
  const stop = (event: PointerEvent) => event.stopPropagation();
  element.addEventListener('pointerdown', stop);
  return () => element.removeEventListener('pointerdown', stop);
};

function GutterCommentButton({ onPress }: { onPress: () => void }) {
  return (
    <button
      ref={stopPointerDown}
      type="button"
      aria-label="Comment on this line"
      title="Comment on this line. Shift-click another line number to select a range."
      onClick={onPress}
      className="my-0.5 mr-0.5 flex size-4 animate-in cursor-pointer items-center justify-center rounded-sm bg-primary text-primary-foreground shadow-xs duration-150 ease-out fade-in-0 zoom-in-90 outline-none hover:bg-primary/85 focus-visible:ring-1 focus-visible:ring-ring motion-reduce:animate-none"
    >
      <Plus aria-hidden="true" className="size-3" strokeWidth={2.5} />
    </button>
  );
}

type PatchDiffProps = {
  diff: FileDiffMetadata;
  patch: string;
  threads: PullRequestThread[];
  wrap: boolean;
  draft: LineDraft | null;
  commentable: boolean;
  onDraftRange: (range: LineRange) => void;
  renderThread: (thread: PullRequestThread) => ReactNode;
  renderDraft: () => ReactNode;
};

export function PatchDiff({
  diff,
  patch,
  threads,
  wrap,
  draft,
  commentable,
  onDraftRange,
  renderThread,
  renderDraft,
}: PatchDiffProps) {
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  const latest = useRef({ draft, onDraftRange });
  useLayoutEffect(() => {
    latest.current = { draft, onDraftRange };
  });
  const annotations = useMemo(
    () => annotationsOf(threads, draft),
    [threads, draft],
  );
  const selectedLines = useMemo(
    () => (draft ? selectedLinesOf(draft) : commentable ? selection : null),
    [draft, selection, commentable],
  );
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
      enableGutterUtility: commentable,
      enableLineSelection: commentable,
      onLineSelected: range => {
        if (!latest.current.draft) setSelection(range);
        else if (range) latest.current.onDraftRange(lineRangeOf(range));
      },
      unsafeCSS:
        ':host{--diffs-font-size:12px;--diffs-line-height:20px;--diffs-bg:var(--code-background);--diffs-fg:var(--foreground)} [data-diffs]{background:var(--code-background)} [data-code]{font-family:Consolas,monospace}',
    }),
    [wrap, commentable],
  );
  return (
    <DiffBoundary patch={patch}>
      <FileDiff<DiffNote>
        fileDiff={diff}
        options={options}
        lineAnnotations={annotations}
        selectedLines={selectedLines}
        renderAnnotation={annotation => (
          <div className="px-2 font-sans">
            {annotation.metadata.threads.map(thread => renderThread(thread))}
            {annotation.metadata.draft && renderDraft()}
          </div>
        )}
        renderGutterUtility={
          commentable
            ? getHoveredLine => (
                <GutterCommentButton
                  onPress={() => {
                    const hovered = getHoveredLine();
                    const range =
                      selection ??
                      (hovered
                        ? {
                            start: hovered.lineNumber,
                            end: hovered.lineNumber,
                            side: hovered.side,
                            endSide: hovered.side,
                          }
                        : null);
                    if (!range) return;
                    setSelection(null);
                    onDraftRange(lineRangeOf(range));
                  }}
                />
              )
            : undefined
        }
        disableWorkerPool
      />
    </DiffBoundary>
  );
}
