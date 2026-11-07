import { Folder, ShieldCheck } from 'lucide-react';
import {
  modelLabels,
  roleLabels,
  statusLabels,
  type Session,
} from '@/entities/session';
import { Separator } from '@/shared/ui/separator';

type Props = { session: Session };

export function SessionDetails({ session }: Props) {
  return (
    <div className="space-y-6 p-5">
      <section aria-label="Informacje o sesji" className="space-y-4">
        <h2 className="text-sm font-semibold">Szczegóły sesji</h2>
        <dl className="space-y-3 text-xs">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Rola</dt>
            <dd>{roleLabels[session.role]}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Provider</dt>
            <dd>{session.provider}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Wybrany model</dt>
            <dd>{modelLabels[session.model]}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Model uruchomienia</dt>
            <dd className="break-all text-right">
              {session.actualModel ?? 'Po wysłaniu wiadomości'}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Stan</dt>
            <dd>{statusLabels[session.status]}</dd>
          </div>
        </dl>
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Folder className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-all leading-relaxed">
            {session.directory}
          </span>
        </div>
      </section>
      <Separator />
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="size-4" />
          Analiza · tylko odczyt
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Claude Code może czytać i wyszukiwać pliki. Edycja plików, polecenia
          terminala i delegacja będą dostępne w kolejnych etapach.
        </p>
      </section>
    </div>
  );
}
