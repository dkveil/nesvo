import { useState } from 'react';
import { activityLabel, type SubsessionOverview } from '@nesvo/contracts';
import type { Session } from '@/entities/session';
import { SubsessionRow } from '@/entities/session/subsession-row';
import { entityKey } from '@/shared/lib/host-key';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/shared/ui/popover';
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusDot } from '@/shared/ui/status-dot';

type SubsessionBarProps = {
  overview: SubsessionOverview<Session>;
  parentDirectory: string;
  connected: boolean;
  onStopChild: (session: Session) => void;
  onOpen: (key: string) => void;
};

const ELAPSED_TICK_MS = 1000;

export function SubsessionBar({
  overview,
  parentDirectory,
  connected,
  onStopChild,
  onOpen,
}: SubsessionBarProps) {
  const [open, setOpen] = useState(false);
  const now = useNow(ELAPSED_TICK_MS);
  if (!overview.visible) return null;
  const { entries, running, commands } = overview;
  const label = activityLabel(running, commands);
  const hasChildren = entries.length > 0;
  const content = (
    <>
      <StatusDot tone="info" variant="spinner" />
      <span className="truncate tabular-nums" aria-live="polite">
        {label}
      </span>
    </>
  );
  return (
    <Popover open={open && hasChildren} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div data-subsession-bar="" className="flex min-w-0 px-1">
          {hasChildren ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="min-w-0 justify-start font-normal text-muted-foreground"
              aria-label={`${label}, show agents`}
              aria-haspopup="dialog"
              aria-expanded={open}
              onClick={() => setOpen(value => !value)}
            >
              {content}
            </Button>
          ) : (
            <p
              role="status"
              className="flex h-6 min-w-0 items-center gap-1 px-1.5 text-xs text-muted-foreground"
            >
              {content}
            </p>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        size="trigger"
        surface="panel"
        padding="sm"
        scroll
        aria-label="Agents"
      >
        <SectionLabel as="h2" count={entries.length}>
          Agents
        </SectionLabel>
        <ul role="list" className="space-y-px">
          {entries.map(entry => (
            <li key={entityKey(entry.session)}>
              <SubsessionRow
                entry={entry}
                now={now}
                parentDirectory={parentDirectory}
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
