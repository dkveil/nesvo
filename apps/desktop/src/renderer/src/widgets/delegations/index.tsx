import type { DecideDelegationInput } from '@nesvo/contracts';
import { ArrowUpRight, GitBranch } from 'lucide-react';
import {
  delegationStatusLabels,
  modelLabel,
  modeLabels,
  sessionStatusLabel,
  type Session,
} from '@/entities/session';
import { Button } from '@/shared/ui/button';

type Props = {
  session: Session;
  children: Session[];
  enabled: boolean;
  pending: Record<string, boolean>;
  onDecision: (
    delegationId: string,
    decision: DecideDelegationInput['decision'],
  ) => void;
  onSelect: (id: string) => void;
};

export function Delegations({
  session,
  children,
  enabled,
  pending,
  onDecision,
  onSelect,
}: Props) {
  const current = session.delegations.filter(
    delegation => delegation.runId === session.runId,
  );
  const previousChildren = children.filter(
    child =>
      !current.some(delegation => delegation.childSessionId === child.id),
  );
  if (
    !session.delegationEnabled &&
    current.length === 0 &&
    children.length === 0
  )
    return null;
  return (
    <section aria-label="Delegacja" className="space-y-4 border-t pt-5">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <GitBranch className="size-4" />
        Workerzy
      </h2>
      {current.length === 0 && children.length === 0 && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Orkiestrator może zaproponować do dwóch workerów. Każdy rozpocznie
          pracę dopiero po Twojej zgodzie.
        </p>
      )}
      {current.map(delegation => {
        const child = children.find(
          item => item.id === delegation.childSessionId,
        );
        const deciding =
          !!pending[`${session.id}/${delegation.runId}/${delegation.id}`];
        const canDecide =
          enabled &&
          session.status === 'running' &&
          session.runId === delegation.runId &&
          delegation.status === 'pending' &&
          !deciding;
        return (
          <section
            key={delegation.id}
            aria-label="Propozycja workera"
            className="space-y-3 rounded-lg border p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h3 className="text-sm font-medium [overflow-wrap:anywhere]">
                {delegation.title}
              </h3>
              <span className="text-xs text-muted-foreground">
                {child
                  ? sessionStatusLabel(child)
                  : delegationStatusLabels[delegation.status]}
              </span>
            </div>
            <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
              {delegation.task}
            </p>
            <dl className="space-y-2 text-xs">
              <div>
                <dt className="text-muted-foreground">Zakres</dt>
                <dd className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {delegation.scope}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  Katalog względem sesji
                </dt>
                <dd className="mt-1 [overflow-wrap:anywhere]">
                  {delegation.directory}
                </dd>
              </div>
              <div>
                <dt className="sr-only">Provider, model i tryb</dt>
                <dd className="text-muted-foreground [overflow-wrap:anywhere]">
                  {delegation.provider} · {modelLabel(delegation.model)} ·{' '}
                  {modeLabels[delegation.mode]}
                </dd>
              </div>
            </dl>
            {delegation.status === 'pending' && (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={!canDecide}
                    onClick={() => onDecision(delegation.id, 'accept')}
                  >
                    Zatwierdź workera
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!canDecide}
                    onClick={() => onDecision(delegation.id, 'decline')}
                  >
                    Odrzuć propozycję
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {deciding
                    ? 'Przekazywanie decyzji…'
                    : canDecide
                      ? 'Zgoda uruchamia tego workera w pokazanym zakresie i trybie.'
                      : 'Propozycja jest nieaktywna. Sprawdź aktualny stan połączenia i sesji.'}
                </p>
              </>
            )}
            {child && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onSelect(child.id)}
              >
                Otwórz sesję workera
                <ArrowUpRight />
              </Button>
            )}
            {delegation.error && (
              <p
                role="alert"
                className="text-xs leading-relaxed whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]"
              >
                {delegation.error}
              </p>
            )}
          </section>
        );
      })}
      {previousChildren.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Zapisane sesje workerów
          </p>
          {previousChildren.map(child => (
            <Button
              key={child.id}
              type="button"
              variant="ghost"
              className="h-auto w-full justify-between gap-3 px-2 py-2 text-left"
              onClick={() => onSelect(child.id)}
            >
              <span className="min-w-0 truncate text-xs">{child.title}</span>
              <span className="shrink-0 text-xs font-normal text-muted-foreground">
                {sessionStatusLabel(child)}
              </span>
              <ArrowUpRight className="size-3 shrink-0" />
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
