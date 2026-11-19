import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';
import type {
  SessionChangePatch,
  SessionChangeScope,
  SessionChangedFile,
} from '@nesvo/contracts';
import {
  ChevronRight,
  FileDiff,
  GitCompareArrows,
  RefreshCw,
  WrapText,
  X,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { usePanelWidth } from '@/shared/lib/use-panel-width';
import { EmptyState } from '@/shared/ui/empty-state';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { ListRow } from '@/shared/ui/list-row';
import { Panel, PanelAction, PanelHeader, Toolbar } from '@/shared/ui/panel';
import { PanelResizer } from '@/shared/ui/panel-resizer';
import { panelSurface } from '@/shared/ui/panel-styles';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { SkeletonList } from '@/shared/ui/skeleton';
import { StatusMessage } from '@/shared/ui/status-message';
import { Hint } from '@/shared/ui/tooltip';
import { errorDetail, type Session } from '@/entities/session';
import { DiffStat, StatusLetter } from '@/entities/file-change';
import type { AgentCommentTarget } from '@/features/code-comments/agent-target';
import { CodeCommentForm } from '@/features/diff-viewer/code-comment-form';
import { DiffFileView } from '@/features/diff-viewer/diff-file-view';
import { DiffFullscreen } from '@/features/diff-viewer/diff-fullscreen';
import { FullscreenButton } from '@/features/diff-viewer/diff-view-toggles';
import { lineRangeDescription } from '@/features/diff-viewer/line-range';
import {
  codeCommentOf,
  useCommentDraft,
} from '@/features/diff-viewer/use-comment-draft';
import { useDiffWrap } from '@/features/diff-viewer/use-diff-wrap';
import {
  changeSetOf,
  preferredScope,
  useSessionChanges,
  type SessionChangesApi,
} from '@/features/session-changes/use-session-changes';

type PatchState =
  | {
      status: 'ready';
      patch: SessionChangePatch;
      diff: FileDiffMetadata | null;
    }
  | { status: 'error'; error: string };

type SessionChangesPanelProps = {
  session: Session;
  api: SessionChangesApi;
  agentComments: AgentCommentTarget;
  onClose: () => void;
};

const DEFAULT_OPEN_FILES = 5;
const DEFAULT_WIDTH_RATIO = 0.46;
const DEFAULT_MAX_WIDTH_PX = 850;

const defaultPanelWidth = (viewportWidth: number) =>
  Math.min(DEFAULT_MAX_WIDTH_PX, viewportWidth * DEFAULT_WIDTH_RATIO);

const fileName = (path: string) => path.split('/').at(-1) ?? path;

const folderOf = (path: string) => path.split('/').slice(0, -1).join('/');

const scopeLabels: Record<SessionChangeScope, string> = {
  uncommitted: 'Uncommitted',
  branch: 'Branch',
};

const parsePatch = (patch: SessionChangePatch, cacheKey: string) => {
  if (patch.status !== 'text' || !patch.patch) return null;
  try {
    return (
      parsePatchFiles(patch.patch, {
        cacheKeyPrefix: cacheKey,
        throwOnError: true,
      }).flatMap(parsed => parsed.files)[0] ?? null
    );
  } catch {
    return null;
  }
};

const isInsideLayer = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest('[role="dialog"]');

export default function SessionChangesPanel({
  session,
  api,
  agentComments,
  onClose,
}: SessionChangesPanelProps) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useEffectEvent(onClose);
  const {
    attach: attachPanel,
    style: panelStyle,
    resizer,
  } = usePanelWidth('changes', defaultPanelWidth);
  const { changes, loading, error, refresh } = useSessionChanges(session, api);
  const [chosenScope, setScope] = useState<SessionChangeScope | null>(null);
  const scope = chosenScope ?? preferredScope(changes);
  const set = changeSetOf(changes, scope);
  const files = useMemo(() => set?.files ?? [], [set]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [patches, setPatches] = useState<Record<string, PatchState>>({});
  const [fullscreen, setFullscreen] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [wrap, setWrap] = useDiffWrap();
  const comments = useCommentDraft();
  const readAt = changes?.readAt ?? '';
  const patchKey = (path: string) => `${scope}\u0000${path}\u0000${readAt}`;
  const isOpen = (file: SessionChangedFile, index: number) =>
    expanded[`${scope}:${file.path}`] ?? index < DEFAULT_OPEN_FILES;
  const wanted = files.filter(
    (file, index) => isOpen(file, index) || fullscreen === file.path,
  );
  const missing = wanted.filter(file => !patches[patchKey(file.path)]);
  const requested = useRef(new Set<string>());
  const fetchPatches = useEffectEvent(() => {
    for (const file of missing) {
      const key = patchKey(file.path);
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      api
        .readSessionChangePatch({
          sessionId: session.id,
          scope,
          path: file.path,
          previousPath: file.previousPath,
        })
        .then(
          patch =>
            setPatches(previous => ({
              ...previous,
              [key]: { status: 'ready', patch, diff: parsePatch(patch, key) },
            })),
          (failure: unknown) =>
            setPatches(previous => ({
              ...previous,
              [key]: {
                status: 'error',
                error: `This change could not be read. ${errorDetail(failure)}`,
              },
            })),
        );
    }
  });
  const missingKey = missing.map(file => file.path).join('\u0000');
  useEffect(() => {
    if (missingKey) fetchPatches();
  }, [missingKey, scope, readAt]);
  useEffect(() => {
    closeButton.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !isInsideLayer(event.target)
      ) {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  const toggle = (file: SessionChangedFile, index: number) =>
    setExpanded(previous => ({
      ...previous,
      [`${scope}:${file.path}`]: !isOpen(file, index),
    }));
  const renderDiff = (file: SessionChangedFile, inFullscreen: boolean) => {
    const state = patches[patchKey(file.path)];
    if (!state)
      return (
        <SkeletonList
          label={`Loading changes in ${file.path}`}
          rows={3}
          className="px-2 py-2"
        />
      );
    if (state.status === 'error')
      return (
        <StatusMessage tone="error" className="px-4 py-3">
          {state.error}
        </StatusMessage>
      );
    const { patch, diff } = state;
    if (patch.status === 'binary')
      return (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          {patch.detail ?? 'Binary file. No text diff to show.'}
        </p>
      );
    if (patch.status === 'unchanged' || !diff)
      return (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          No text lines changed in this scope.
        </p>
      );
    const showDraft =
      comments.draft?.path === file.path &&
      (fullscreen === file.path) === inFullscreen;
    return (
      <>
        {patch.truncated && (
          <InlineNotice className="m-2">
            This diff is too large to show in full.
          </InlineNotice>
        )}
        <DiffFileView
          diff={diff}
          patch={patch.patch}
          wrap={wrap}
          commentable={!agentComments.blockedReason}
          draft={showDraft ? comments.draft!.range : null}
          onDraftRange={range => {
            comments.open(file.path, range);
            setNotice('');
          }}
          renderDraft={() =>
            comments.draft && (
              <CodeCommentForm
                location={`${comments.draft.path} ${lineRangeDescription(comments.draft.range)}`}
                value={comments.draft.body}
                targets={[
                  {
                    value: 'agent',
                    label: 'Send to agent',
                    blockedReason: agentComments.blockedReason,
                  },
                ]}
                target="agent"
                onChange={comments.edit}
                onTargetChange={() => undefined}
                onSubmit={() => {
                  if (!comments.draft) return;
                  if (agentComments.add(codeCommentOf(comments.draft, diff))) {
                    comments.close();
                    setNotice('Added to the session composer.');
                  } else
                    setNotice('The composer already holds 20 code comments.');
                }}
                onCancel={comments.close}
              />
            )
          }
        />
      </>
    );
  };
  const fullscreenFile = files.find(file => file.path === fullscreen);
  return (
    <Panel
      role="region"
      aria-label="Session changes"
      ref={attachPanel}
      style={panelStyle}
      className={panelSurface}
    >
      <PanelResizer label="Resize changes panel" {...resizer} />
      <PanelHeader
        titleBar
        icon={GitCompareArrows}
        title="Changes"
        meta={
          set?.status === 'available' &&
          (scope === 'branch' && set.base
            ? `Compared with ${set.base}`
            : 'Uncommitted')
        }
      >
        <PanelAction
          label="Refresh changes"
          disabled={loading}
          onClick={refresh}
        >
          <RefreshCw className={cn(loading && 'animate-spin')} />
        </PanelAction>
        <PanelAction
          label="Wrap diff lines"
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
        >
          <WrapText />
        </PanelAction>
        <PanelAction ref={closeButton} label="Close changes" onClick={onClose}>
          <X className="size-4" />
        </PanelAction>
      </PanelHeader>
      <Toolbar label="Change scope" className="gap-2 px-2">
        <SegmentedControl
          label="Compare with"
          size="sm"
          options={(['uncommitted', 'branch'] as const).map(value => ({
            value,
            label: scopeLabels[value],
            count:
              changes?.[value].status === 'available'
                ? changes[value].files.length
                : undefined,
            tooltip:
              value === 'uncommitted'
                ? 'Working tree changes since the last commit'
                : changes?.branch.base
                  ? `All changes since this branch left ${changes.branch.base}`
                  : 'All changes since this branch left the default branch',
          }))}
          value={scope}
          onChange={next => {
            setScope(next);
            comments.close();
          }}
        />
        {set?.status === 'available' && (
          <DiffStat
            additions={set.additions}
            deletions={set.deletions}
            className="ml-auto pr-1"
          />
        )}
      </Toolbar>
      {error && (
        <StatusMessage tone="error" className="shrink-0 border-b px-3 py-1.5">
          {error}
        </StatusMessage>
      )}
      {set?.truncated && (
        <StatusMessage tone="warning" className="shrink-0 border-b px-3 py-1.5">
          Some changes are not listed.
        </StatusMessage>
      )}
      {notice && (
        <StatusMessage
          tone="success"
          role="status"
          className="shrink-0 border-b px-3 py-1.5"
        >
          {notice}
        </StatusMessage>
      )}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {!changes ? (
          loading && (
            <SkeletonList
              label="Loading changes"
              rows={6}
              className="px-1 py-2"
            />
          )
        ) : set?.status === 'unavailable' ? (
          <EmptyState
            size="sm"
            icon={FileDiff}
            title="Changes are unavailable"
            description={set.detail}
          />
        ) : files.length === 0 ? (
          <EmptyState
            size="sm"
            icon={FileDiff}
            title={
              scope === 'uncommitted'
                ? 'No uncommitted changes.'
                : 'No changes on this branch.'
            }
          />
        ) : (
          files.map((file, index) => {
            const open = isOpen(file, index);
            const folder = folderOf(file.path);
            return (
              <section
                key={`${scope}:${file.path}`}
                aria-label={`Changes in ${file.path}`}
                className="border-b"
              >
                <header className="sticky top-0 z-[1] flex h-9 items-center gap-1 border-b bg-background pr-1.5 pl-1">
                  <Hint
                    label={
                      file.previousPath
                        ? `${file.previousPath} → ${file.path}`
                        : file.path
                    }
                  >
                    <ListRow
                      onClick={() => toggle(file, index)}
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
                        </>
                      }
                      trailing={
                        file.additions == null || file.deletions == null ? (
                          'Binary'
                        ) : (
                          <DiffStat
                            additions={file.additions}
                            deletions={file.deletions}
                          />
                        )
                      }
                      className="min-w-0 flex-1"
                    />
                  </Hint>
                  <FullscreenButton
                    path={file.path}
                    onOpen={() => setFullscreen(file.path)}
                  />
                </header>
                {open && fullscreen !== file.path && (
                  <div className="animate-in bg-code-background duration-base ease-out fade-in-0">
                    {renderDiff(file, false)}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>
      <DiffFullscreen
        path={fullscreenFile ? fullscreenFile.path : null}
        meta={
          fullscreenFile?.additions != null &&
          fullscreenFile.deletions != null && (
            <DiffStat
              additions={fullscreenFile.additions}
              deletions={fullscreenFile.deletions}
            />
          )
        }
        onClose={() => setFullscreen(null)}
      >
        {fullscreenFile && renderDiff(fullscreenFile, true)}
      </DiffFullscreen>
    </Panel>
  );
}
