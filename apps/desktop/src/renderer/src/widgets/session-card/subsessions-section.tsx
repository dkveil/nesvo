import { useState } from 'react';
import { ChevronRight, Ellipsis, History, Square } from 'lucide-react';
import type { SubsessionEntry } from '@nesvo/contracts';
import type { Session } from '@/entities/session';
import { SubsessionRow } from '@/entities/session/subsession-row';
import { cn } from '@/shared/lib/cn';
import { entityKey } from '@/shared/lib/host-key';
import { useNow } from '@/shared/lib/use-now';
import { cardSection } from '@/shared/ui/card-row-styles';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { IconButton } from '@/shared/ui/icon-button';
import { ListRow } from '@/shared/ui/list-row';
import { SectionLabel } from '@/shared/ui/section-label';
import { cardRowProps } from './card-row';

type SubsessionsSectionProps = {
  entries: SubsessionEntry<Session>[];
  parentDirectory: string;
  connected: boolean;
  onSession: (key: string) => void;
  onStop: (session: Session) => void;
};

const ELAPSED_TICK_MS = 1000;

const PREVIOUS_LIST_ID = 'session-card-previous-subsessions';

export function SubsessionsSection({
  entries,
  parentDirectory,
  connected,
  onSession,
  onStop,
}: SubsessionsSectionProps) {
  const [showPrevious, setShowPrevious] = useState(false);
  const now = useNow(ELAPSED_TICK_MS);
  if (entries.length === 0) return null;
  const running = entries.filter(entry => entry.active);
  const previous = entries.filter(entry => !entry.active);
  const row = (entry: SubsessionEntry<Session>) => (
    <li key={entityKey(entry.session)}>
      <SubsessionRow
        entry={entry}
        now={now}
        density="compact"
        parentDirectory={parentDirectory}
        mainProps={cardRowProps}
        onOpen={() => onSession(entityKey(entry.session))}
      />
    </li>
  );
  return (
    <section aria-labelledby="session-card-subsessions" className={cardSection}>
      <SectionLabel
        as="h2"
        action={
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <IconButton size={20} label="Subsession actions">
                <Ellipsis aria-hidden="true" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuCheckboxItem
                checked={showPrevious}
                disabled={previous.length === 0}
                onCheckedChange={setShowPrevious}
              >
                Show previous
              </DropdownMenuCheckboxItem>
              <DropdownMenuItem
                disabled={!connected || running.length === 0}
                onSelect={() => running.forEach(entry => onStop(entry.session))}
              >
                <Square />
                Stop running subsessions
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      >
        <span id="session-card-subsessions">
          Subsessions{running.length > 0 ? ` · ${running.length} running` : ''}
        </span>
      </SectionLabel>
      <ul role="list" className="space-y-px">
        {running.map(row)}
        {previous.length > 0 && (
          <li>
            <ListRow
              leading={<History />}
              title={<span className="text-muted-foreground">Previous</span>}
              trailing={
                <>
                  {previous.length}
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      'size-3.5 transition-transform duration-base ease-out',
                      showPrevious && 'rotate-90',
                    )}
                  />
                </>
              }
              aria-expanded={showPrevious}
              aria-controls={PREVIOUS_LIST_ID}
              mainProps={{
                ...cardRowProps,
                'aria-label': `Previous subsessions, ${previous.length}`,
              }}
              onClick={() => setShowPrevious(value => !value)}
            />
          </li>
        )}
      </ul>
      {previous.length > 0 && (
        <ul
          id={PREVIOUS_LIST_ID}
          role="list"
          hidden={!showPrevious}
          className="space-y-px"
        >
          {previous.map(row)}
        </ul>
      )}
    </section>
  );
}
