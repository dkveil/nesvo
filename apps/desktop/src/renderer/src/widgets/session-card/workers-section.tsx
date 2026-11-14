import { ChevronRight } from 'lucide-react';
import {
  ProviderGlyph,
  sessionStatusLabel,
  type Session,
} from '@/entities/session';
import { entityKey } from '@/shared/lib/host-key';
import {
  cardRowAction,
  cardSection,
  cardSectionHeader,
  cardValue,
} from '@/shared/ui/card-row-styles';

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
      <div className={cardSectionHeader}>
        <h2 id="session-card-workers" className="font-normal">
          Workers{running > 0 ? ` · ${running} running` : ''}
        </h2>
      </div>
      <ul role="list" className="space-y-px">
        {workers.map(worker => (
          <li key={entityKey(worker)}>
            <button
              type="button"
              data-card-row
              data-worker-row
              aria-label={`Open worker ${worker.title}, ${sessionStatusLabel(worker)}`}
              onClick={() => onSession(entityKey(worker))}
              className={cardRowAction}
            >
              <ProviderGlyph provider={worker.provider} className="mx-px" />
              <span className="min-w-0 flex-1 truncate">{worker.title}</span>
              <span className={cardValue}>{sessionStatusLabel(worker)}</span>
              <ChevronRight
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
