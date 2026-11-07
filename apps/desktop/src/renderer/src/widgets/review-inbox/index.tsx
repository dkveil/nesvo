import { Inbox } from 'lucide-react';

export function ReviewInbox() {
  return (
    <section
      aria-label="Skrzynka odbioru"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <Inbox className="size-7 text-muted-foreground" />
      <h2 className="text-lg font-medium">Skrzynka jest pusta</h2>
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
        Odbiór wyników pojawi się w kolejnym etapie. Odpowiedzi Claude Code są
        dostępne w rozmowach.
      </p>
    </section>
  );
}
