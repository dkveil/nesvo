import type { SubsessionEntry } from '@nesvo/contracts';
import type { Session } from '@/entities/session';
import { SubsessionRow } from '@/entities/session/subsession-row';
import { entityKey } from '@/shared/lib/host-key';
import { useNow } from '@/shared/lib/use-now';
import { cardSection } from '@/shared/ui/card-row-styles';
import { SectionLabel } from '@/shared/ui/section-label';
import { cardRowProps } from './card-row';

type SubsessionsSectionProps = {
  entries: SubsessionEntry<Session>[];
  connected: boolean;
  onSession: (key: string) => void;
  onStop: (session: Session) => void;
};

const ELAPSED_TICK_MS = 1000;

export function SubsessionsSection({
  entries,
  connected,
  onSession,
  onStop,
}: SubsessionsSectionProps) {
  const now = useNow(ELAPSED_TICK_MS);
  if (entries.length === 0) return null;
  const running = entries.filter(entry => entry.active).length;
  return (
    <section aria-labelledby="session-card-subsessions" className={cardSection}>
      <SectionLabel as="h2" id="session-card-subsessions">
        Subsessions{running > 0 ? ` · ${running} running` : ''}
      </SectionLabel>
      <ul role="list" className="space-y-px">
        {entries.map(entry => (
          <li key={entityKey(entry.session)}>
            <SubsessionRow
              entry={entry}
              now={now}
              stopDisabled={!connected}
              mainProps={cardRowProps}
              onOpen={() => onSession(entityKey(entry.session))}
              onStop={() => onStop(entry.session)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
