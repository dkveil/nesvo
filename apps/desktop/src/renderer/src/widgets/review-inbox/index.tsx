import { useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  FileCode2,
  Inbox,
  RotateCcw,
} from 'lucide-react';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { Separator } from '@/shared/ui/separator';

type ReviewPreview = {
  id: string;
  sessionId: string;
  title: string;
  summary: string;
  files: string[];
  diff: string;
};
type Props = { review: ReviewPreview; onSession: (id: string) => void };

export function ReviewInbox({ review, onSession }: Props) {
  const [opened, setOpened] = useState(false);
  return (
    <ScrollArea className="min-h-0 flex-1">
      <section
        aria-label="Skrzynka odbioru"
        className="mx-auto max-w-4xl space-y-6 p-5 lg:p-8"
      >
        {!opened ? (
          <>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">Oczekujące na odbiór</h2>
              <Badge variant="secondary">1 wynik</Badge>
            </div>
            <button
              type="button"
              onClick={() => setOpened(true)}
              className="flex w-full items-start gap-4 rounded-lg border p-5 text-left transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <div className="rounded-md border p-2">
                <FileCode2 className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-medium">{review.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {review.summary}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">Worker · Codex</Badge>
                  <span>Wersja 1</span>
                  <span>·</span>
                  <span>2 pliki</span>
                </div>
              </div>
              <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
            </button>
            <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <Inbox className="size-4 shrink-0" />
              <p>
                Wspólne miejsce na wyniki wszystkich sesji. Każdy wynik pokazuje
                autora, zakres zmian i wersję do odbioru.
              </p>
            </div>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => setOpened(false)}>
              <ArrowLeft />
              Wróć do listy
            </Button>
            <div className="space-y-3">
              <Badge variant="outline">Przykładowy wynik · wersja 1</Badge>
              <h2 className="text-xl font-semibold">{review.title}</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {review.summary}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSession(review.sessionId)}
              >
                Przejdź do sesji
                <ArrowUpRight />
              </Button>
            </div>
            <Separator />
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Zmiany w plikach</h3>
              {review.files.map(file => (
                <p
                  key={file}
                  className="flex items-center gap-2 text-xs [overflow-wrap:anywhere]"
                >
                  <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
                  {file}
                </p>
              ))}
            </div>
            <div className="overflow-hidden rounded-lg border">
              <div className="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
                Fragment zmian · dane demonstracyjne
              </div>
              <pre className="overflow-x-auto p-4 text-xs leading-6">
                <code>{review.diff}</code>
              </pre>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled>
                <Check />
                Zaakceptuj wynik
              </Button>
              <Button variant="outline" disabled>
                <RotateCcw />
                Odeślij do poprawy
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Podgląd wyniku. Akcje odbioru są nieaktywne i nie zmieniają
              plików.
            </p>
          </>
        )}
      </section>
    </ScrollArea>
  );
}
