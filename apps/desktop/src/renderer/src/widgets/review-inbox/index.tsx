import { useState } from 'react';
import { ArrowLeft, ArrowUpRight, Inbox } from 'lucide-react';
import {
  fileKindLabels,
  reviewDate,
  reviewStatusLabels,
  type DecideReviewInput,
  type Review,
} from '@/entities/review';
import { modelLabel, roleLabels } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Label } from '@/shared/ui/label';
import { ScrollArea } from '@/shared/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { Textarea } from '@/shared/ui/textarea';

type Props = {
  reviews: Review[];
  loading: boolean;
  error: string;
  selectedId: string;
  blockedReason: string;
  pending: Record<string, boolean>;
  decisionErrors: Record<string, string>;
  feedbacks: Record<string, string>;
  onFeedback: (reviewId: string, value: string) => void;
  onSelect: (id: string) => void;
  onSession: (id: string) => void;
  onRefresh: () => void;
  onDecision: (
    review: Review,
    decision: DecideReviewInput['decision'],
    feedback: string,
  ) => void;
};

type Filter = 'pending' | 'history' | 'all';

export function ReviewInbox({
  reviews,
  loading,
  error,
  selectedId,
  blockedReason,
  pending,
  decisionErrors,
  feedbacks,
  onFeedback,
  onSelect,
  onSession,
  onRefresh,
  onDecision,
}: Props) {
  const [filter, setFilter] = useState<Filter>('pending');
  const selected = reviews.find(review => review.id === selectedId);
  const visible = reviews.filter(
    review =>
      filter === 'all' ||
      (filter === 'pending'
        ? review.status === 'pending'
        : review.status !== 'pending'),
  );
  const versions = selected
    ? reviews
        .filter(review => review.sessionId === selected.sessionId)
        .sort((left, right) => right.version - left.version)
    : [];
  const feedback = selected ? (feedbacks[selected.id] ?? '') : '';
  const deciding = selected ? !!pending[selected.id] : false;
  const reason =
    selected?.status !== 'pending'
      ? 'Ta wersja nie oczekuje na decyzję.'
      : blockedReason;
  const unavailable = selected?.diff.status === 'unavailable';
  return (
    <ScrollArea className="min-h-0 min-w-0 flex-1">
      <section
        aria-label="Skrzynka odbioru"
        className="mx-auto max-w-4xl space-y-6 p-5 lg:p-8"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          {selected ? (
            <Button variant="ghost" size="sm" onClick={() => onSelect('')}>
              <ArrowLeft />
              Wróć do listy wyników
            </Button>
          ) : (
            <h2 className="text-sm font-medium">Wyniki sesji</h2>
          )}
          <div className="flex items-center gap-2">
            <Label
              htmlFor="review-filter"
              className="text-xs text-muted-foreground"
            >
              Wyniki
            </Label>
            <Select
              value={filter}
              onValueChange={value => {
                if (
                  value === 'pending' ||
                  value === 'history' ||
                  value === 'all'
                ) {
                  setFilter(value);
                  onSelect('');
                }
              }}
            >
              <SelectTrigger id="review-filter" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Do odbioru</SelectItem>
                <SelectItem value="history">Historia</SelectItem>
                <SelectItem value="all">Wszystkie</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {error && (
          <div className="space-y-2">
            <p
              role="alert"
              className="text-sm leading-relaxed text-destructive [overflow-wrap:anywhere]"
            >
              {error}
            </p>
            <Button size="sm" variant="outline" onClick={onRefresh}>
              Odśwież wyniki
            </Button>
          </div>
        )}
        {!selected ? (
          <>
            {loading && (
              <p role="status" className="text-sm text-muted-foreground">
                Wczytywanie wyników…
              </p>
            )}
            {visible.length > 0 ? (
              <div className="divide-y border-y">
                {visible.map(review => (
                  <button
                    key={review.id}
                    type="button"
                    aria-label={`Otwórz wynik: ${review.title}, wersja ${review.version}`}
                    onClick={() => onSelect(review.id)}
                    className="flex w-full items-start justify-between gap-4 px-2 py-5 text-left transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <div className="min-w-0 space-y-2">
                      <h3 className="text-sm font-medium [overflow-wrap:anywhere]">
                        {review.title}
                      </h3>
                      <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                        {review.summary}
                      </p>
                      <p className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          {roleLabels[review.role]} · {review.provider}
                        </span>
                        <span>Wersja {review.version}</span>
                        <span>{reviewStatusLabels[review.status]}</span>
                        <time dateTime={review.createdAt}>
                          {reviewDate(review.createdAt)}
                        </time>
                      </p>
                    </div>
                    <ArrowUpRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            ) : (
              !loading &&
              !error && (
                <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
                  <Inbox className="size-7 text-muted-foreground" />
                  <h3 className="text-lg font-medium">
                    {filter === 'pending'
                      ? 'Brak wyników do odbioru'
                      : 'Brak wyników w historii'}
                  </h3>
                  <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                    {filter === 'pending'
                      ? 'Ukończone odpowiedzi pojawią się tutaj. Wcześniejsze decyzje znajdziesz w historii.'
                      : 'Zapisane wyniki i decyzje będą dostępne po ukończeniu sesji.'}
                  </p>
                </div>
              )
            )}
          </>
        ) : (
          <section aria-label="Wynik do odbioru" className="space-y-6">
            <header className="space-y-3">
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span>Wersja {selected.version}</span>
                <span role="status">{reviewStatusLabels[selected.status]}</span>
                <time dateTime={selected.createdAt}>
                  {reviewDate(selected.createdAt)}
                </time>
              </div>
              <h2 className="text-xl font-semibold [overflow-wrap:anywhere]">
                {selected.title}
              </h2>
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                Autor: {roleLabels[selected.role]} · {selected.provider} ·{' '}
                {modelLabel(selected.model)}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSession(selected.sessionId)}
              >
                Przejdź do sesji
                <ArrowUpRight />
              </Button>
            </header>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Zadanie</h3>
              <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                {selected.task}
              </p>
              {selected.scope && (
                <p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                  Zakres: {selected.scope}
                </p>
              )}
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                Katalog pracy: {selected.directory}
              </p>
            </section>
            <section
              aria-label="Podsumowanie wyniku"
              className="space-y-2 border-t pt-5"
            >
              <h3 className="text-sm font-medium">Podsumowanie</h3>
              <p className="text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
                {selected.summary || 'Brak podsumowania.'}
              </p>
            </section>
            <section
              aria-label="Zmiany w plikach"
              className="space-y-3 border-t pt-5"
            >
              <h3 className="text-sm font-medium">Zmiany w plikach</h3>
              {selected.diff.status !== 'not-applicable' && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Porównanie początku i końca tej tury. Wcześniejsze zmiany
                  znajdziesz w poprzednich wersjach wyniku. Edycje wykonane
                  równolegle poza sesją również mogą pojawić się w porównaniu.
                </p>
              )}
              {selected.diff.status === 'not-applicable' ? (
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {selected.diff.detail ??
                    'Wynik analizy nie obejmuje zmian w plikach. Możesz odebrać podsumowanie.'}
                </p>
              ) : selected.diff.status === 'unavailable' ? (
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {selected.diff.detail ??
                    'Nie można odtworzyć pełnego porównania zmian. Ten wynik wymaga poprawy przed akceptacją.'}
                </p>
              ) : (
                <>
                  {selected.diff.detail && (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {selected.diff.detail}
                    </p>
                  )}
                  {selected.diff.files.length > 0 ? (
                    <ul className="divide-y rounded-md border px-3">
                      {selected.diff.files.map(file => (
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
                    <p className="text-sm text-muted-foreground">
                      Nie zapisano zmian w plikach.
                    </p>
                  )}
                  {selected.diff.patch && (
                    <pre
                      aria-label="Zapisany diff"
                      className="max-h-[32rem] overflow-auto rounded-lg border bg-muted/20 p-4 text-xs leading-6"
                    >
                      <code>{selected.diff.patch}</code>
                    </pre>
                  )}
                </>
              )}
            </section>
            {selected.dependencies.length > 0 && (
              <section className="space-y-2 border-t pt-5">
                <h3 className="text-sm font-medium">Wyniki workerów</h3>
                <div className="flex flex-wrap gap-2">
                  {selected.dependencies.map(dependency => {
                    const source = reviews.find(
                      review => review.id === dependency.reviewId,
                    );
                    return (
                      <Button
                        key={dependency.reviewId}
                        variant="outline"
                        size="sm"
                        disabled={!source}
                        onClick={() => onSelect(dependency.reviewId)}
                      >
                        {source?.title ?? 'Wynik workera'} · wersja{' '}
                        {dependency.version}
                      </Button>
                    );
                  })}
                </div>
              </section>
            )}
            <section
              aria-label="Decyzja operatora"
              className="space-y-4 border-t pt-5"
            >
              <h3 className="text-sm font-medium">Decyzja operatora</h3>
              {selected.decision && (
                <div className="space-y-2">
                  <p className="text-sm">
                    {selected.decision.decision === 'accept'
                      ? 'Zaakceptowano tę wersję.'
                      : 'Odesłano tę wersję do poprawy.'}
                  </p>
                  <time
                    className="text-xs text-muted-foreground"
                    dateTime={selected.decision.at}
                  >
                    {reviewDate(selected.decision.at)}
                  </time>
                  {selected.decision.feedback && (
                    <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {selected.decision.feedback}
                    </p>
                  )}
                </div>
              )}
              <form
                className="space-y-3"
                onSubmit={event => {
                  event.preventDefault();
                  if (!reason && !deciding && feedback.trim())
                    onDecision(selected, 'request-changes', feedback.trim());
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor={`review-feedback-${selected.id}`}>
                    Uwagi do poprawy
                  </Label>
                  <Textarea
                    id={`review-feedback-${selected.id}`}
                    placeholder="Opisz, co wymaga poprawy…"
                    value={feedback}
                    onChange={event =>
                      onFeedback(selected.id, event.target.value)
                    }
                    maxLength={8000}
                    required
                    aria-describedby="review-feedback-help"
                    className="min-h-24"
                  />
                  <p
                    id="review-feedback-help"
                    className="text-xs text-muted-foreground"
                  >
                    Uwagi są wymagane przy odesłaniu do poprawy. Wysłanie
                    uruchomi pracę w tej samej sesji.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={!!reason || deciding || unavailable}
                    onClick={() => onDecision(selected, 'accept', '')}
                  >
                    Zaakceptuj wynik
                  </Button>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={!!reason || deciding || !feedback.trim()}
                  >
                    Odeślij do poprawy
                  </Button>
                </div>
              </form>
              {deciding && (
                <p role="status" className="text-xs text-muted-foreground">
                  Zapisywanie decyzji…
                </p>
              )}
              {reason && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {reason}
                </p>
              )}
              {!reason && unavailable && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Akceptacja wymaga pełnego porównania zmian. Możesz odesłać
                  wynik do poprawy.
                </p>
              )}
              {decisionErrors[selected.id] && (
                <p
                  role="alert"
                  className="text-sm leading-relaxed whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]"
                >
                  {decisionErrors[selected.id]}
                </p>
              )}
            </section>
            {versions.length > 0 && (
              <section
                aria-label="Wersje wyniku"
                className="space-y-3 border-t pt-5"
              >
                <h3 className="text-sm font-medium">Wersje wyniku</h3>
                <div className="flex flex-wrap gap-2">
                  {versions.map(review => (
                    <Button
                      key={review.id}
                      variant={
                        review.id === selected.id ? 'secondary' : 'ghost'
                      }
                      size="sm"
                      aria-label={`Otwórz wersję ${review.version}`}
                      aria-pressed={review.id === selected.id}
                      onClick={() => onSelect(review.id)}
                    >
                      Wersja {review.version} ·{' '}
                      {reviewStatusLabels[review.status]}
                    </Button>
                  ))}
                </div>
              </section>
            )}
          </section>
        )}
      </section>
    </ScrollArea>
  );
}
