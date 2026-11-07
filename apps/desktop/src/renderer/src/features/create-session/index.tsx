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
  const orchestrating = provider === 'Codex' && role === 'orchestrator';
  const selectedMode = orchestrating ? 'read-only' : mode;
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
        mode: selectedMode,
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
        className="max-h-[90dvh] gap-0 overflow-y-auto border-input/70 bg-[#080808] p-0 sm:max-w-[34rem]"
        onCloseAutoFocus={event => {
          event.preventDefault();
          onReturnFocus();
        }}
      >
        <DialogHeader className="border-b px-5 py-4 text-left">
          <DialogTitle className="text-xl tracking-tight">
            Nowa sesja
          </DialogTitle>
          <DialogDescription className="mt-1 max-w-sm text-xs leading-5">
            Agent uruchomi się po pierwszej wiadomości.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={event => void submit(event)} className="space-y-4 p-5">
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
          <section className="space-y-3 rounded-xl border bg-background/50 p-3">
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
            <div className="space-y-2 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <span role="status" className="text-muted-foreground">
                  {providerStatusLabel(provider, providerState)}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1 text-[11px] font-normal"
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
                <p className="text-muted-foreground leading-5 [overflow-wrap:anywhere]">
                  {providerState.status.detail}
                </p>
              )}
            </div>
            <p className="text-[11px] leading-5 text-muted-foreground">
              Model zostanie sprawdzony przy uruchomieniu.
            </p>
          </section>
          <section className="space-y-3 rounded-xl border bg-background/50 p-3">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="session-role">Rola sesji</Label>
                <Select
                  value={role}
                  disabled={pending}
                  onValueChange={value => {
                    if (value === 'orchestrator' || value === 'standalone') {
                      setRole(value);
                      if (value === 'orchestrator') setMode('read-only');
                    }
                  }}
                >
                  <SelectTrigger id="session-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="orchestrator">Orkiestrator</SelectItem>
                    <SelectItem value="standalone">
                      Samodzielna sesja
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="session-mode">Tryb pracy</Label>
                <Select
                  value={selectedMode}
                  disabled={
                    pending || provider === 'Claude Code' || orchestrating
                  }
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
              </div>
            </div>
            <p className="text-[11px] leading-5 text-muted-foreground">
              {orchestrating
                ? 'Orkiestrator tylko czyta. Proponuje do dwóch workerów; przed uruchomieniem zatwierdzasz każdego i jego uprawnienia.'
                : selectedMode === 'read-only'
                  ? provider === 'Claude Code'
                    ? 'Odczyt i wyszukiwanie plików. Bez edycji i poleceń terminala.'
                    : 'Odczyt plików i polecenia do odczytu. Zapis i podwyższanie uprawnień są wyłączone.'
                  : 'Zmiany w katalogu pracy. Codex prosi o zgodę przy wymagających jej operacjach; nie przy każdej zmianie.'}
            </p>
          </section>
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
              className="text-[11px] leading-5 text-muted-foreground"
            >
              Bez ścieżki utworzymy osobny folder. Git nie jest wymagany.
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
          <DialogFooter className="border-t pt-4">
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
