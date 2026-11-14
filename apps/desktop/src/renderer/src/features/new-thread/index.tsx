import { useEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import type {
  Computer,
  CreateSessionInput,
  DefinitionIssue,
  DesktopApi,
  StartPipelineTaskInput,
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
import {
  pipelineIssues,
  resolveGate,
  type PipelineChoice,
} from './pipeline-choice';
import { PipelinePicker } from './pipeline-picker';
import { modelEfforts, resolveEffort } from './reasoning-effort';
import { deriveThreadTitle } from './thread-title';

export type ThreadSetup = {
  hostId: string;
  provider: Provider;
  model: string;
  effort: string;
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
  hostApi: Pick<DesktopApi, 'discoverSkills' | 'pipelines'>;
  onStart: (
    input: CreateSessionInput,
    text: string,
    skill: SelectedSkill | null,
  ) => Promise<void>;
  onStartPipeline: (
    input: StartPipelineTaskInput,
  ) => Promise<'opened' | 'started'>;
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
  hostApi,
  onStart,
  onStartPipeline,
}: Props) {
  const [text, setText] = useState('');
  const [skill, setSkill] = useState<SelectedSkill | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [locationOpen, setLocationOpen] = useState(false);
  const [pipeline, setPipeline] = useState<PipelineChoice | null>(null);
  const [issues, setIssues] = useState<DefinitionIssue[]>([]);
  const [startNotice, setStartNotice] = useState('');
  const piped = !!pipeline?.pipelineName;
  const input = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const latestSetup = useRef(setup);
  useEffect(() => {
    latestSetup.current = setup;
  }, [setup]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
  const effort = resolveEffort(
    modelEfforts(providerState, model),
    setup.effort,
  );
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
  const canSend =
    !pending &&
    !blockedReason &&
    (pipeline?.pipelineName ? !!pipeline.specPath.trim() : !!text.trim());
  const changePipeline = (next: PipelineChoice | null) => {
    if (next?.pipelineName) setSkill(null);
    setPipeline(next);
    setIssues([]);
    setError('');
    setStartNotice('');
  };
  const startPipeline = async (choice: PipelineChoice) => {
    const gate = resolveGate(choice, setup.provider, statuses);
    const title = text.trim()
      ? deriveThreadTitle(text.trim())
      : choice.specTitle;
    let outcome: 'opened' | 'started';
    try {
      outcome = await onStartPipeline({
        specPath: choice.specPath.trim(),
        pipelineName: choice.pipelineName,
        ...(title ? { title: title.slice(0, 100) } : {}),
        provider: setup.provider,
        model,
        ...(effort ? { effort } : {}),
        mode: setup.mode,
        directory: setup.directory.trim(),
        isolation:
          choice.isolation && setup.directory.trim() ? 'worktree' : 'none',
        gateProvider: gate.provider,
        gateModel: gate.model,
      });
    } catch (failure) {
      setError(`Could not start the pipeline task. ${errorDetail(failure)}`);
      try {
        const catalog = await hostApi.pipelines.validateDefinitions(
          setup.hostId,
          { directory: setup.directory.trim() },
        );
        if (mounted.current)
          setIssues(
            pipelineIssues(catalog, choice.pipelineName, choice.specPath),
          );
      } catch {
        return;
      }
      return;
    }
    if (!mounted.current || outcome === 'opened') return;
    setPipeline(null);
    setText('');
    setStartNotice(
      'The task started. Its session appears in the sidebar once this computer reports it.',
    );
  };
  const submit = async (
    resolveTyped: (draft: string) => Promise<TypedSubmission>,
  ) => {
    if (!canSend || submitting.current) return;
    if (pipeline?.pipelineName) {
      submitting.current = true;
      setPending(true);
      setError('');
      setIssues([]);
      setStartNotice('');
      try {
        await startPipeline(pipeline);
      } finally {
        submitting.current = false;
        if (mounted.current) setPending(false);
      }
      return;
    }
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      const submittedSetup = setup;
      const typed = skill ? null : await resolveTyped(text);
      if (typed?.status === 'error' || !mounted.current) return;
      if (latestSetup.current !== submittedSetup) {
        setError(
          'The thread settings changed while the skill was checked. Send again to use the new settings.',
        );
        return;
      }
      const message = typed?.status === 'skill' ? typed.text : text.trim();
      const chosen = typed?.status === 'skill' ? typed.skill : skill;
      await onStart(
        {
          title: deriveThreadTitle(message),
          provider: setup.provider,
          model,
          ...(effort ? { effort } : {}),
          mode: setup.mode,
          directory: setup.directory.trim(),
        },
        message,
        chosen,
      );
    } catch (failure) {
      setError(`Could not start the thread. ${errorDetail(failure)}`);
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return (
    <section
      aria-label="New thread"
      data-host-id={setup.hostId}
      className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center px-5 pb-16 lg:px-6"
    >
      <div className="w-full max-w-(--composer-max-width) space-y-5">
        <header className="space-y-1 text-center">
          <h2 className="text-2xl font-normal tracking-tight text-foreground sm:text-3xl">
            What should we build?
          </h2>
          <p
            data-thread-project
            className="truncate text-[13px] font-semibold text-foreground"
            title={setup.directory.trim() || 'Isolated folder'}
          >
            {project || 'No project'}
          </p>
        </header>
        <SelectSkill
          scope={{
            hostId: setup.hostId,
            provider: setup.provider,
            input: {
              provider: setup.provider,
              directory: setup.directory.trim(),
            },
          }}
          api={hostApi}
          enabled={connected && !pending && !piped}
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
                <div className="glass-composer relative z-10 rounded-2xl border px-3 pt-3 pb-2 transition-colors duration-150 focus-within:border-input">
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
                    placeholder={
                      piped
                        ? 'Task title (optional). The spec starts the task.'
                        : 'Ask anything. / for skills'
                    }
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
                    className="max-h-48 min-h-11 resize-none rounded-none border-0 bg-transparent px-1 py-0 text-sm leading-5 shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0 dark:bg-transparent"
                  />
                  <div className="flex items-center justify-between gap-3 pt-1">
                    <div className="flex min-w-0 items-center gap-2">
                      {trigger}
                      <span className="min-w-0 truncate text-[11px] leading-7 text-muted-foreground">
                        {pending ? 'Starting…' : blockedReason}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <ModelPicker
                        provider={setup.provider}
                        model={model}
                        effort={effort}
                        statuses={statuses}
                        disabled={pending}
                        onChange={(provider, nextModel, nextEffort) => {
                          if (provider !== setup.provider) setSkill(null);
                          onSetupChange({
                            ...setup,
                            provider,
                            model: nextModel,
                            effort: nextEffort,
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
                        className="size-7 rounded-full disabled:bg-send-idle disabled:text-send-idle-foreground disabled:opacity-100 [&_svg]:size-4"
                        disabled={!canSend}
                        aria-label={
                          piped ? 'Start pipeline task' : 'Send message'
                        }
                        title={
                          piped
                            ? 'Start pipeline task (Enter)'
                            : 'Send message (Enter)'
                        }
                      >
                        <ArrowUp />
                      </Button>
                    </div>
                  </div>
                </div>,
              )}
              {notice}
              <div className="flex min-w-0 flex-wrap items-center gap-1 px-2">
                <HostPicker
                  computers={computers}
                  hostId={setup.hostId}
                  disabled={pending}
                  onChange={hostId => {
                    if (hostId !== setup.hostId) {
                      setSkill(null);
                      changePipeline(null);
                    }
                    onSetupChange({ ...setup, hostId });
                  }}
                  onManageComputers={onManageComputers}
                />
                <LocationPicker
                  directory={setup.directory}
                  computerName={computer?.name ?? 'this computer'}
                  disabled={pending}
                  open={locationOpen && !pending}
                  onOpenChange={setLocationOpen}
                  onChange={directory => {
                    if (directory !== setup.directory) {
                      setSkill(null);
                      changePipeline(null);
                    }
                    onSetupChange({ ...setup, directory });
                  }}
                />
                <PipelinePicker
                  key={`${setup.hostId}:${setup.directory.trim()}`}
                  hostId={setup.hostId}
                  directory={setup.directory}
                  connected={connected}
                  authorProvider={setup.provider}
                  statuses={statuses}
                  api={hostApi.pipelines}
                  value={pipeline}
                  disabled={pending}
                  onChange={changePipeline}
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
              {startNotice && (
                <p
                  role="status"
                  className="px-1 text-sm leading-relaxed text-muted-foreground"
                >
                  {startNotice}
                </p>
              )}
              {issues.length > 0 && (
                <ul
                  aria-label="Pipeline issues"
                  className="space-y-1 px-1 text-xs leading-5 text-muted-foreground"
                >
                  {issues.map((issue, index) => (
                    <li key={index} className="[overflow-wrap:anywhere]">
                      <span
                        className={
                          issue.severity === 'error'
                            ? 'text-error-foreground'
                            : 'text-warning-foreground'
                        }
                      >
                        {issue.severity === 'error' ? 'Error' : 'Warning'}
                      </span>{' '}
                      {issue.message}
                      {issue.line ? ` (line ${issue.line})` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </form>
          )}
        </SelectSkill>
      </div>
    </section>
  );
}
