import { useEffect, useState } from 'react';
import { ArrowUpRight, FileText, GitCompareArrows } from 'lucide-react';
import type { ChildWorkPage, DesktopApi } from '@nesvo/contracts';
import type { Review } from '@/entities/review';
import { errorDetail, type Session } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { PanelAction } from '@/shared/ui/panel';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { SidePanel, SidePanelHeader } from '@/shared/ui/side-panel';
import { SkeletonList } from '@/shared/ui/skeleton';
import { StatusMessage } from '@/shared/ui/status-message';

export function ChildWorkDrawer({
  coordinator,
  child,
  runId,
  connected,
  api,
  review,
  onClose,
  onOpen,
  onDiff,
}: {
  coordinator: Session;
  child: Session;
  runId: string | null;
  connected: boolean;
  api: Pick<DesktopApi, 'readChildWork'>;
  review?: Review;
  onClose: () => void;
  onOpen: (messageId?: string) => void;
  onDiff: (review: Review) => void;
}) {
  const [view, setView] = useState<ChildWorkPage['view']>('transcript');
  const [page, setPage] = useState<ChildWorkPage | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState('');
  const [paged, setPaged] = useState(false);
  const revision = paged ? 0 : child.revision;
  useEffect(() => {
    if (!connected) return;
    let current = true;
    api
      .readChildWork(
        {
          coordinatorId: coordinator.id,
          sessionId: child.id,
          ...(runId ? { runId } : {}),
          view,
        },
        child.hostId,
      )
      .then(
        result => {
          if (current) {
            setPage(result);
            setError('');
          }
        },
        failure => {
          if (current) setError(errorDetail(failure));
        },
      );
    return () => {
      current = false;
    };
  }, [
    api,
    child.hostId,
    child.id,
    connected,
    coordinator.id,
    revision,
    runId,
    view,
  ]);
  const loadOlder = async () => {
    if (!page?.nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    setError('');
    try {
      const older = await api.readChildWork(
        {
          coordinatorId: coordinator.id,
          sessionId: child.id,
          ...(runId ? { runId } : {}),
          view,
          cursor: page.nextCursor,
        },
        child.hostId,
      );
      setPaged(true);
      setPage(current =>
        current?.snapshot === older.snapshot
          ? {
              ...older,
              items: [...older.items, ...current.items],
              omitted: current.omitted || older.omitted,
              truncated: current.truncated || older.truncated,
            }
          : current,
      );
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setLoadingOlder(false);
    }
  };
  return (
    <SidePanel
      kind="child-work"
      resizeLabel="Resize child work drawer"
      role="dialog"
      aria-label="Child work"
      focusOnOpen
      onEscape={onClose}
    >
      <SidePanelHeader
        icon={FileText}
        title={child.title}
        onClose={onClose}
        closeLabel="Close child work"
      >
        <PanelAction label="Open child session" onClick={() => onOpen()}>
          <ArrowUpRight />
        </PanelAction>
      </SidePanelHeader>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <SegmentedControl
          mode="single"
          label="Child work view"
          options={[
            { value: 'transcript', label: 'Transcript' },
            { value: 'activity', label: 'Activity' },
          ]}
          value={view}
          onChange={value => {
            if (value === 'transcript' || value === 'activity') {
              setPage(null);
              setPaged(false);
              setView(value);
            }
          }}
        />
        {review && (
          <Button size="xs" variant="ghost" onClick={() => onDiff(review)}>
            <GitCompareArrows /> Saved result v{review.version}
          </Button>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {error && <StatusMessage tone="error">{error}</StatusMessage>}
          {!connected ? (
            <StatusMessage tone="warning">
              This computer is offline.
            </StatusMessage>
          ) : !page || page.view !== view ? (
            !error && <SkeletonList label="Loading child work" rows={3} />
          ) : (
            <>
              {page.nextCursor && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={loadingOlder}
                  onClick={() => void loadOlder()}
                >
                  Load earlier
                </Button>
              )}
              {page.items.length === 0 && (
                <StatusMessage>
                  No visible {view === 'activity' ? 'activity' : 'messages'} for
                  this run.
                </StatusMessage>
              )}
              {page.items.map(item => (
                <article
                  key={item.runId + ':' + item.id}
                  className="space-y-1 border-b border-border/60 pb-2"
                >
                  {item.view === 'transcript' ? (
                    <>
                      <Button
                        size="inline"
                        variant="ghost"
                        className="text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => onOpen(item.id)}
                      >
                        {item.actor === 'nesvo'
                          ? 'Nesvo'
                          : item.actor === 'coordinator'
                            ? 'Coordinator'
                            : item.author === 'agent'
                              ? child.provider
                              : 'Operator'}
                      </Button>
                      {item.partial && (
                        <span className="ml-2 text-2xs text-muted-foreground">
                          In progress
                        </span>
                      )}
                      <p className="whitespace-pre-wrap break-words text-ui">
                        {item.body}
                      </p>
                    </>
                  ) : (
                    <p className="flex justify-between gap-2 text-ui">
                      <span>{item.label}</span>
                      <span className="text-xs capitalize text-muted-foreground">
                        {item.status}
                      </span>
                    </p>
                  )}
                </article>
              ))}
              {(page.omitted || page.truncated) && (
                <StatusMessage>
                  Some content was omitted from this preview.
                </StatusMessage>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </SidePanel>
  );
}
