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
import { DiffStat } from '@/entities/file-change';
import { usePanelWidth } from '@/shared/lib/use-panel-width';
import { CodeBlock } from '@/shared/ui/code-block';
import { Disclosure } from '@/shared/ui/disclosure';
import { ListRow } from '@/shared/ui/list-row';
import { Panel, PanelAction, PanelHeader } from '@/shared/ui/panel';
import { PanelResizer } from '@/shared/ui/panel-resizer';
import { panelSurface } from '@/shared/ui/panel-styles';
import { StatusMessage } from '@/shared/ui/status-message';

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
  return (
    <Disclosure
      title="Raw patch"
      defaultOpen={expanded}
      className="max-h-[45%] shrink-0 overflow-y-auto border-t p-1.5"
      contentClassName="pt-1.5 pr-0.5 pb-0.5 pl-0.5"
    >
      <CodeBlock
        aria-label="Saved patch"
        code={patch}
        maxHeightClassName="max-h-none"
      />
    </Disclosure>
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

const DEFAULT_WIDTH_RATIO = 0.46;
const DEFAULT_MAX_WIDTH_PX = 850;

const defaultPanelWidth = (viewportWidth: number) =>
  Math.min(DEFAULT_MAX_WIDTH_PX, viewportWidth * DEFAULT_WIDTH_RATIO);

export default function ReviewDiff({
  review,
  selectedPath,
  onSelectPath,
  onClose,
  onFiles,
}: Props) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useEffectEvent(onClose);
  const {
    attach: attachPanel,
    style: panelStyle,
    resizer,
  } = usePanelWidth('diff', defaultPanelWidth);
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
    <p className="p-4 text-xs leading-6 text-muted-foreground">
      This change cannot be displayed as numbered lines. Open the raw patch to
      inspect the saved content.
    </p>
  );
  return (
    <Panel
      role="region"
      aria-label="Saved result diff"
      data-review-id={review.id}
      data-review-version={review.version}
      ref={attachPanel}
      style={panelStyle}
      className={panelSurface}
    >
      <PanelResizer label="Resize saved diff panel" {...resizer} />
      <PanelHeader
        titleBar
        icon={FileCode2}
        title={`Result v${review.version}`}
        meta={reviewStatusLabels[review.status]}
      >
        <PanelAction label="Browse workspace files" onClick={onFiles}>
          <FolderOpen />
        </PanelAction>
        <PanelAction
          label="Wrap diff lines"
          aria-pressed={wrap}
          onClick={() => setWrap(value => !value)}
        >
          <WrapText />
        </PanelAction>
        <PanelAction ref={closeButton} label="Close diff" onClick={onClose}>
          <X className="size-4" />
        </PanelAction>
      </PanelHeader>
      <div className="shrink-0 border-b px-3 py-2.5">
        <p className="truncate text-ui font-medium">{review.title}</p>
        <p className="mt-1 text-2xs text-muted-foreground">
          Saved changes · Start → end of this turn
        </p>
      </div>
      {review.diff.status !== 'complete' && (
        <StatusMessage variant="notice" tone="warning" className="m-1.5">
          {review.diff.detail ??
            'A complete diff is unavailable for this result.'}
        </StatusMessage>
      )}
      {review.diff.status === 'complete' && !parsed.complete && (
        <StatusMessage variant="notice" tone="warning" className="m-1.5">
          Some changes cannot be displayed as numbered lines. The raw patch
          below retains the saved result.
        </StatusMessage>
      )}
      <nav
        aria-label="Changed files"
        className="max-h-[25%] shrink-0 space-y-px overflow-auto border-b p-1.5"
      >
        {review.diff.files.map(file => {
          const stat = counts(parsed.files.get(file.path));
          const selected = path === file.path;
          return (
            <ListRow
              key={file.path}
              title={file.path}
              selected={selected}
              trailing={
                stat && (stat.added > 0 || stat.removed > 0) ? (
                  <DiffStat additions={stat.added} deletions={stat.removed} />
                ) : (
                  fileKindLabels[file.kind]
                )
              }
              mainProps={{
                'aria-label': `View changes in ${file.path}`,
                'aria-pressed': selected,
                'aria-current': undefined,
              }}
              onClick={() => onSelectPath(file.path)}
            />
          );
        })}
      </nav>
      {parsed.metadata.has(path) && (
        <p
          className="shrink-0 border-b px-4 py-2 text-2xs text-muted-foreground"
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
    </Panel>
  );
}
