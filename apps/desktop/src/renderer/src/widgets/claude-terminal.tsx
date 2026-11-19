import { useEffect, useRef } from 'react';
import { SquareTerminal, X } from 'lucide-react';
import type { Session } from '@/entities/session';
import { MiddleTruncatedText } from '@/shared/ui/middle-truncated-text';
import { Panel, PanelAction, PanelBody, PanelHeader } from '@/shared/ui/panel';
import { StatusMessage } from '@/shared/ui/status-message';

export function ClaudeTerminal({
  session,
  connected,
  onClose,
}: {
  session: Session;
  connected: boolean;
  onClose: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const items = session.activities.filter(item => item.kind !== 'thinking');
  useEffect(() => {
    const node = viewport.current;
    if (node && follow.current) node.scrollTop = node.scrollHeight;
  }, [session.activities]);
  const live = session.status === 'running' || session.status === 'stopping';
  return (
    <Panel
      aria-label="Claude terminal"
      className="w-full border-l min-[1200px]:w-[min(42%,36rem)]"
    >
      <PanelHeader
        icon={SquareTerminal}
        title="Claude terminal"
        meta={connected ? (live ? 'Live · Read-only' : 'Read-only') : 'Offline'}
      >
        <PanelAction label="Close Claude terminal" onClick={onClose}>
          <X />
        </PanelAction>
      </PanelHeader>
      <PanelBody
        ref={viewport}
        onScroll={event => {
          const node = event.currentTarget;
          follow.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 32;
        }}
        className="space-y-3 px-3 py-4 font-mono text-xs"
      >
        {!items.length && (
          <StatusMessage tone="info">
            Tool calls and output appear here as Claude works.
          </StatusMessage>
        )}
        {session.activityTruncatedRunIds.length > 0 && (
          <StatusMessage tone="info">
            Some activity was truncated.
          </StatusMessage>
        )}
        {items.map(item => (
          <div key={item.runId + '/' + item.id} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-muted-foreground">
              <span>{item.title}</span>
              <span>{item.status}</span>
            </div>
            {item.detail && (
              <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {item.kind === 'command' ? '$ ' : ''}
                {item.kind === 'command'
                  ? item.detail
                  : item.detail
                      .split('\n')
                      .map((line, index) =>
                        item.paths.includes(line) ? (
                          <MiddleTruncatedText key={index} value={line} />
                        ) : (
                          <div key={index}>{line}</div>
                        ),
                      )}
              </div>
            )}
            {item.output && (
              <pre className="rounded-surface bg-code-background p-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {item.kind === 'file-change'
                  ? item.output.split('\n').map((line, index) => (
                      <span
                        key={index}
                        className={
                          line.startsWith('+')
                            ? 'text-success-foreground'
                            : line.startsWith('-')
                              ? 'text-error-foreground'
                              : undefined
                        }
                      >
                        {line}
                        {'\n'}
                      </span>
                    ))
                  : item.output}
              </pre>
            )}
            {item.truncated && (
              <span className="text-muted-foreground">Output truncated</span>
            )}
          </div>
        ))}
      </PanelBody>
    </Panel>
  );
}
