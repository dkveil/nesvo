import { useState, type FormEvent } from 'react';
import type { CreateSessionInput, Session } from '@nesvo/contracts';
import {
  errorDetail,
  modeLabels,
  providerStatusLabel,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
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

type Props = {
  open: boolean;
  statuses: ProviderStates;
  onRefreshProvider: (provider: Provider) => void;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: CreateSessionInput) => Promise<Session>;
  onReturnFocus: () => void;
};

export function CreateSession({
  open,
  statuses,
  onRefreshProvider,
  onOpenChange,
  onCreate,
  onReturnFocus,
}: Props) {
  const [title, setTitle] = useState('');
  const [provider, setProvider] = useState<Provider>('Claude Code');
  const [model, setModel] = useState('default');
  const [mode, setMode] = useState<CreateSessionInput['mode']>('read-only');
  const providerState = statuses[provider];
  const models = providerState.status?.models ?? [];
  const selectedModel = models.some(option => option.id === model)
    ? model
    : (models[0]?.id ?? 'default');
  const [role, setRole] = useState<CreateSessionInput['role']>('orchestrator');
  const [directory, setDirectory] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await onCreate({
        title: title.trim() || 'Nowa sesja',
        provider,
        model: selectedModel,
        mode,
        role,
        directory: directory.trim(),
      });
      onOpenChange(false);
    } catch (failure) {
      setError(`Nie udało się utworzyć sesji. ${errorDetail(failure)}`);
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={value => {
        if (!pending) onOpenChange(value);
      }}
    >
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
            Rozmowa zostanie zapisana lokalnie. Agent uruchomi się po wysłaniu
            pierwszej wiadomości.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={event => void submit(event)} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="session-title">Nazwa sesji</Label>
            <Input
              id="session-title"
              placeholder="Np. plan nowej funkcji"
              value={title}
              onChange={event => setTitle(event.target.value)}
              maxLength={100}
              disabled={pending}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="session-provider">Provider</Label>
              <Select
                value={provider}
                disabled={pending}
                onValueChange={value => {
                  if (value === 'Claude Code' || value === 'Codex') {
                    setProvider(value);
                    setModel('default');
                    setMode('read-only');
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
              <Select
                value={selectedModel}
                disabled={pending || models.length === 0}
                onValueChange={setModel}
              >
                <SelectTrigger id="session-model" className="w-full">
                  <SelectValue placeholder="Domyślny" />
                </SelectTrigger>
                <SelectContent>
                  {models.map(option => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span role="status" className="text-muted-foreground">
                {providerStatusLabel(provider, providerState)}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending || providerState.loading}
                onClick={() => onRefreshProvider(provider)}
              >
                Odśwież status
              </Button>
            </div>
            {providerState.error && (
              <p
                role="alert"
                className="text-destructive [overflow-wrap:anywhere]"
              >
                {providerState.error}
              </p>
            )}
            {providerState.status?.detail && (
              <p className="text-muted-foreground [overflow-wrap:anywhere]">
                {providerState.status.detail}
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {provider === 'Claude Code'
              ? 'Obsługiwane aliasy Claude Code. Dostępność modelu na koncie zostanie sprawdzona przy uruchomieniu.'
              : 'Modele udostępnione przez lokalny Codex. Dostępność na koncie zostanie sprawdzona przy uruchomieniu.'}
          </p>
          <div className="space-y-2">
            <Label htmlFor="session-mode">Tryb pracy</Label>
            <Select
              value={mode}
              disabled={pending || provider === 'Claude Code'}
              onValueChange={value => {
                if (value === 'read-only' || value === 'supervised')
                  setMode(value);
              }}
            >
              <SelectTrigger id="session-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="read-only">
                  {modeLabels['read-only']}
                </SelectItem>
                {provider === 'Codex' && (
                  <SelectItem value="supervised">
                    {modeLabels.supervised}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {mode === 'read-only'
                ? provider === 'Claude Code'
                  ? 'Claude Code może czytać i wyszukiwać pliki. Edycja i polecenia terminala są wyłączone.'
                  : 'Codex może czytać pliki i uruchamiać polecenia służące do odczytu. Zapis plików i podwyższanie uprawnień są wyłączone.'
                : 'Codex może zmieniać pliki w katalogu pracy. O zgodę zapyta przy operacjach wymagających potwierdzenia; nie każda zmiana wymaga zgody.'}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="session-role">Rola sesji</Label>
            <Select
              value={role}
              disabled={pending}
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
              maxLength={4096}
              disabled={pending}
              aria-describedby="directory-help"
            />
            <p
              id="directory-help"
              className="text-xs leading-relaxed text-muted-foreground"
            >
              Puste pole tworzy osobny lokalny folder. Wybrany katalog nie musi
              być repozytorium Git.
            </p>
          </div>
          {error && (
            <p
              role="alert"
              className="text-sm leading-relaxed text-destructive [overflow-wrap:anywhere]"
            >
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Anuluj
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Tworzenie…' : 'Utwórz sesję'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
