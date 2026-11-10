import {
  Component,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';
import {
  CodeView,
  type CodeViewItem,
  type CodeViewReactOptions,
} from '@pierre/diffs/react';
import { FileCode2, FolderOpen, WrapText, X } from 'lucide-react';
import {
  fileKindLabels,
  reviewStatusLabels,
  type Review,
} from '@/entities/review';
import { Button } from '@/shared/ui/button';

type Props = {
  review: Review;
  selectedPath?: string;
  onSelectPath: (path: string) => void;
  onClose: () => void;
  onFiles: () => void;
};

function parseReview(review: Review) {
  try {
    const files = parsePatchFiles(review.diff.patch, {
      cacheKeyPrefix: review.id,
      throwOnError: true,
    }).flatMap(patch => patch.files);
    const indexed = new Map(files.map(file => [file.name, file]));
    const blocks = review.diff.patch
      .split(/(?=^diff --git )/m)
      .filter(block => block.startsWith('diff --git '));
    const metadata = new Map<string, string>();
    if (blocks.length === files.length) {
      files.forEach((file, index) => {
        const before = blocks[index]?.match(/^old type\/mode (.+)$/m)?.[1];
        const after = blocks[index]?.match(/^new type\/mode (.+)$/m)?.[1];
        const display = (value: string) =>
          value.replace(
            / (\d+)$/,
            (_, mode: string) => ` · ${mode.padStart(4, '0')}`,
          );
        if (before && after && before !== after)
          metadata.set(file.name, `${display(before)} → ${display(after)}`);
      });
    }
    const complete =
      indexed.size === review.diff.files.length &&
      review.diff.files.every(file => indexed.has(file.path));
    return { files: indexed, metadata, complete };
  } catch {
    return {
      files: new Map<string, FileDiffMetadata>(),
      metadata: new Map<string, string>(),
      complete: false,
    };
  }
}

class ViewerBoundary extends Component<
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

function PatchSource({
  patch,
  expanded = false,
}: {
  patch: string;
  expanded?: boolean;
}) {
  const [open, setOpen] = useState(expanded);
  return (
    <details
      open={open}
      onToggle={event => setOpen(event.currentTarget.open)}
      className="max-h-[45%] shrink-0 overflow-auto border-t text-xs"
    >
      <summary className="cursor-pointer px-4 py-3 text-muted-foreground focus-visible:outline-ring">
        Raw patch
      </summary>
      {open && (
        <pre
          aria-label="Saved patch"
          className="overflow-auto px-4 pb-4 leading-6"
        >
          <code>{patch}</code>
        </pre>
      )}
    </details>
  );
}

function FileViewer({ file, wrap }: { file: FileDiffMetadata; wrap: boolean }) {
  const items = useMemo<CodeViewItem<undefined>[]>(
    () => [{ id: file.cacheKey ?? file.name, type: 'diff', fileDiff: file }],
    [file],
  );
  const options = useMemo<CodeViewReactOptions<undefined, undefined>>(
    () => ({
      theme: { dark: 'github-dark', light: 'github-light' },
      themeType: 'system',
      preferredHighlighter: 'shiki-js',
      diffStyle: 'unified',
      diffIndicators: 'classic',
      overflow: wrap ? 'wrap' : 'scroll',
      disableFileHeader: true,
      hunkSeparators: 'line-info',
      lineDiffType: 'word',
      tokenizeMaxLength: 100000,
      tokenizeMaxLineLength: 1000,
      unsafeCSS:
        ':host{--diffs-font-size:12px;--diffs-line-height:22px;--diffs-bg:var(--code-background);--diffs-fg:var(--foreground)} [data-diffs]{background:var(--code-background)} [data-code]{font-family:Consolas,monospace}',
    }),
    [wrap],
  );
  return (
    <CodeView
      items={items}
      options={options}
      disableWorkerPool
      className="h-full min-h-0"
    />
  );
}

export default function ReviewDiff({
  review,
  selectedPath,
  onSelectPath,
  onClose,
  onFiles,
}: Props) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useEffectEvent(onClose);
  const path = review.diff.files.some(file => file.path === selectedPath)
    ? selectedPath!
    : (review.diff.files[0]?.path ?? '');
  const [wrap, setWrap] = useState(false);
  const parsed = useMemo(() => parseReview(review), [review]);
  const selectedFile = parsed.files.get(path);
  const fileInfo = review.diff.files.find(file => file.path === path);
  const counts = (file: FileDiffMetadata | undefined) =>
    file?.hunks.reduce(
      (sum, hunk) => ({
        added: sum.added + hunk.additionLines,
        removed: sum.removed + hunk.deletionLines,
      }),
      { added: 0, removed: 0 },
    );
  useEffect(() => {
    closeButton.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !(
          event.target instanceof Element &&
          event.target.closest('[role="dialog"]')
        )
      ) {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  const fallback = (
    <div className="p-4 text-xs leading-6 text-muted-foreground">
      This change cannot be displayed as numbered lines. Open the raw patch to
      inspect the saved content.
    </div>
  );
  return (
    <section
      role="region"
      aria-label="Saved result diff"
      data-review-id={review.id}
      data-review-version={review.version}
      className="absolute inset-0 z-10 flex min-h-0 min-w-0 flex-col border-l bg-code-background min-[1200px]:relative min-[1200px]:inset-auto min-[1200px]:w-[46%] min-[1200px]:max-w-[850px] min-[1200px]:shrink-0"
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
        <FileCode2 className="size-4 text-muted-foreground" />
        <h2 className="text-xs font-medium">Result v{review.version}</h2>
        <span className="text-xs text-muted-foreground">
          {reviewStatusLabels[review.status]}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Browse workspace files"
          title="Current workspace files"
          onClick={onFiles}
          className="ml-auto size-7"
        >
          <FolderOpen className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Wrap diff lines"
          aria-pressed={wrap}
          onClick={() => setWrap(value => !value)}
          className="size-7"
        >
          <WrapText className="size-3.5" />
        </Button>
        <Button
          ref={closeButton}
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close diff"
          onClick={onClose}
          className="size-7"
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="shrink-0 border-b px-4 py-3">
        <p className="truncate text-xs" title={review.title}>
          {review.title}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Saved changes · Start → end of this turn
        </p>
      </div>
      {review.diff.status !== 'complete' && (
        <p
          role="status"
          className="px-4 py-3 text-xs leading-5 text-muted-foreground"
        >
          {review.diff.detail ??
            'A complete diff is unavailable for this result.'}
        </p>
      )}
      {review.diff.status === 'complete' && !parsed.complete && (
        <p
          role="status"
          className="px-4 py-3 text-xs leading-5 text-muted-foreground"
        >
          Some changes cannot be displayed as numbered lines. The raw patch
          below retains the saved result.
        </p>
      )}
      <nav
        aria-label="Changed files"
        className="max-h-[25%] shrink-0 overflow-auto border-b py-1"
      >
        {review.diff.files.map(file => {
          const stat = counts(parsed.files.get(file.path));
          return (
            <button
              key={file.path}
              type="button"
              aria-label={`View changes in ${file.path}`}
              aria-pressed={path === file.path}
              title={file.path}
              onClick={() => onSelectPath(file.path)}
              className="flex w-full min-w-0 items-center gap-3 px-4 py-2 text-left text-xs text-muted-foreground hover:bg-accent focus-visible:outline-ring aria-pressed:bg-highlight aria-pressed:text-foreground"
            >
              <span className="min-w-0 flex-1 truncate">{file.path}</span>
              {stat && (stat.added > 0 || stat.removed > 0) ? (
                <span className="flex shrink-0 gap-2 font-mono text-[11px]">
                  <span className="text-emerald-400">+{stat.added}</span>
                  <span className="text-red-400">−{stat.removed}</span>
                </span>
              ) : (
                <span className="text-[11px]">{fileKindLabels[file.kind]}</span>
              )}
            </button>
          );
        })}
      </nav>
      {parsed.metadata.has(path) && (
        <p
          className="shrink-0 border-b px-4 py-2 text-[11px] text-muted-foreground"
          aria-label="File metadata"
        >
          {parsed.metadata.get(path)}
        </p>
      )}
      <div
        data-testid="saved-diff-content"
        data-file-path={path}
        className="min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        {selectedFile && selectedFile.unifiedLineCount > 0 ? (
          <ViewerBoundary key={`${review.id}:${path}`} fallback={fallback}>
            <FileViewer file={selectedFile} wrap={wrap} />
          </ViewerBoundary>
        ) : fileInfo && parsed.metadata.has(path) ? (
          <p className="p-4 text-xs leading-6 text-muted-foreground">
            File metadata changed. No text lines changed. The raw patch
            preserves the exact details.
          </p>
        ) : fileInfo ? (
          fallback
        ) : (
          <p className="p-4 text-xs text-muted-foreground">
            No file changes were recorded.
          </p>
        )}
      </div>
      {review.diff.patch && (
        <PatchSource
          key={review.id}
          patch={review.diff.patch}
          expanded={!parsed.complete}
        />
      )}
    </section>
  );
}
