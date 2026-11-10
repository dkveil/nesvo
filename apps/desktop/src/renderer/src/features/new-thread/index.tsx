import { useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import type {
  Computer,
  CreateSessionInput,
  DesktopApi,
} from '@nesvo/contracts';
import {
  directoryLabel,
  errorDetail,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import {
  SelectSkill,
  type SelectedSkill,
  type TypedSubmission,
} from '@/features/select-skill';
import { SelectedSkillChip } from '@/features/select-skill/selected-skill-chip';
import { Button } from '@/shared/ui/button';
import { Textarea } from '@/shared/ui/textarea';
import { HostPicker } from './host-picker';
import { LocationPicker } from './location-picker';
import { ModelPicker } from './model-picker';
import { PermissionPicker } from './permission-picker';
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
  onRefreshProvider: (provider: Provider) => void;
  onManageComputers: () => void;
  busyReason: string;
  skillApi: Pick<DesktopApi, 'discoverSkills'>;
  onStart: (
    input: CreateSessionInput,
    text: string,
    skill: SelectedSkill | null,
  ) => Promise<void>;
};

const MAX_MESSAGE_LENGTH = 32000;

export function NewThread({
  setup,
  onSetupChange,
  computers,
  statuses,
  onRefreshProvider,
  onManageComputers,
  busyReason,
  skillApi,
  onStart,
}: Props) {
  const [text, setText] = useState('');
  const [skill, setSkill] = useState<SelectedSkill | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [locationOpen, setLocationOpen] = useState(false);
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
  const submit = async (
    resolveTyped: (draft: string) => Promise<TypedSubmission>,
  ) => {
    if (!canSend) return;
    const typed = skill ? null : await resolveTyped(text);
    if (typed?.status === 'error') return;
    const message = typed?.status === 'skill' ? typed.text : text.trim();
    const chosen = typed?.status === 'skill' ? typed.skill : skill;
    setPending(true);
    setError('');
    try {
      await onStart(
        {
          title: deriveThreadTitle(message),
          provider: setup.provider,
          model,
          mode: setup.mode,
          directory: setup.directory.trim(),
        },
        message,
        chosen,
      );
    } catch (failure) {
      setError(`Could not start the thread. ${errorDetail(failure)}`);
    } finally {
      setPending(false);
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
                onClick={() => {
                  setSkill(null);
                  onSetupChange({ ...setup, directory: '' });
                }}
              >
                or start without a project
              </button>
            ) : (
              <button
                type="button"
                className="rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => setLocationOpen(true)}
              >
                or choose a project folder
              </button>
            )}
          </p>
        </header>
        <SelectSkill
          scope={{
            provider: setup.provider,
            input: {
              provider: setup.provider,
              directory: setup.directory.trim(),
            },
          }}
          api={skillApi}
          enabled={connected && !pending}
          draft={text}
          onSelect={next => {
            setSkill(next);
            if (text.startsWith('/')) setText(text.replace(/^\/[^\s]*\s?/, ''));
          }}
          onFocusMessage={() => input.current?.focus()}
        >
          {({
            trigger,
            anchor,
            notice,
            onKeyDown: onSkillKeyDown,
            onInput,
            resolveTyped,
            inputAria,
          }) => (
            <form
              onSubmit={event => {
                event.preventDefault();
                void submit(resolveTyped);
              }}
              className="space-y-2"
            >
              <label htmlFor="thread-input" className="sr-only">
                Message
              </label>
              {anchor(
                <div className="rounded-2xl border border-input/70 bg-card p-3 transition-colors focus-within:border-ring/70">
                  {skill && (
                    <SelectedSkillChip
                      skill={skill}
                      onRemove={() => setSkill(null)}
                    />
                  )}
                  <Textarea
                    ref={input}
                    id="thread-input"
                    autoFocus
                    placeholder="Ask anything. / for skills"
                    value={text}
                    {...inputAria}
                    onInput={onInput}
                    onChange={event => setText(event.target.value)}
                    onKeyDown={event => {
                      onSkillKeyDown(event);
                      if (
                        !event.defaultPrevented &&
                        event.key === 'Enter' &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        void submit(resolveTyped);
                      }
                    }}
                    maxLength={MAX_MESSAGE_LENGTH}
                    disabled={pending}
                    className="max-h-48 min-h-20 resize-none border-0 bg-transparent px-1 py-1 text-sm leading-6 shadow-none placeholder:text-muted-foreground/80 focus-visible:ring-0 dark:bg-transparent"
                  />
                  <div className="flex items-end justify-between gap-3 px-1 pt-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {trigger}
                      <span className="min-w-0 truncate text-[11px] leading-7 text-muted-foreground">
                        {pending ? 'Starting…' : blockedReason}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <ModelPicker
                        provider={setup.provider}
                        model={model}
                        statuses={statuses}
                        disabled={pending}
                        onChange={(provider, nextModel) => {
                          if (provider !== setup.provider) setSkill(null);
                          onSetupChange({
                            ...setup,
                            provider,
                            model: nextModel,
                            mode:
                              provider === 'Claude Code'
                                ? 'read-only'
                                : setup.mode,
                          });
                        }}
                        onRefreshProvider={onRefreshProvider}
                      />
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
                </div>,
              )}
              {notice}
              <div className="flex min-w-0 flex-wrap items-center gap-1 px-1">
                <HostPicker
                  computers={computers}
                  hostId={setup.hostId}
                  disabled={pending}
                  onChange={hostId => {
                    if (hostId !== setup.hostId) setSkill(null);
                    onSetupChange({ ...setup, hostId });
                  }}
                  onManageComputers={onManageComputers}
                />
                <LocationPicker
                  directory={setup.directory}
                  computerName={computer?.name ?? 'this computer'}
                  disabled={pending}
                  open={locationOpen}
                  onOpenChange={setLocationOpen}
                  onChange={directory => {
                    if (directory !== setup.directory) setSkill(null);
                    onSetupChange({ ...setup, directory });
                  }}
                />
                <div className="flex-1" />
                <PermissionPicker
                  provider={setup.provider}
                  mode={setup.mode}
                  disabled={pending}
                  onChange={mode => onSetupChange({ ...setup, mode })}
                />
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
          )}
        </SelectSkill>
      </div>
    </section>
  );
}
