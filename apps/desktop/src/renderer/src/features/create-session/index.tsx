import { useState, type FormEvent } from 'react';
import type { PreviewSession, Provider, SessionRole } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';

const models: Record<Provider, string[]> = {
  'Claude Code': ['Domyślny model', 'Opus', 'Sonnet', 'Haiku'],
  Codex: ['Domyślny model', 'Codex', 'GPT'],
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (session: PreviewSession) => void;
  onReturnFocus: () => void;
};

export function CreateSession({
  open,
  onOpenChange,
  onCreate,
  onReturnFocus,
}: Props) {
  const [title, setTitle] = useState('');
  const [provider, setProvider] = useState<Provider>('Claude Code');
  const [model, setModel] = useState('Domyślny model');
  const [role, setRole] = useState<SessionRole>('orchestrator');
  const [directory, setDirectory] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onCreate({
      id: crypto.randomUUID(),
      title: title.trim() || 'Nowa sesja',
      provider,
      model,
      role,
      directory: directory.trim(),
      status: 'ready',
      messages: [],
    });
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto"
        onCloseAutoFocus={event => {
          event.preventDefault();
          onReturnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Nowa sesja</DialogTitle>
          <DialogDescription>
            Wybierz, z kim chcesz pracować. W tym podglądzie sesja nie uruchamia
            agenta i znika po zamknięciu aplikacji.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="session-title">Nazwa sesji</Label>
            <Input
              id="session-title"
              placeholder="Np. plan nowej funkcji"
              value={title}
              onChange={event => setTitle(event.target.value)}
              maxLength={100}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="session-provider">Provider</Label>
              <Select
                value={provider}
                onValueChange={value => {
                  if (value === 'Claude Code' || value === 'Codex') {
                    setProvider(value);
                    setModel('Domyślny model');
                  }
                }}
              >
                <SelectTrigger id="session-provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Claude Code">Claude Code</SelectItem>
                  <SelectItem value="Codex">Codex</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="session-model">Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id="session-model" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models[provider].map(value => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Lista modeli jest przykładowa.
          </p>
          <div className="space-y-2">
            <Label htmlFor="session-role">Rola sesji</Label>
            <Select
              value={role}
              onValueChange={value => {
                if (value === 'orchestrator' || value === 'standalone')
                  setRole(value);
              }}
            >
              <SelectTrigger id="session-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="orchestrator">Orkiestrator</SelectItem>
                <SelectItem value="standalone">Samodzielna sesja</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="session-directory">
              Katalog pracy{' '}
              <span className="font-normal text-muted-foreground">
                (opcjonalnie)
              </span>
            </Label>
            <Input
              id="session-directory"
              placeholder="Wpisz ścieżkę lub zostaw puste"
              value={directory}
              onChange={event => setDirectory(event.target.value)}
              aria-describedby="directory-help"
            />
            <p
              id="directory-help"
              className="text-xs leading-relaxed text-muted-foreground"
            >
              Możesz zacząć bez katalogu. Wybrany folder nie musi być
              repozytorium Git.
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Anuluj
            </Button>
            <Button type="submit">Utwórz w podglądzie</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
