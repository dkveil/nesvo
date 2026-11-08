import { useState, type FormEvent } from 'react';
import type { Computer, CreateSessionInput, Session } from '@nesvo/contracts';
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
  computers: Computer[];
  hostId: string;
  onHostChange: (hostId: string) => void;
  onRefreshProvider: (provider: Provider) => void;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: CreateSessionInput) => Promise<Session>;
  onReturnFocus: () => void;
};

export function CreateSession({
  open,
  statuses,
  computers,
  hostId,
  onHostChange,
  onRefreshProvider,
  onOpenChange,
  onCreate,
  onReturnFocus,
}: Props) {
  const [title, setTitle] = useState('');
  const [provider, setProvider] = useState<Provider>('Claude Code');
  const [model, setModel] = useState('default');
  const [mode, setMode] = useState<CreateSessionInput['mode']>('read-only');
  const [directory, setDirectory] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const providerState = statuses[provider];
  const computer = computers.find(item => item.id === hostId);
  const connected = computer?.status === 'connected';
  const models = providerState.status?.models ?? [];
  const selectedModel = models.some(option => option.id === model)
    ? model
    : (models[0]?.id ?? 'default');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !connected) return;
    setPending(true);
    setError('');
    try {
      await onCreate({
        title: title.trim() || 'New session',
        provider,
        model: selectedModel,
        mode,
        directory: directory.trim(),
      });
      onOpenChange(false);
    } catch (failure) {
      setError(`Could not create the session. ${errorDetail(failure)}`);
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
        className="max-h-[90dvh] gap-0 overflow-y-auto border-input/70 bg-[#090909] p-0 sm:max-w-[32rem]"
        onCloseAutoFocus={event => {
          event.preventDefault();
          onReturnFocus();
        }}
      >
        <DialogHeader className="px-5 pt-5 pb-4 text-left">
          <DialogTitle className="text-lg font-medium tracking-tight">
            New session
          </DialogTitle>
          <DialogDescription className="text-xs leading-5">
            Choose an agent and describe what you want to do.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={event => void submit(event)}
          className="space-y-5 px-5 pb-5"
        >
          <div className="space-y-2">
            <Label htmlFor="session-computer">Computer</Label>
            <Select
              value={hostId}
              disabled={pending}
              onValueChange={value => {
                onHostChange(value);
                setModel('default');
              }}
            >
              <SelectTrigger id="session-computer" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {computers.map(item => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                    {item.status !== 'connected' ? ' · Offline' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!connected && (
              <p className="text-xs text-muted-foreground">
                Connect this computer in Computers before creating a session.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="session-title">Session name</Label>
            <Input
              id="session-title"
              placeholder="What are you working on?"
              value={title}
              onChange={event => setTitle(event.target.value)}
              maxLength={100}
              disabled={pending}
            />
          </div>
          <section className="space-y-3 border-y py-4">
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
                    <SelectValue placeholder="Default" />
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
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span role="status" className="text-muted-foreground">
                {providerStatusLabel(provider, providerState)}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-1 text-[11px] font-normal text-muted-foreground"
                disabled={pending || providerState.loading || !connected}
                onClick={() => onRefreshProvider(provider)}
              >
                Refresh status
              </Button>
            </div>
            {providerState.error && (
              <p
                role="alert"
                className="text-xs text-destructive [overflow-wrap:anywhere]"
              >
                {providerState.error}
              </p>
            )}
            {providerState.status?.status !== 'ready' &&
              providerState.status?.detail && (
                <p className="text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                  {providerState.status.detail}
                </p>
              )}
            <p className="text-[11px] text-muted-foreground">
              Model availability is confirmed when the agent starts.
            </p>
          </section>
          <div className="space-y-2">
            <Label htmlFor="session-mode">Access</Label>
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
            <p className="text-[11px] leading-5 text-muted-foreground">
              {provider === 'Claude Code'
                ? 'Claude Code supports file reading and search here. Editing and shell commands are disabled.'
                : mode === 'read-only'
                  ? 'Read files and run read commands. File writes and elevated access are disabled.'
                  : 'Edit files in the working directory. Codex asks for approval when required, rather than for every change.'}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="session-directory">
              Working directory{' '}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <Input
              id="session-directory"
              aria-label="Working directory"
              placeholder="Leave blank for an isolated folder"
              value={directory}
              onChange={event => setDirectory(event.target.value)}
              maxLength={4096}
              disabled={pending}
              aria-describedby="directory-help"
            />
            <p
              id="directory-help"
              className="text-[11px] text-muted-foreground"
            >
              Any folder on {computer?.name ?? 'this computer'}. A Git
              repository is not required.
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
          <DialogFooter className="pt-1">
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !connected}>
              {pending ? 'Creating…' : 'Create session'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
