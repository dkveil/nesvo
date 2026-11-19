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
  PanelLeft,
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
import { DisabledHint } from '@/shared/ui/disabled-hint';
import type { AgentCommentTarget } from '@/features/code-comments/agent-target';
import {
  CodeCommentForm,
  type CodeCommentTarget,
} from '@/features/diff-viewer/code-comment-form';
import {
  DiffFileView,
  type DiffNote,
} from '@/features/diff-viewer/diff-file-view';
import { DiffFullscreen } from '@/features/diff-viewer/diff-fullscreen';
import {
  FullscreenButton,
  WrapToggle,
} from '@/features/diff-viewer/diff-view-toggles';
import {
  lineRangeDescription,
  type DiffLineRange,
} from '@/features/diff-viewer/line-range';
import {
  codeCommentOf,
  useCommentDraft,
} from '@/features/diff-viewer/use-comment-draft';
import { useDiffWrap } from '@/features/diff-viewer/use-diff-wrap';
import { ActionFeedback } from './action-feedback';
import { readFileListOpen, saveFileListOpen } from './file-list-preference';
import { inlineThreadLines, parseFilePatch } from './patch';
import { isActionLocked, type ActionState } from './use-pull-request-actions';

export type ReviewLineComment = {
  path: string;
  side: 'left' | 'right';
  line: number;
  startLine: number | null;
  body: string;
};

const reviewLineComment = (
  path: string,
  range: DiffLineRange,
  body: string,
): ReviewLineComment => ({
  path,
  side: range.side === 'old' ? 'left' : 'right',
  line: range.endLine,
  startLine: range.startLine === range.endLine ? null : range.startLine,
  body,
});

const threadNotes = (
  threads: PullRequestThread[],
  render: (thread: PullRequestThread) => ReactNode,
): DiffNote[] =>
  threads.map(thread => ({
    key: thread.id,
    side: thread.side === 'left' ? 'old' : 'new',
    line: thread.line ?? 0,
    content: render(thread),
  }));
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
  agentComments: AgentCommentTarget;
  onToggleViewed: (path: string) => void;
  onSendAll: (threads: PullRequestThread[]) => void;
  onRetry: () => void;
  onRefresh: () => void;
  onLineComment: (comment: ReviewLineComment) => Promise<boolean>;
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
  agentComments,
  onToggleViewed,
  onSendAll,
  onRetry,
  onRefresh,
  onLineComment,
  onLineCommentEdit,
  renderThread,
}: CodeTabProps) {
  const idPrefix = useId();
  const fileListId = `${idPrefix}-files`;
  const [wrap] = useDiffWrap();
  const [fullscreen, setFullscreen] = useState<string | null>(null);
  const [agentNotice, setAgentNotice] = useState('');
  const [fileListOpen, setFileListOpen] = useState(readFileListOpen);
  const toggleFileList = () => {
    const next = !fileListOpen;
    setFileListOpen(next);
    saveFileListOpen(next);
  };
  const comments = useCommentDraft();
  const draft = comments.draft;
  const draftLocked = isActionLocked(lineCommentState);
  const agentAvailable = !agentComments.blockedReason;
  const [chosenTarget, setTarget] = useState<CodeCommentTarget | null>(null);
  const target: CodeCommentTarget =
    chosenTarget ??
    (agentAvailable && (agentComments.preferred || commentReason)
      ? 'agent'
      : 'review');
  const commentable = agentAvailable || !commentReason;
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
  const openDraft = (path: string, range: DiffLineRange) => {
    if (draftLocked) return;
    comments.open(path, range);
    setAgentNotice('');
    onLineCommentEdit();
  };
  const submitDraft = async () => {
    if (!draft) return;
    const diff = parsed.get(draft.path);
    if (target === 'agent') {
      if (!diff) return;
      if (agentComments.add(codeCommentOf(draft, diff))) {
        comments.close();
        setAgentNotice(`Added to the composer of ${agentComments.title}.`);
      } else setAgentNotice('The composer already holds 20 code comments.');
      return;
    }
    if (
      await onLineComment(
        reviewLineComment(draft.path, draft.range, draft.body.trim()),
      )
    )
      comments.close();
  };
  const renderDraft = () =>
    draft && (
      <CodeCommentForm
        location={`${draft.path} ${lineRangeDescription(draft.range)}`}
        value={draft.body}
        targets={[
          {
            value: 'agent',
            label: 'Send to agent',
            blockedReason: agentComments.blockedReason,
          },
          {
            value: 'review',
            label: 'Add to review',
            blockedReason: commentReason,
          },
        ]}
        target={target}
        pending={lineCommentState?.status === 'pending'}
        feedback={
          target === 'review' ? (
            <ActionFeedback state={lineCommentState} />
          ) : undefined
        }
        onChange={body => {
          comments.edit(body);
          onLineCommentEdit();
        }}
        onTargetChange={next => {
          setTarget(next);
          onLineCommentEdit();
        }}
        onSubmit={() => void submitDraft()}
        onCancel={comments.close}
      />
    );
  const inlineThreadsOf = (file: PullRequestFile) => {
    const diff = parsed.get(file.path);
    const fileThreads = threadsByPath.get(file.path) ?? [];
    return diff ? inlineThreadLines(diff, fileThreads).inline : [];
  };
  const renderFileDiff = (file: PullRequestFile, inFullscreen: boolean) => {
    const diff = parsed.get(file.path) ?? null;
    if (!diff || !file.patch) return null;
    const showDraft =
      draft?.path === file.path && (fullscreen === file.path) === inFullscreen;
    return (
      <DiffFileView
        diff={diff}
        patch={file.patch}
        wrap={wrap}
        commentable={commentable}
        draft={showDraft ? draft.range : null}
        notes={threadNotes(inlineThreadsOf(file), thread =>
          renderThread(thread, false),
        )}
        onDraftRange={range => openDraft(file.path, range)}
        renderDraft={renderDraft}
      />
    );
  };
  const fullscreenFile = list.find(file => file.path === fullscreen);
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
      <Toolbar label="Changed files" className="text-2xs text-muted-foreground">
        <IconButton
          label={fileListOpen ? 'Hide changed files' : 'Show changed files'}
          pressed={fileListOpen}
          aria-controls={fileListOpen ? fileListId : undefined}
          onClick={toggleFileList}
        >
          <PanelLeft />
        </IconButton>
        {files.data.truncated && (
          <span className="shrink-0 pl-1">Some files are not listed</span>
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
        <WrapToggle />
      </Toolbar>
      {agentNotice && (
        <StatusMessage
          tone="success"
          role="status"
          className="shrink-0 border-b py-1 pr-1.5 pl-3"
        >
          {agentNotice}
        </StatusMessage>
      )}
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
        {fileListOpen && (
          <nav
            id={fileListId}
            aria-label="Changed files"
            className="w-1/4 max-w-56 min-w-32 shrink-0 animate-in overflow-y-auto border-r p-1 duration-base ease-out fade-in-0"
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
        )}
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
                  {diff && file.patch && (
                    <FullscreenButton
                      path={file.path}
                      onOpen={() => setFullscreen(file.path)}
                    />
                  )}
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
                      renderFileDiff(file, false)
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
          <DiffFullscreen
            path={fullscreenFile ? fullscreenFile.path : null}
            meta={
              fullscreenFile && (
                <DiffStat
                  additions={fullscreenFile.additions}
                  deletions={fullscreenFile.deletions}
                />
              )
            }
            onClose={() => setFullscreen(null)}
          >
            {fullscreenFile && renderFileDiff(fullscreenFile, true)}
          </DiffFullscreen>
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
