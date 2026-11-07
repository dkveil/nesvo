import { useEffect, useRef } from 'react';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import {
  fileKindLabels,
  reviewDate,
  reviewPreview,
  reviewStatusLabels,
  type Review,
} from '@/entities/review';
import { modelLabel, roleLabels } from '@/entities/session';
import {
  ReviewDecision,
  type ReviewDecisionProps,
} from '@/features/review-decision';
import { Button } from '@/shared/ui/button';

type Props = ReviewDecisionProps & {
  reviews: Review[];
  allReviews: Review[];
  focusedId: string;
  onSession: (sessionId: string, targetId?: string) => void;
};

type VersionProps = ReviewDecisionProps & {
  review: Review;
  allReviews: Review[];
  focused: boolean;
  onSession: (sessionId: string, targetId?: string) => void;
};

function ReviewVersion({
  review,
  allReviews,
  focused,
  onSession,
  ...decisionProps
}: VersionProps) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (focused && disclosure.current) disclosure.current.open = true;
  }, [focused]);
  return (
    <details
      ref={disclosure}
      id={`review-${review.id}`}
      role="region"
      aria-label={`Wynik sesji: wersja ${review.version}`}
      className="group/review border-b border-border/70 last:border-b-0"
    >
      <summary
        aria-label={`Otwórz wersję ${review.version}`}
        className="cursor-pointer list-none py-4 text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
      >
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">Wersja {review.version}</span>
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <span>{reviewStatusLabels[review.status]}</span>
            <ChevronDown className="size-3.5 transition-transform group-open/review:rotate-180" />
          </span>
        </span>
        <span className="mt-2 block text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {reviewPreview(review)}
        </span>
      </summary>
      <div className="space-y-5 pb-5">
        <header className="space-y-2">
          <h3 className="text-sm font-medium [overflow-wrap:anywhere]">
            {review.title}
          </h3>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {roleLabels[review.role]} · {review.provider} ·{' '}
            {modelLabel(review.model)} ·{' '}
            <time dateTime={review.createdAt}>
              {reviewDate(review.createdAt)}
            </time>
          </p>
        </header>
        <section className="space-y-2">
          <h4 className="text-xs font-medium">Zadanie</h4>
          <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
            {review.task}
          </p>
          {review.scope && (
            <p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              Zakres: {review.scope}
            </p>
          )}
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            Katalog pracy: {review.directory}
          </p>
        </section>
        <section aria-label="Podsumowanie wyniku" className="space-y-2">
          <h4 className="text-xs font-medium">Podsumowanie</h4>
          <p className="text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {review.summary || 'Brak podsumowania.'}
          </p>
        </section>
        <section aria-label="Zmiany w plikach" className="space-y-3">
          <h4 className="text-xs font-medium">Zmiany w plikach</h4>
          {review.diff.status !== 'not-applicable' && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Porównanie początku i końca tej tury. Wcześniejsze zmiany
              znajdziesz w poprzednich wersjach wyniku. Edycje wykonane
              równolegle poza sesją również mogą pojawić się w porównaniu.
            </p>
          )}
          {review.diff.status === 'not-applicable' ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {review.diff.detail ??
                'Wynik analizy nie obejmuje zmian w plikach. Możesz odebrać podsumowanie.'}
            </p>
          ) : review.diff.status === 'unavailable' ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {review.diff.detail ??
                'Nie można odtworzyć pełnego porównania zmian. Ten wynik wymaga poprawy przed akceptacją.'}
            </p>
          ) : (
            <>
              {review.diff.detail && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {review.diff.detail}
                </p>
              )}
              {review.diff.files.length > 0 ? (
                <ul className="max-h-48 divide-y overflow-auto border-y">
                  {review.diff.files.map(file => (
                    <li
                      key={file.path}
                      className="flex items-start justify-between gap-3 py-2 text-xs"
                    >
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        {file.path}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {fileKindLabels[file.kind]}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Nie zapisano zmian w plikach.
                </p>
              )}
              {review.diff.patch && (
                <pre
                  aria-label="Zapisany diff"
                  className="max-h-[32rem] overflow-auto rounded-lg border bg-card p-3 text-xs leading-6"
                >
                  <code>{review.diff.patch}</code>
                </pre>
              )}
            </>
          )}
        </section>
        {review.dependencies.length > 0 && (
          <section className="space-y-2">
            <h4 className="text-xs font-medium">Wyniki workerów</h4>
            <div className="flex flex-wrap gap-2">
              {review.dependencies.map(dependency => {
                const source = allReviews.find(
                  item => item.id === dependency.reviewId,
                );
                return (
                  <Button
                    key={dependency.reviewId}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-auto min-w-0 py-1.5 whitespace-normal [overflow-wrap:anywhere]"
                    onClick={() =>
                      onSession(
                        dependency.sessionId,
                        `review-${dependency.reviewId}`,
                      )
                    }
                  >
                    {source?.title ?? 'Wynik workera'} · wersja{' '}
                    {dependency.version}
                    <ArrowUpRight className="size-3 shrink-0" />
                  </Button>
                );
              })}
            </div>
          </section>
        )}
        {review.decision && (
          <section
            aria-label="Zapisana decyzja"
            className="space-y-2 border-t pt-4"
          >
            <h4 className="text-xs font-medium">Decyzja operatora</h4>
            <p className="text-sm">
              {review.decision.decision === 'accept'
                ? 'Zaakceptowano tę wersję.'
                : 'Odesłano tę wersję do poprawy.'}
            </p>
            <time
              className="text-xs text-muted-foreground"
              dateTime={review.decision.at}
            >
              {reviewDate(review.decision.at)}
            </time>
            {review.decision.feedback && (
              <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                {review.decision.feedback}
              </p>
            )}
          </section>
        )}
        {(review.status === 'pending' ||
          decisionProps.feedbacks[review.id] ||
          decisionProps.decisionErrors[review.id]) && (
          <ReviewDecision review={review} {...decisionProps} />
        )}
      </div>
    </details>
  );
}

export function SessionReviews({
  reviews,
  allReviews,
  focusedId,
  onSession,
  ...decisionProps
}: Props) {
  if (reviews.length === 0) return null;
  const versions = [...reviews].sort(
    (left, right) =>
      right.version - left.version ||
      right.createdAt.localeCompare(left.createdAt),
  );
  return (
    <section aria-label="Wyniki sesji" className="space-y-2 border-t pt-5">
      <h2 className="text-sm font-medium">Wyniki sesji</h2>
      <div>
        {versions.map(review => (
          <ReviewVersion
            key={review.id}
            review={review}
            allReviews={allReviews}
            focused={review.id === focusedId}
            onSession={onSession}
            {...decisionProps}
          />
        ))}
      </div>
    </section>
  );
}
