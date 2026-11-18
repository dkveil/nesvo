import {
  Component,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AnnotationSide,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from '@pierre/diffs';
import { FileDiff, type DiffBasePropsReact } from '@pierre/diffs/react';
import type { CodeCommentSide } from '@nesvo/contracts';
import { Plus } from 'lucide-react';
import { CodeBlock } from '@/shared/ui/code-block';
import { IconButton } from '@/shared/ui/icon-button';
import {
  diffLineRangeOf,
  lineRangeOf,
  selectionOf,
  selectionSideOf,
  type DiffLineRange,
} from './line-range';

export type DiffNote = {
  key: string;
  side: CodeCommentSide;
  line: number;
  content: ReactNode;
};

type NoteGroup = { notes: DiffNote[]; draft: boolean };

type DiffOptions = NonNullable<
  DiffBasePropsReact<NoteGroup, undefined>['options']
>;

const DIFF_CSS =
  ':host{--diffs-font-size:12px;--diffs-line-height:20px;--diffs-bg:var(--code-background);--diffs-fg:var(--foreground)} [data-diffs]{background:var(--code-background)} [data-code]{font-family:Consolas,monospace}';

const annotationsOf = (
  notes: readonly DiffNote[],
  draft: DiffLineRange | null,
): DiffLineAnnotation<NoteGroup>[] => {
  const grouped = new Map<string, DiffLineAnnotation<NoteGroup>>();
  const groupAt = (side: CodeCommentSide, lineNumber: number) => {
    const key = `${side}:${lineNumber}`;
    const existing = grouped.get(key);
    if (existing) return existing.metadata;
    const created: DiffLineAnnotation<NoteGroup> = {
      side: selectionSideOf(side),
      lineNumber,
      metadata: { notes: [], draft: false },
    };
    grouped.set(key, created);
    return created.metadata;
  };
  for (const note of notes) groupAt(note.side, note.line).notes.push(note);
  if (draft) groupAt(draft.side, draft.endLine).draft = true;
  return [...grouped.values()];
};

class DiffBoundary extends Component<
  { children: ReactNode; patch: string; wrap: boolean },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <div className="px-2 pb-2">
        <CodeBlock
          code={this.props.patch}
          wrap={this.props.wrap}
          maxHeightClassName="max-h-none"
        />
      </div>
    ) : (
      this.props.children
    );
  }
}

function GutterCommentButton({ onPress }: { onPress: () => void }) {
  const latestPress = useRef(onPress);
  useLayoutEffect(() => {
    latestPress.current = onPress;
  });
  const pressOnPointerDown = useCallback(
    (element: HTMLButtonElement | null) => {
      if (!element) return;
      const press = (event: PointerEvent) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.preventDefault();
        latestPress.current();
      };
      element.addEventListener('pointerdown', press);
      return () => element.removeEventListener('pointerdown', press);
    },
    [],
  );
  return (
    <IconButton
      ref={pressOnPointerDown}
      label="Comment on this line"
      size={16}
      appearance="send"
      onClick={event => {
        if (event.detail === 0) onPress();
      }}
      className="relative z-10 my-0.5 mr-0.5 animate-in rounded-sm shadow-xs duration-base ease-out fade-in-0 zoom-in-90"
    >
      <Plus className="size-3" strokeWidth={2.5} />
    </IconButton>
  );
}

type DiffFileViewProps = {
  diff: FileDiffMetadata;
  patch: string;
  wrap: boolean;
  commentable: boolean;
  draft: DiffLineRange | null;
  notes?: readonly DiffNote[];
  onDraftRange: (range: DiffLineRange) => void;
  renderDraft: () => ReactNode;
};

const NO_NOTES: readonly DiffNote[] = [];

export function DiffFileView({
  diff,
  patch,
  wrap,
  commentable,
  draft,
  notes = NO_NOTES,
  onDraftRange,
  renderDraft,
}: DiffFileViewProps) {
  const lastHovered = useRef<{
    lineNumber: number;
    side: AnnotationSide;
  } | null>(null);
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  const latest = useRef({ onDraftRange, commentable, diff });
  useLayoutEffect(() => {
    latest.current = { onDraftRange, commentable, diff };
  });
  const draftSide = draft?.side ?? 'new';
  const draftStart = draft?.startLine ?? 0;
  const draftEnd = draft?.endLine ?? 0;
  const drafting = !!draft;
  const draftRange = useMemo(
    () =>
      drafting
        ? { side: draftSide, startLine: draftStart, endLine: draftEnd }
        : null,
    [drafting, draftSide, draftStart, draftEnd],
  );
  const annotations = useMemo(
    () => annotationsOf(notes, draftRange),
    [notes, draftRange],
  );
  const selectedLines = useMemo(
    () => (draftRange ? selectionOf(draftRange) : selection),
    [draftRange, selection],
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
      hunkSeparators: 'line-info',
      enableGutterUtility: commentable,
      enableLineSelection: commentable,
      onLineEnter: line => {
        lastHovered.current = {
          lineNumber: line.lineNumber,
          side: line.annotationSide,
        };
      },
      onLineSelectionChange: range => setSelection(range),
      onLineSelectionEnd: range => {
        setSelection(null);
        if (range && latest.current.commentable)
          latest.current.onDraftRange(
            diffLineRangeOf(latest.current.diff, range),
          );
      },
      unsafeCSS: DIFF_CSS,
    }),
    [wrap, commentable],
  );
  return (
    <DiffBoundary patch={patch} wrap={wrap}>
      <FileDiff<NoteGroup>
        fileDiff={diff}
        options={options}
        lineAnnotations={annotations}
        selectedLines={selectedLines}
        renderAnnotation={annotation => (
          <div className="bg-code-background px-3 py-2 font-sans">
            {annotation.metadata.notes.map(note => (
              <div key={note.key}>{note.content}</div>
            ))}
            {annotation.metadata.draft && renderDraft()}
          </div>
        )}
        renderGutterUtility={
          commentable
            ? getHoveredLine => (
                <GutterCommentButton
                  onPress={() => {
                    const hovered = getHoveredLine() ?? lastHovered.current;
                    if (!hovered) return;
                    onDraftRange(
                      lineRangeOf({
                        start: hovered.lineNumber,
                        end: hovered.lineNumber,
                        side: hovered.side,
                        endSide: hovered.side,
                      }),
                    );
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
