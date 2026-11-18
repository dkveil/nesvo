import { useState } from 'react';
import { Square, UsersRound } from 'lucide-react';
import { waitingLabel, type SubsessionOverview } from '@nesvo/contracts';
import type { Session } from '@/entities/session';
import { SubsessionRow } from '@/entities/session/subsession-row';
import { entityKey } from '@/shared/lib/host-key';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/shared/ui/popover';
import { SectionLabel } from '@/shared/ui/section-label';
import { Separator } from '@/shared/ui/separator';

type SubsessionBarProps = {
  overview: SubsessionOverview<Session>;
  connected: boolean;
  stopping: boolean;
  onStopGroup: () => void;
  onStopChild: (session: Session) => void;
  onOpen: (key: string) => void;
};

const ELAPSED_TICK_MS = 1000;

export function SubsessionBar({
  overview,
  connected,
  stopping,
  onStopGroup,
  onStopChild,
  onOpen,
}: SubsessionBarProps) {
  const [open, setOpen] = useState(false);
  const now = useNow(ELAPSED_TICK_MS);
  if (!overview.visible) return null;
  const { entries, running, commands } = overview;
  const label = waitingLabel(running, commands);
  const hasChildren = entries.length > 0;
  return (
    <Popover open={open && hasChildren} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          data-subsession-bar=""
          className="glass-composer flex h-9 min-w-0 items-center gap-1 rounded-overlay border px-1"
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-w-0 flex-1 justify-start"
            aria-haspopup={hasChildren ? 'dialog' : undefined}
            aria-expanded={hasChildren ? open : undefined}
            disabled={!hasChildren}
            onClick={() => setOpen(value => !value)}
          >
            <UsersRound aria-hidden="true" />
            <span className="truncate" aria-live="polite">
              {label}
            </span>
          </Button>
          <Separator orientation="vertical" className="h-4" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={
              hasChildren
                ? 'Stop this session and its workers'
                : 'Stop this session'
            }
            disabled={!connected || stopping}
            onClick={onStopGroup}
          >
            <Square className="fill-current" />
            {stopping ? 'Stopping…' : 'Stop'}
          </Button>
          {hasChildren && (
            <>
              <Separator orientation="vertical" className="h-4" />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="tabular-nums"
                aria-label={`${running} of ${entries.length} workers running, show agents`}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen(value => !value)}
              >
                <UsersRound aria-hidden="true" />
                {running}/{entries.length}
              </Button>
            </>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        size="trigger"
        surface="solid"
        padding="sm"
        scroll
        aria-label="Agents"
      >
        <SectionLabel as="h2">Agents</SectionLabel>
        <ul role="list" className="space-y-px">
          {entries.map(entry => (
            <li key={entityKey(entry.session)}>
              <SubsessionRow
                entry={entry}
                now={now}
                stopDisabled={!connected}
                onOpen={() => {
                  setOpen(false);
                  onOpen(entityKey(entry.session));
                }}
                onStop={() => onStopChild(entry.session)}
              />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
