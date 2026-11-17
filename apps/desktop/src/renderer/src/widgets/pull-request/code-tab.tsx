import { useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  PullRequestFile,
  PullRequestFiles,
  PullRequestThread,
  PullRequestThreads,
} from '@nesvo/contracts';
import { ChevronRight, MessageSquareShare, WrapText } from 'lucide-react';
import { cn } from 'cn';
import { FileGlyph } from '@/widgets/workspace-files/file-glyph';
import { Button } from '@/shared/ui/button';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { PanelAction } from '@/shared/ui/panel';
import { panelRow } from '@/shared/ui/panel-styles';
import { CommentBox } from './comment-box';
import { PatchDiff } from './file-diff';
import { lineRangeLabel, type LineDraft, type LineRange } from './line-comment';
import { inlineThreadLines, parseFilePatch } from './patch';
import { isActionLocked, type ActionState } from './use-pull-request-actions';
import type { Resource } from './use-resource';

const DEFAULT_OPEN_FILES = 25;

const STATUS_GLYPHS: Record<
  PullRequestFile['status'],
  { letter: string; tone: string; label: string }
> = {
  added: { letter: 'A', tone: 'text-success-foreground', label: 'Added' },
  removed: { letter: 'D', tone: 'text-error-foreground', label: 'Deleted' },
  modified: { letter: 'M', tone: 'text-warning-foreground', label: 'Modified' },
  renamed: { letter: 'R', tone: 'text-info-foreground', label: 'Renamed' },
  copied: { letter: 'C', tone: 'text-info-foreground', label: 'Copied' },
  changed: { letter: 'M', tone: 'text-warning-foreground', label: 'Changed' },
  unchanged: { letter: '·', tone: 'text-muted-foreground', label: 'Unchanged' },
};

const fileName = (path: string) => path.split('/').at(-1) ?? path;

const folderOf = (path: string) => path.split('/').slice(0, -1).join('/');

function StatusLetter({ status }: { status: PullRequestFile['status'] }) {
  const glyph = STATUS_GLYPHS[status];
  return (
    <span
      title={glyph.label}
      aria-label={glyph.label}
      className={cn(
        'w-2.5 shrink-0 text-center font-mono text-2xs font-semibold',
        glyph.tone,
      )}
    >
      {glyph.letter}
    </span>
  );
}

function Counts({ file }: { file: PullRequestFile }) {
  return (
    <span className="flex shrink-0 gap-1.5 font-mono text-2xs tabular-nums">
      <span className="text-success-foreground">+{file.additions}</span>
      <span className="text-error-foreground">−{file.deletions}</span>
    </span>
  );
}

type CodeTabProps = {
  files: Resource<PullRequestFiles>;
  threads: Resource<PullRequestThreads>;
  viewed: ReadonlySet<string>;
  sendReason: string;
  commentReason: string;
  staleReason: string;
  lineCommentState: ActionState | undefined;
  onToggleViewed: (path: string) => void;
  onSendAll: (threads: PullRequestThread[]) => void;
  onRetry: () => void;
  onRefresh: () => void;
  onLineComment: (draft: LineDraft) => Promise<boolean>;
  onLineCommentEdit: () => void;
  renderThread: (thread: PullRequestThread, showLocation: boolean) => ReactNode;
};

export function CodeTab({
  files,
  threads,
  viewed,
  sendReason,
  commentReason,
  staleReason,
  lineCommentState,
  onToggleViewed,
  onSendAll,
  onRetry,
  onRefresh,
  onLineComment,
  onLineCommentEdit,
  renderThread,
}: CodeTabProps) {
  const [wrap, setWrap] = useState(false);
  const [draft, setDraft] = useState<LineDraft | null>(null);
  const draftLocked = isActionLocked(lineCommentState);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [focused, setFocused] = useState('');
  const sections = useRef(new Map<string, HTMLElement>());
  const list = useMemo(() => files.data?.files ?? [], [files.data]);
  const allThreads = useMemo(() => threads.data?.threads ?? [], [threads.data]);
  const threadsByPath = useMemo(() => {
    const grouped = new Map<string, PullRequestThread[]>();
    for (const thread of allThreads)
      grouped.set(thread.path, [...(grouped.get(thread.path) ?? []), thread]);
    return grouped;
  }, [allThreads]);
  const parsed = useMemo(() => {
    const prefix = files.data
      ? `${files.data.reference.repository}#${files.data.reference.number}@${files.data.headSha}`
      : '';
    return new Map(
      list.map(file => [
        file.path,
        parseFilePatch(file, `${prefix}:${file.path}`),
      ]),
    );
  }, [files.data, list]);
  const orphaned = allThreads.filter(
    thread => !list.some(file => file.path === thread.path),
  );
  const openThreads = allThreads.filter(thread => !thread.isResolved);
  const viewedCount = list.filter(file => viewed.has(file.path)).length;
  const isOpen = (file: PullRequestFile, index: number) =>
    expanded[file.path] ??
    (!viewed.has(file.path) && index < DEFAULT_OPEN_FILES);
  const reveal = (path: string) => {
    setExpanded(previous => ({ ...previous, [path]: true }));
    setFocused(path);
    const reduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    requestAnimationFrame(() =>
      sections.current.get(path)?.scrollIntoView({
        block: 'start',
        behavior: reduced ? 'auto' : 'smooth',
      }),
    );
  };
  const openDraft = (path: string, range: LineRange) => {
    if (draftLocked) return;
    setDraft(previous => ({
      ...range,
      path,
      body: previous?.path === path ? previous.body : '',
    }));
    onLineCommentEdit();
  };
  const submitDraft = async () => {
    if (!draft) return;
    if (await onLineComment({ ...draft, body: draft.body.trim() }))
      setDraft(null);
  };
  const renderDraft = () =>
    draft && (
      <CommentBox
        label={`Comment on ${lineRangeLabel(draft)}`}
        placeholder={`Comment on ${lineRangeLabel(draft)}`}
        value={draft.body}
        onChange={body => {
          setDraft(previous => previous && { ...previous, body });
          onLineCommentEdit();
        }}
        submitLabel="Comment"
        canSubmit={!!draft.body.trim()}
        state={lineCommentState}
        blockedReason={commentReason}
        onSubmit={() => void submitDraft()}
        onCancel={() => setDraft(null)}
        controls={
          <span className="text-2xs text-muted-foreground">
            Shift-click a line to extend
          </span>
        }
        autoFocus
        className="my-1.5"
      />
    );
  const toggleViewed = (path: string) => {
    if (!viewed.has(path))
      setExpanded(previous => ({ ...previous, [path]: false }));
    onToggleViewed(path);
  };
  if (files.status === 'error' && !files.data)
    return (
      <div className="flex flex-wrap items-center gap-2 p-4">
        <InlineNotice tone="error" className="min-w-0 flex-1">
          {files.error}
        </InlineNotice>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          onClick={onRetry}
        >
          Try again
        </Button>
      </div>
    );
  if (!files.data)
    return (
      <p role="status" className="p-4 text-xs text-muted-foreground">
        Loading changed files…
      </p>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b pr-1.5 pl-3 text-2xs text-muted-foreground">
        <span className="tabular-nums" aria-live="polite">
          {viewedCount} / {list.length} viewed
        </span>
        {files.data.truncated && <span>· Some files are not listed</span>}
        {threads.status === 'error' && (
          <span
            role="alert"
            className="truncate text-error-foreground"
            title={threads.error}
          >
            · Threads unavailable: {threads.error}
          </span>
        )}
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={openThreads.length === 0 || !!sendReason}
          title={
            sendReason ||
            (openThreads.length === 0
              ? 'No open review threads'
              : 'Put every open thread into the session composer')
          }
          onClick={() => onSendAll(openThreads)}
          className="h-6 text-2xs text-muted-foreground enabled:hover:text-foreground disabled:cursor-not-allowed"
        >
          <MessageSquareShare />
          Send all open threads
          <span className="tabular-nums">{openThreads.length}</span>
        </Button>
        <PanelAction
          aria-label="Wrap diff lines"
          aria-pressed={wrap}
          onClick={() => setWrap(value => !value)}
        >
          <WrapText />
        </PanelAction>
      </div>
      {staleReason && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
          <p
            role="status"
            className="min-w-0 flex-1 text-2xs text-warning-foreground"
          >
            {staleReason}
          </p>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="h-6 text-2xs text-muted-foreground enabled:hover:text-foreground"
            onClick={onRefresh}
          >
            Refresh
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Changed files"
          className="w-[32%] max-w-60 min-w-40 shrink-0 overflow-y-auto border-r p-1"
        >
          <ul className="space-y-px">
            {list.map(file => {
              const count = threadsByPath.get(file.path)?.length ?? 0;
              return (
                <li key={file.path} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    aria-label={`Mark ${file.path} as viewed`}
                    checked={viewed.has(file.path)}
                    onChange={() => toggleViewed(file.path)}
                    className="ml-1 size-3 shrink-0 accent-foreground"
                  />
                  <button
                    type="button"
                    title={
                      file.previousPath
                        ? `${file.previousPath} → ${file.path}`
                        : file.path
                    }
                    aria-pressed={focused === file.path}
                    onClick={() => reveal(file.path)}
                    className={cn(
                      panelRow,
                      'flex h-[1.375rem] min-w-0 flex-1 items-center gap-1.5 px-1.5 text-xs',
                      viewed.has(file.path) && 'opacity-60',
                    )}
                  >
                    <StatusLetter status={file.status} />
                    <FileGlyph name={fileName(file.path)} />
                    <span className="min-w-0 flex-1 truncate">
                      {fileName(file.path)}
                    </span>
                    {count > 0 && (
                      <span
                        aria-label={`${count} review threads`}
                        className="shrink-0 text-2xs text-muted-foreground tabular-nums"
                      >
                        {count}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {list.map((file, index) => {
            const open = isOpen(file, index);
            const diff = parsed.get(file.path) ?? null;
            const fileThreads = threadsByPath.get(file.path) ?? [];
            const placement = diff
              ? inlineThreadLines(diff, fileThreads)
              : { inline: [], detached: fileThreads };
            const folder = folderOf(file.path);
            return (
              <section
                key={file.path}
                ref={element => {
                  if (element) sections.current.set(file.path, element);
                  else sections.current.delete(file.path);
                }}
                aria-label={`Changes in ${file.path}`}
                className="scroll-mt-0 border-b"
              >
                <header className="sticky top-0 z-[1] flex h-8 items-center gap-1.5 border-b bg-background pr-2 pl-1.5 text-xs">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() =>
                      setExpanded(previous => ({
                        ...previous,
                        [file.path]: !open,
                      }))
                    }
                    className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={cn(
                        'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out',
                        open && 'rotate-90',
                      )}
                    />
                    <StatusLetter status={file.status} />
                    <span className="min-w-0 truncate" title={file.path}>
                      {folder && (
                        <span className="text-muted-foreground">{folder}/</span>
                      )}
                      <span className="font-medium">{fileName(file.path)}</span>
                    </span>
                    {file.previousPath && (
                      <span
                        className="min-w-0 truncate text-2xs text-muted-foreground"
                        title={file.previousPath}
                      >
                        from {file.previousPath}
                      </span>
                    )}
                  </button>
                  {fileThreads.length > 0 && (
                    <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                      {fileThreads.length} threads
                    </span>
                  )}
                  <Counts file={file} />
                  <label className="flex shrink-0 cursor-pointer items-center gap-1 text-2xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={viewed.has(file.path)}
                      onChange={() => toggleViewed(file.path)}
                      className="size-3 accent-foreground"
                    />
                    Viewed
                  </label>
                </header>
                {open && (
                  <div className="animate-in duration-150 fade-in-0">
                    {file.patchTruncated && (
                      <InlineNotice className="m-2">
                        This diff is too large to show in full. Open the pull
                        request on GitHub for the rest.
                      </InlineNotice>
                    )}
                    {diff && file.patch ? (
                      <PatchDiff
                        diff={diff}
                        patch={file.patch}
                        threads={placement.inline}
                        wrap={wrap}
                        draft={draft?.path === file.path ? draft : null}
                        commentable={!commentReason}
                        onDraftRange={range => openDraft(file.path, range)}
                        renderThread={thread => renderThread(thread, false)}
                        renderDraft={renderDraft}
                      />
                    ) : (
                      <p className="px-4 py-3 text-xs text-muted-foreground">
                        {file.patch
                          ? 'This change cannot be shown as numbered lines.'
                          : 'No text diff for this file. It may be binary, renamed without changes or too large.'}
                      </p>
                    )}
                    {file.patch && !diff && (
                      <pre className="overflow-auto bg-code-background px-3 pb-3 font-mono text-xs leading-5">
                        <code>{file.patch}</code>
                      </pre>
                    )}
                    {placement.detached.length > 0 && (
                      <div className="px-2 pb-1">
                        {placement.detached.map(thread =>
                          renderThread(thread, true),
                        )}
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
          {list.length === 0 && (
            <p className="p-4 text-xs text-muted-foreground">
              No file changes.
            </p>
          )}
          {orphaned.length > 0 && (
            <section aria-label="Other review threads" className="px-2 py-2">
              <h3 className="px-1 pb-1 text-2xs font-medium text-muted-foreground">
                Threads on files not listed
              </h3>
              {orphaned.map(thread => renderThread(thread, true))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
