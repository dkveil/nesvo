import { Inbox } from 'lucide-react';
import type { Computer, DesktopSession } from '@nesvo/contracts';
import { elapsedLabel } from '@/entities/activity';
import { ProviderGlyph } from '@/entities/session';
import { entityKey } from '@/shared/lib/host-key';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';
import { ListRow } from '@/shared/ui/list-row';
import { Panel, PanelHeader } from '@/shared/ui/panel';
import { StatusDot, type StatusDotTone } from '@/shared/ui/status-dot';
import {
  orchestrationAnchor,
  type InboxTarget,
  type OrchestrationNode,
} from './orchestration-model';
import { SessionPullRequest } from './session-pull-request';

type TreeActions = {
  onSession: (session: DesktopSession) => void;
  onInbox: (target: InboxTarget) => void;
  onDecisionSession: (key: string) => void;
};

const tones: Record<OrchestrationNode['status'], StatusDotTone> = {
  Running: 'info',
  'Waiting for you': 'warning',
  Queued: 'neutral',
  Done: 'success',
  Failed: 'error',
  Interrupted: 'error',
  'Continue after restart': 'warning',
  Stopped: 'neutral',
  Ready: 'neutral',
};

function TreeNode({
  node,
  now,
  actions,
}: {
  node: OrchestrationNode;
  now: number;
  actions: TreeActions;
}) {
  const { session, wake, status, decision, children, startedAt, finishedAt } =
    node;
  const key = entityKey(session);
  return (
    <li
      id={orchestrationAnchor(key)}
      tabIndex={children.length ? -1 : undefined}
      className="scroll-m-4"
    >
      <ListRow
        data-orchestration-session={session.id}
        className="min-h-8 flex-wrap py-1.5"
        leading={<ProviderGlyph provider={session.provider} />}
        title={<span title={session.title}>{session.title}</span>}
        trailing={
          <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
            <StatusDot
              tone={tones[status]}
              variant={status === 'Running' ? 'spinner' : 'solid'}
            />
            {status}
            <time dateTime={startedAt}>
              {elapsedLabel(startedAt, finishedAt, now)}
            </time>
          </span>
        }
        mainProps={{ 'aria-label': `Open ${session.title}, ${status}` }}
        onClick={() => actions.onSession(session)}
        actionsPlacement="visible"
        actions={
          <>
            {decision && (
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Open ${decision.inbox ? 'Inbox' : 'decision'} for ${session.title}`}
                onClick={() =>
                  decision.inbox
                    ? actions.onInbox(decision.inbox)
                    : actions.onDecisionSession(decision.sessionKey)
                }
              >
                <Inbox /> {decision.inbox ? 'Inbox' : 'Decision'}
              </Button>
            )}
            <SessionPullRequest session={session} />
          </>
        }
      />
      {wake && (
        <p
          className="pl-8 text-xs text-muted-foreground"
          data-orchestration-wake=""
        >
          {wake}
        </p>
      )}
      {children.length > 0 && (
        <ul
          aria-label={`Children of ${session.title}`}
          className="ml-4 border-l border-info-panel-divider pl-2"
        >
          {children.map(child => (
            <TreeNode
              key={entityKey(child.session)}
              node={child}
              now={now}
              actions={actions}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OrchestrationTrees({
  computers,
  trees,
  actions,
}: {
  computers: Computer[];
  trees: OrchestrationNode[];
  actions: TreeActions;
}) {
  const now = useNow(1000);
  const byHost = new Map<string, OrchestrationNode[]>();
  for (const tree of trees) {
    const group = byHost.get(tree.session.hostId) ?? [];
    group.push(tree);
    byHost.set(tree.session.hostId, group);
  }
  return (
    <section aria-label="Ad hoc orchestration" className="space-y-4">
      {[...byHost].map(([hostId, group]) => {
        const computer = computers.find(item => item.id === hostId);
        const name =
          computer?.name ?? (hostId === 'local' ? 'Local' : 'Computer');
        const online = computer?.status === 'connected';
        const lastSync = Date.parse(computer?.lastSyncedAt ?? '');
        return (
          <Panel
            key={hostId}
            aria-label={`${name} orchestration`}
            className="overflow-hidden border-b"
          >
            <PanelHeader
              title="Orchestration"
              meta={online ? name : `${name} · Offline`}
              className="border-info-panel-divider"
            />
            <ul className="divide-y divide-info-panel-divider px-2 py-1">
              {group.map(tree => (
                <TreeNode
                  key={entityKey(tree.session)}
                  node={tree}
                  now={
                    online
                      ? now
                      : lastSync || Date.parse(tree.session.updatedAt)
                  }
                  actions={actions}
                />
              ))}
            </ul>
          </Panel>
        );
      })}
    </section>
  );
}
