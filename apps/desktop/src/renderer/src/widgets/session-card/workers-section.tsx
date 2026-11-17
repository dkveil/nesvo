import { ChevronRight } from 'lucide-react';
import {
  ProviderGlyph,
  sessionStatusLabel,
  type Session,
} from '@/entities/session';
import { entityKey } from '@/shared/lib/host-key';
import { cardSection } from '@/shared/ui/card-row-styles';
import { ListRow } from '@/shared/ui/list-row';
import { SectionLabel } from '@/shared/ui/section-label';
import { cardRowProps } from './card-row';

type Props = {
  workers: Session[];
  onSession: (key: string) => void;
};

const isWorking = (session: Session) =>
  session.status === 'running' || session.status === 'stopping';

export function WorkersSection({ workers, onSession }: Props) {
  if (workers.length === 0) return null;
  const running = workers.filter(isWorking).length;
  return (
    <section aria-labelledby="session-card-workers" className={cardSection}>
      <SectionLabel as="h2" id="session-card-workers">
        Workers{running > 0 ? ` · ${running} running` : ''}
      </SectionLabel>
      <ul role="list" className="space-y-px">
        {workers.map(worker => (
          <li key={entityKey(worker)}>
            <ListRow
              leading={<ProviderGlyph provider={worker.provider} />}
              title={worker.title}
              trailing={
                <>
                  {sessionStatusLabel(worker)}
                  <ChevronRight className="size-3.5" aria-hidden="true" />
                </>
              }
              mainProps={{
                ...cardRowProps,
                'data-worker-row': '',
                'aria-label': `Open worker ${worker.title}, ${sessionStatusLabel(worker)}`,
              }}
              onClick={() => onSession(entityKey(worker))}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
