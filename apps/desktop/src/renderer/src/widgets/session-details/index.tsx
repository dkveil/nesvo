import { GitBranch, ShieldCheck, CornerDownRight, Folder } from 'lucide-react';
import {
  roleLabels,
  statusLabels,
  type PreviewSession,
} from '@/entities/session';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Separator } from '@/shared/ui/separator';

type Props = {
  session: PreviewSession;
  sessions: PreviewSession[];
  onSelect: (id: string) => void;
};

export function SessionDetails({ session, sessions, onSelect }: Props) {
  const root = sessions.find(item => item.id === session.parentId) ?? session;
  const children = sessions.filter(item => item.parentId === root.id);
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
            <dt className="text-muted-foreground">Model</dt>
            <dd>{session.model}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Stan przykładowy</dt>
            <dd>{statusLabels[session.status]}</dd>
          </div>
        </dl>
        <div className="flex items-start gap-2 rounded-md border p-3 text-xs">
          <Folder className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 break-all leading-relaxed">
            {session.directory || 'Bez katalogu pracy'}
          </span>
        </div>
      </section>
      <Separator />
      <section aria-label="Drzewo delegacji" className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <GitBranch className="size-4" />
          Delegacja
          <Badge variant="outline" className="ml-auto">
            {children.length}/2
          </Badge>
        </h2>
        <Button
          variant={root.id === session.id ? 'secondary' : 'ghost'}
          className="h-auto w-full justify-start px-3 py-2 text-left"
          onClick={() => onSelect(root.id)}
        >
          <span className="min-w-0">
            <span className="block truncate text-xs">{root.title}</span>
            <span className="block pt-1 text-xs font-normal text-muted-foreground">
              {roleLabels[root.role]}
            </span>
          </span>
        </Button>
        {children.map(child => (
          <Button
            key={child.id}
            variant={child.id === session.id ? 'secondary' : 'ghost'}
            className="h-auto w-full justify-start px-3 py-2 text-left"
            onClick={() => onSelect(child.id)}
          >
            <CornerDownRight className="shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block truncate text-xs">{child.title}</span>
              <span className="block pt-1 text-xs font-normal text-muted-foreground">
                {statusLabels[child.status]}
              </span>
            </span>
          </Button>
        ))}
        {children.length === 0 && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Tutaj pojawią się podsesje wydzielone przez orkiestratora.
          </p>
        )}
      </section>
      <Separator />
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="size-4" />
          Kontrola operatora
        </h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Miejsce na zgody dotyczące pracy tej sesji i uruchamiania workerów.
          Wyniki trafiają do wspólnej skrzynki do odbioru.
        </p>
        <Badge variant="outline">Podgląd zasad</Badge>
      </section>
    </div>
  );
}
