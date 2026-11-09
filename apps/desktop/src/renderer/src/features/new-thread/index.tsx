import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowUp, FolderOpen, Lock, Monitor, Pencil } from 'lucide-react';
import type { Computer, CreateSessionInput } from '@nesvo/contracts';
import {
  directoryLabel,
  errorDetail,
  modeLabels,
  modelLabel,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Textarea } from '@/shared/ui/textarea';
import { ComposerChip } from './composer-chip';
import { providerMarks } from './provider-mark';
import { deriveThreadTitle } from './thread-title';

export type ThreadSetup = {
  hostId: string;
  provider: Provider;
  model: string;
  mode: CreateSessionInput['mode'];
  directory: string;
};

type Props = {
  setup: ThreadSetup;
  onSetupChange: (setup: ThreadSetup) => void;
  computers: Computer[];
  statuses: ProviderStates;
  busyReason: string;
  onStart: (input: CreateSessionInput, text: string) => Promise<void>;
};

const MAX_MESSAGE_LENGTH = 32000;

export function NewThread({
  setup,
  onSetupChange,
  computers,
  statuses,
  busyReason,
  onStart,
}: Props) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const computer = computers.find(item => item.id === setup.hostId);
  const connected = computer?.status === 'connected';
  const providerState = statuses[setup.provider];
  const providerReady =
    providerState.status?.status === 'ready' &&
    !providerState.loading &&
    !providerState.error;
  const models = providerState.status?.models ?? [];
  const model = models.some(option => option.id === setup.model)
    ? setup.model
    : (models[0]?.id ?? '');
  const project = setup.directory.trim()
    ? directoryLabel(setup.directory.trim())
    : '';
  const blockedReason = !connected
    ? `${computer?.name ?? 'This computer'} is offline. Connect it in Computers to start a thread.`
    : busyReason
      ? busyReason
      : !providerReady
        ? `${setup.provider} is not ready on ${computer?.name ?? 'this computer'}.`
        : !model
          ? 'No model is available for this provider yet.'
          : '';
  const canSend = !pending && !blockedReason && !!text.trim();
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    setPending(true);
    setError('');
    try {
      await onStart(
        {
          title: deriveThreadTitle(text),
          provider: setup.provider,
          model,
          mode: setup.mode,
          directory: setup.directory.trim(),
        },
        text.trim(),
      );
    } catch (failure) {
      setError(`Could not start the thread. ${errorDetail(failure)}`);
    } finally {
      setPending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submit();
    }
  };
  return (
    <section
      aria-label="New thread"
      data-host-id={setup.hostId}
      className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center px-5 pb-16 lg:px-6"
    >
      <div className="w-full max-w-3xl space-y-7">
        <header className="space-y-2 text-center">
          <h2 className="text-2xl font-medium tracking-tight sm:text-[1.875rem]">
            {project ? (
              <>
                What should we build in{' '}
                <span className="font-semibold">{project}</span>?
              </>
            ) : (
              'What should we build?'
            )}
          </h2>
          <p className="text-[13px] text-muted-foreground">
            {project ? (
              <button
                type="button"
                className="rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => onSetupChange({ ...setup, directory: '' })}
              >
                or start without a project
              </button>
            ) : (
              'Work starts in an isolated folder on this computer.'
            )}
          </p>
        </header>
        <form onSubmit={event => void submit(event)} className="space-y-2">
          <label htmlFor="thread-input" className="sr-only">
            Message
          </label>
          <div className="rounded-2xl border border-input/70 bg-card p-3 transition-colors focus-within:border-ring/70">
            <Textarea
              ref={input}
              id="thread-input"
              autoFocus
              placeholder="Ask anything."
              value={text}
              onChange={event => setText(event.target.value)}
              onKeyDown={onKeyDown}
              maxLength={MAX_MESSAGE_LENGTH}
              disabled={pending}
              className="max-h-48 min-h-20 resize-none border-0 bg-transparent px-1 py-1 text-sm leading-6 shadow-none placeholder:text-muted-foreground/80 focus-visible:ring-0 dark:bg-transparent"
            />
            <div className="flex items-end justify-between gap-3 px-1 pt-2">
              <span className="min-w-0 truncate text-[11px] leading-7 text-muted-foreground">
                {pending ? 'Starting…' : blockedReason}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className="inline-flex h-7 items-center gap-1.5 px-2 text-xs"
                  title={`${setup.provider} · ${modelLabel(model || setup.model)}`}
                >
                  <span className="text-[10px] font-medium tracking-wide text-muted-foreground">
                    {providerMarks[setup.provider]}
                  </span>
                  <span className="font-medium">
                    {model ? modelLabel(model) : 'No model'}
                  </span>
                </span>
                <Button
                  type="submit"
                  size="icon-sm"
                  className="rounded-full disabled:bg-secondary disabled:text-muted-foreground"
                  disabled={!canSend}
                  aria-label="Send message"
                  title="Send message (Enter)"
                >
                  <ArrowUp />
                </Button>
              </div>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1 px-1">
            <ComposerChip disabled title="Run on">
              <Monitor />
              <span className="truncate">{computer?.name ?? 'Local'}</span>
              {!connected && <span>· Offline</span>}
            </ComposerChip>
            <ComposerChip disabled title={setup.directory || 'Isolated folder'}>
              <FolderOpen />
              <span className="truncate">{project || 'Isolated folder'}</span>
            </ComposerChip>
            <div className="flex-1" />
            <ComposerChip disabled title="Permissions">
              {setup.mode === 'read-only' ? <Lock /> : <Pencil />}
              <span>{modeLabels[setup.mode]}</span>
            </ComposerChip>
          </div>
          {error && (
            <p
              role="alert"
              className="px-1 text-sm leading-relaxed text-destructive [overflow-wrap:anywhere]"
            >
              {error}
            </p>
          )}
        </form>
      </div>
    </section>
  );
}
