import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  PullRequestFile,
  PullRequestFiles,
  PullRequestThread,
  PullRequestThreads,
} from '@nesvo/contracts';
import {
  ChevronRight,
  FileDiff,
  MessageSquareShare,
  WrapText,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { DiffStat, FileGlyph, StatusLetter } from '@/entities/file-change';
import { CountBadge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Checkbox } from '@/shared/ui/checkbox';
import { CodeBlock } from '@/shared/ui/code-block';
import { EmptyState } from '@/shared/ui/empty-state';
import { IconButton } from '@/shared/ui/icon-button';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { Label } from '@/shared/ui/label';
import { ListRow } from '@/shared/ui/list-row';
import { Toolbar, ToolbarSpacer } from '@/shared/ui/panel';
import { SectionLabel } from '@/shared/ui/section-label';
import { SkeletonList } from '@/shared/ui/skeleton';
import { StatusMessage } from '@/shared/ui/status-message';
import { Hint } from '@/shared/ui/tooltip';
import { CommentBox } from './comment-box';
import { DisabledHint } from '@/shared/ui/disabled-hint';
import { PatchDiff } from './file-diff';
import { lineRangeLabel, type LineDraft, type LineRange } from './line-comment';
import { inlineThreadLines, parseFilePatch } from './patch';
import { isActionLocked, type ActionState } from './use-pull-request-actions';
import type { Resource } from './use-resource';

const DEFAULT_OPEN_FILES = 25;

const fileName = (path: string) => path.split('/').at(-1) ?? path;

const folderOf = (path: string) => path.split('/').slice(0, -1).join('/');

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
  const idPrefix = useId();
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
        controls={<span>Shift-click a line to extend</span>}
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
        <Button type="button" size="xs" variant="ghost" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  if (!files.data)
    return (
      <SkeletonList
        label="Loading changed files"
        rows={8}
        className="px-1 py-2"
      />
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar
        label="Changed files"
        className="pl-3 text-2xs text-muted-foreground"
      >
        <span className="shrink-0 tabular-nums" aria-live="polite">
          {viewedCount} / {list.length} viewed
        </span>
        {files.data.truncated && (
          <span className="shrink-0">· Some files are not listed</span>
        )}
        {threads.status === 'error' && (
          <StatusMessage tone="error" className="min-w-0 [&>span]:truncate">
            Threads unavailable: {threads.error}
          </StatusMessage>
        )}
        <ToolbarSpacer />
        <DisabledHint
          reason={sendReason}
          hint={
            openThreads.length === 0
              ? 'No open review threads'
              : 'Put every open thread into the session composer'
          }
        >
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={openThreads.length === 0 || !!sendReason}
            onClick={() => onSendAll(openThreads)}
          >
            <MessageSquareShare />
            Send all open threads
            <CountBadge count={openThreads.length} tone="muted" />
          </Button>
        </DisabledHint>
        <IconButton
          label="Wrap diff lines"
          pressed={wrap}
          onClick={() => setWrap(value => !value)}
        >
          <WrapText />
        </IconButton>
      </Toolbar>
      {staleReason && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b py-1 pr-1.5 pl-3">
          <StatusMessage tone="warning" className="min-w-0 flex-1">
            {staleReason}
          </StatusMessage>
          <Button type="button" size="xs" variant="ghost" onClick={onRefresh}>
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
              const isViewed = viewed.has(file.path);
              return (
                <li key={file.path} className="flex items-center gap-1">
                  <Checkbox
                    aria-label={`Mark ${file.path} as viewed`}
                    checked={isViewed}
                    onCheckedChange={() => toggleViewed(file.path)}
                    className="ml-1"
                  />
                  <Hint
                    label={
                      file.previousPath
                        ? `${file.previousPath} → ${file.path}`
                        : file.path
                    }
                    side="right"
                  >
                    <ListRow
                      density="tree"
                      selected={focused === file.path}
                      onClick={() => reveal(file.path)}
                      leading={
                        <>
                          <StatusLetter status={file.status} />
                          <FileGlyph name={fileName(file.path)} />
                        </>
                      }
                      title={fileName(file.path)}
                      trailing={
                        count > 0 && (
                          <span aria-label={`${count} review threads`}>
                            {count}
                          </span>
                        )
                      }
                      className={cn(
                        'min-w-0 flex-1',
                        isViewed && 'text-muted-foreground',
                      )}
                    />
                  </Hint>
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
            const viewedId = `${idPrefix}-viewed-${index}`;
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
                <header className="sticky top-0 z-[1] flex h-9 items-center gap-2 border-b bg-background pr-2 pl-1">
                  <ListRow
                    onClick={() =>
                      setExpanded(previous => ({
                        ...previous,
                        [file.path]: !open,
                      }))
                    }
                    mainProps={{ 'aria-expanded': open }}
                    leading={
                      <>
                        <ChevronRight
                          className={cn(
                            'transition-transform duration-base ease-out',
                            open && 'rotate-90',
                          )}
                        />
                        <StatusLetter status={file.status} />
                      </>
                    }
                    title={
                      <>
                        {folder && (
                          <span className="text-muted-foreground">
                            {folder}/
                          </span>
                        )}
                        <span className="font-medium">
                          {fileName(file.path)}
                        </span>
                        {file.previousPath && (
                          <span className="text-2xs text-muted-foreground">
                            {' '}
                            from {file.previousPath}
                          </span>
                        )}
                      </>
                    }
                    trailing={
                      <>
                        {fileThreads.length > 0 && (
                          <span>{fileThreads.length} threads</span>
                        )}
                        <DiffStat
                          additions={file.additions}
                          deletions={file.deletions}
                        />
                      </>
                    }
                    className="min-w-0 flex-1"
                  />
                  <span className="flex shrink-0 items-center gap-1.5">
                    <Checkbox
                      id={viewedId}
                      checked={viewed.has(file.path)}
                      onCheckedChange={() => toggleViewed(file.path)}
                    />
                    <Label
                      htmlFor={viewedId}
                      className="cursor-pointer text-2xs font-normal text-muted-foreground"
                    >
                      Viewed
                    </Label>
                  </span>
                </header>
                {open && (
                  <div className="animate-in duration-base ease-out fade-in-0">
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
                      <div className="px-2 pb-2">
                        <CodeBlock
                          code={file.patch}
                          wrap={wrap}
                          maxHeightClassName="max-h-none"
                        />
                      </div>
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
            <EmptyState size="sm" icon={FileDiff} title="No file changes." />
          )}
          {orphaned.length > 0 && (
            <section aria-label="Other review threads" className="px-2 py-2">
              <SectionLabel className="px-1">
                Threads on files not listed
              </SectionLabel>
              {orphaned.map(thread => renderThread(thread, true))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
