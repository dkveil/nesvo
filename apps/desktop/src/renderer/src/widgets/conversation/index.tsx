import { useEffect, useRef } from 'react';
import {
  ArrowUp,
  Bot,
  CircleUserRound,
  Inbox,
  MessageSquare,
  ShieldCheck,
} from 'lucide-react';
import { roleLabels, type PreviewSession } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { Textarea } from '@/shared/ui/textarea';

type Props = {
  session: PreviewSession;
  draft: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  onInbox: () => void;
};

export function Conversation({
  session,
  draft,
  onDraft,
  onSend,
  onInbox,
}: Props) {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [session.id, session.messages.length]);
  return (
    <section
      aria-label="Rozmowa"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl space-y-8 px-5 py-8 lg:px-8">
          {session.messages.length === 0 && (
            <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
              <MessageSquare className="size-7 text-muted-foreground" />
              <h2 className="text-lg font-medium">Od czego zaczynamy?</h2>
              <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                Opisz cel i zakres pracy. W podglądzie możesz dodać wiadomość,
                aby sprawdzić układ rozmowy.
              </p>
            </div>
          )}
          {session.messages.map(message => (
            <article key={message.id} className="flex gap-3">
              <div className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">
                {message.author === 'operator' ? (
                  <CircleUserRound className="size-4" />
                ) : (
                  <Bot className="size-4" />
                )}
              </div>
              <div className="min-w-0 space-y-2 pt-0.5">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {message.author === 'operator'
                    ? 'Ty'
                    : roleLabels[session.role]}
                  {message.author === 'agent' && (
                    <span className="text-xs font-normal text-muted-foreground">
                      {session.provider}
                    </span>
                  )}
                </div>
                <p className="text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {message.body}
                </p>
              </div>
            </article>
          ))}
          {session.status === 'review' && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              <div className="flex items-center gap-3">
                <Inbox className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Wynik gotowy do odbioru</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Przykładowe podsumowanie i zmiany
                  </p>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={onInbox}>
                Otwórz wynik
              </Button>
            </div>
          )}
          {session.status === 'approval' && (
            <div className="space-y-3 border-t pt-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4" />
                Zgoda na uruchomienie podglądu
              </div>
              <p className="text-sm text-muted-foreground">
                Worker chce uruchomić podgląd formularza, aby sprawdzić
                nawigację klawiaturą.
              </p>
              <div className="flex gap-2">
                <Button size="sm" disabled>
                  Zezwól
                </Button>
                <Button size="sm" variant="outline" disabled>
                  Odmów
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Miejsce na decyzję operatora. Akcje są nieaktywne w podglądzie.
              </p>
            </div>
          )}
          <div ref={bottom} />
        </div>
      </ScrollArea>
      <div className="shrink-0 px-5 pt-3 pb-2 lg:px-8">
        <form
          className="mx-auto max-w-3xl"
          onSubmit={event => {
            event.preventDefault();
            if (draft.trim()) onSend();
          }}
        >
          <label htmlFor="message-input" className="sr-only">
            Wiadomość
          </label>
          <div className="rounded-xl border bg-background p-2 focus-within:ring-2 focus-within:ring-ring/30">
            <Textarea
              id="message-input"
              placeholder="Napisz, czym chcesz się zająć…"
              value={draft}
              onChange={event => onDraft(event.target.value)}
              className="max-h-40 min-h-14 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            <div className="flex justify-end px-1 pt-1">
              <Button
                type="submit"
                size="icon-sm"
                disabled={!draft.trim()}
                aria-label="Dodaj wiadomość do podglądu"
                title="Dodaj wiadomość do podglądu"
              >
                <ArrowUp />
              </Button>
            </div>
          </div>
        </form>
      </div>
    </section>
  );
}
