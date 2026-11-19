import { useEffect, useRef, useState } from 'react';
import { GitFork, Globe, ListChecks } from 'lucide-react';
import {
  sessionIsolationSchema,
  worktreeTaskFieldsSchema,
} from '@nesvo/contracts';
import type {
  Computer,
  CreateSessionInput,
  DefinitionIssue,
  DesktopApi,
  DesktopSession,
  ListMcpServersInput,
  McpServerList,
  AttachWorktree,
  WorktreeProviderReply,
  StartWorkflowTaskInput,
} from '@nesvo/contracts';
import {
  directoryLabel,
  errorDetail,
  providerChecked,
  providerModes,
  providers,
  providerUsable,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import {
  SelectSkill,
  type SelectedSkill,
  type TypedSubmission,
} from '@/features/select-skill';
import { SelectedSkillChip } from '@/features/select-skill/selected-skill-chip';
import type { ProviderProfile } from '@nesvo/contracts';
import { ProfileSelect } from '@/features/provider-profiles/profile-select';
import { useProfileStatus } from '@/features/provider-profiles/use-profile-status';
import { ImportConversation } from '@/features/import-conversation';
import { ProviderSetup } from '@/features/provider-setup';
import { WorktreeRecipeHint } from '@/features/worktree-recipe';
import {
  Composer,
  ComposerInput,
  ComposerSend,
  ComposerToolbar,
} from '@/shared/ui/composer';
import { StatusMessage } from '@/shared/ui/status-message';
import { Button } from '@/shared/ui/button';
import { Chip } from '@/shared/ui/chip';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import { Hint } from '@/shared/ui/tooltip';
import { HostPicker } from './host-picker';
import { LocationPicker } from './location-picker';
import { ModelPicker } from './model-picker';
import { PermissionPicker } from './permission-picker';
import {
  workflowIssues,
  resolveGate,
  type WorkflowChoice,
} from './workflow-choice';
import { WorkflowPicker } from './workflow-picker';
import { resolveProviderEffort } from './reasoning-effort';
import { deriveThreadTitle } from './thread-title';
import { RepositoryReviewDialog } from './repository-review-dialog';
import { AttachWorktreePicker } from './attach-worktree';
import {
  defaultProfileKey,
  readNewSessionDefaults,
} from './new-session-defaults';

export type ThreadSetup = {
  hostId: string;
  provider: Provider;
  profileId?: string | null;
  model: string;
  effort: string;
  mode: CreateSessionInput['mode'];
  directory: string;
};

type Props = {
  setup: ThreadSetup;
  onSetupChange: (setup: ThreadSetup) => void;
  computers: Computer[];
  defaultFolders: Readonly<Record<string, string | null>>;
  statuses: ProviderStates;
  profiles: ProviderProfile[];
  onRefreshProvider: (provider: Provider) => void;
  onManageComputers: () => void;
  busyReason: string;
  hostApi: Pick<
    DesktopApi,
    | 'discoverSkills'
    | 'workflows'
    | 'listConversations'
    | 'adoptConversation'
    | 'codexStatus'
    | 'claudeStatus'
    | 'matchWorktreeRecipe'
  >;
  onAdopted: (session: DesktopSession) => void;
  gitRepository: boolean;
  onStart: (
    input: CreateSessionInput,
    text: string,
    skill: SelectedSkill | null,
  ) => Promise<void>;
  onStartWorkflow: (
    input: StartWorkflowTaskInput,
  ) => Promise<'opened' | 'started'>;
};

const MAX_MESSAGE_LENGTH = 32000;

export function NewThread({
  setup,
  onSetupChange,
  computers,
  defaultFolders,
  statuses: defaultStatuses,
  profiles,
  onRefreshProvider: refreshDefaultProvider,
  onManageComputers,
  busyReason,
  gitRepository,
  hostApi,
  onStart,
  onAdopted,
  onStartWorkflow,
}: Props) {
  const [text, setText] = useState('');
  const [skill, setSkill] = useState<SelectedSkill | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [locationOpen, setLocationOpen] = useState(false);
  const [workflow, setWorkflow] = useState<WorkflowChoice | null>(null);
  const [issues, setIssues] = useState<DefinitionIssue[]>([]);
  const [startNotice, setStartNotice] = useState('');
  const [worktreeDefault] = useState(() => readNewSessionDefaults().worktree);
  const [worktreeChoice, setWorktreeChoice] = useState<boolean | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState('');
  const [worktreeTaskType, setWorktreeTaskType] = useState('');
  const [worktreeTicket, setWorktreeTicket] = useState('');
  const [attachment, setAttachment] = useState<{
    directory: string;
    hostId: string;
    choice: AttachWorktree;
  }>();
  const [worktreePreview, setWorktreePreview] =
    useState<Extract<WorktreeProviderReply, { action: 'effective' }>>();
  const [planFirst, setPlanFirst] = useState(false);
  const [browser, setBrowser] = useState(false);
  const [repositoryReview, setRepositoryReview] = useState<{
    hostId: string;
    target: Extract<ListMcpServersInput, { directory: string }>;
    list: McpServerList;
    start: () => Promise<void>;
  }>();
  const piped = !!workflow?.workflowName;
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
  const worktreeAvailable =
    !piped &&
    gitRepository &&
    !!computer?.capabilities.includes('session-worktrees');
  const useWorktree = worktreeChoice ?? (worktreeDefault && worktreeAvailable);
  const attached =
    attachment?.directory === setup.directory &&
    attachment.hostId === setup.hostId
      ? attachment.choice
      : undefined;
  const customWorktrees =
    connected &&
    worktreeAvailable &&
    !!computer?.capabilities.includes('custom-worktree-providers');
  const planFirstAvailable =
    !piped && !!computer?.capabilities.includes('session-stages');
  const usePlanFirst = planFirst && planFirstAvailable;
  const isolation = sessionIsolationSchema.safeParse({
    kind: 'worktree',
    ...(attached
      ? { attach: attached }
      : {
          branch: worktreeBranch.trim() || undefined,
          task:
            worktreeTaskType || worktreeTicket
              ? {
                  type: worktreeTaskType || undefined,
                  ticket: worktreeTicket || undefined,
                }
              : undefined,
        }),
  });
  const previewTitle = text.trim()
    ? deriveThreadTitle(text.trim())
    : 'New session';
  useEffect(() => {
    if (!customWorktrees || !useWorktree || attached) return;
    let current = true;
    const timer = setTimeout(() => {
      const fields = worktreeTaskFieldsSchema.safeParse({
        type: worktreeTaskType || undefined,
        ticket: worktreeTicket || undefined,
      });
      if (!fields.success) return;
      void window.nesvo
        .customWorktreeProviders(
          {
            action: 'effective',
            directory: setup.directory,
            title: previewTitle,
            branch: worktreeBranch.trim() || undefined,
            fields: fields.data,
          },
          setup.hostId,
        )
        .then(
          result => {
            if (current && result.action === 'effective')
              setWorktreePreview(result);
          },
          reason => {
            if (current)
              setWorktreePreview({
                action: 'effective',
                provider: null,
                branch: null,
                reason: errorDetail(reason),
              });
          },
        );
    }, 350);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [
    attached,
    customWorktrees,
    previewTitle,
    setup.directory,
    setup.hostId,
    useWorktree,
    worktreeBranch,
    worktreeTaskType,
    worktreeTicket,
  ]);
  const validProfile =
    !setup.profileId ||
    profiles.some(
      profile =>
        profile.id === setup.profileId && profile.provider === setup.provider,
    );
  const profileProbe = useProfileStatus(
    hostApi,
    setup.hostId,
    setup.provider,
    setup.profileId,
    connected && validProfile,
  );
  const statuses = setup.profileId
    ? { ...defaultStatuses, [setup.provider]: profileProbe.state }
    : defaultStatuses;
  const onRefreshProvider = (provider: Provider) => {
    if (provider === setup.provider && setup.profileId) profileProbe.refresh();
    else refreshDefaultProvider(provider);
  };
  const accountFor = (hostId: string, provider: Provider) =>
    readNewSessionDefaults().profileIds[defaultProfileKey(hostId, provider)] ??
    null;
  const providerState = statuses[setup.provider];
  const browserAvailable =
    !piped && !!computer?.capabilities.includes('session-browser');
  const browserReason =
    setup.provider === 'Claude Code' &&
    providerState.status &&
    'browser' in providerState.status &&
    providerState.status.browser.status === 'unsupported'
      ? providerState.status.browser.reason
      : null;
  const useBrowser = browserAvailable && browser && !browserReason;
  const providerReady =
    providerState.status?.status === 'ready' &&
    !providerState.loading &&
    !providerState.error;
  const noProviderUsable = providers.every(
    item => providerChecked(statuses[item]) && !providerUsable(statuses[item]),
  );
  const someProviderUsable = providers.some(item =>
    providerUsable(statuses[item]),
  );
  const [setupHostId, setSetupHostId] = useState('');
  if (connected && noProviderUsable && setupHostId !== setup.hostId)
    setSetupHostId(setup.hostId);
  if (someProviderUsable && setupHostId === setup.hostId) setSetupHostId('');
  const showSetup =
    connected &&
    setupHostId === setup.hostId &&
    !profiles.length &&
    !setup.profileId;
  const models = providerState.status?.models ?? [];
  const model = models.some(option => option.id === setup.model)
    ? setup.model
    : (models[0]?.id ?? '');
  const effort = resolveProviderEffort(
    setup.provider,
    providerState,
    model,
    setup.effort,
  );
  const project = setup.directory.trim()
    ? directoryLabel(setup.directory.trim())
    : '';
  const blockedReason = !connected
    ? `${computer?.name ?? 'This computer'} is offline. Connect it in Computers to start a thread.`
    : busyReason
      ? busyReason
      : !validProfile
        ? 'The selected account is unavailable on this computer. Choose another account.'
        : piped && setup.profileId
          ? 'Choose Default account to start a workflow task.'
          : !providerReady
            ? `${setup.provider} is not ready on ${computer?.name ?? 'this computer'}.`
            : !model
              ? 'No model is available for this provider yet.'
              : '';
  const canSend =
    !pending &&
    !blockedReason &&
    (piped || !useWorktree || (worktreeAvailable && isolation.success)) &&
    (workflow?.workflowName ? !!workflow.specPath.trim() : !!text.trim());
  const changeWorkflow = (next: WorkflowChoice | null) => {
    if (next?.workflowName) setSkill(null);
    setWorkflow(next);
    setIssues([]);
    setError('');
    setStartNotice('');
  };
  const startWorkflow = async (choice: WorkflowChoice) => {
    const gate = resolveGate(choice, setup.provider, statuses);
    const title = text.trim()
      ? deriveThreadTitle(text.trim())
      : choice.specTitle;
    let outcome: 'opened' | 'started';
    try {
      outcome = await onStartWorkflow({
        specPath: choice.specPath.trim(),
        workflowName: choice.workflowName,
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
      setError(`Could not start the workflow task. ${errorDetail(failure)}`);
      try {
        const catalog = await hostApi.workflows.validateDefinitions(
          setup.hostId,
          { directory: setup.directory.trim() },
        );
        if (mounted.current)
          setIssues(
            workflowIssues(catalog, choice.workflowName, choice.specPath),
          );
      } catch {
        return;
      }
      return;
    }
    if (!mounted.current || outcome === 'opened') return;
    setWorkflow(null);
    setText('');
    setStartNotice(
      'The task started. Its session appears in the sidebar once this computer reports it.',
    );
  };
  const submit = async (
    resolveTyped: (draft: string) => Promise<TypedSubmission>,
  ) => {
    if (!canSend || submitting.current) return;
    if (workflow?.workflowName) {
      submitting.current = true;
      setPending(true);
      setError('');
      setIssues([]);
      setStartNotice('');
      try {
        await startWorkflow(workflow);
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
      let isolated =
        useWorktree && isolation.success ? isolation.data : undefined;
      if (customWorktrees && isolated && !attached) {
        const effective = await window.nesvo.customWorktreeProviders(
          {
            action: 'effective',
            directory: setup.directory,
            title: deriveThreadTitle(message),
            branch: isolated.branch,
            fields: isolated.task,
          },
          setup.hostId,
        );
        if (!mounted.current || latestSetup.current !== submittedSetup) return;
        if (effective.action === 'effective') {
          setWorktreePreview(effective);
          if (effective.reason) throw new Error(effective.reason);
          if (effective.provider)
            isolated = {
              ...isolated,
              providerRevision: effective.provider.fingerprint,
            };
        }
      }
      const start = () =>
        onStart(
          {
            title: deriveThreadTitle(message),
            provider: setup.provider,
            ...(setup.profileId ? { profileId: setup.profileId } : {}),
            model,
            ...(effort ? { effort } : {}),
            mode: setup.mode,
            directory: setup.directory.trim(),
            ...(isolated ? { isolation: isolated } : {}),
            ...(usePlanFirst ? { planFirst: true } : {}),
            ...(useBrowser ? { browser: true } : {}),
          },
          message,
          chosen,
        );
      if (
        gitRepository &&
        computer?.capabilities.includes('repository-trust-rules')
      ) {
        const target = {
          provider: setup.provider,
          profileId: setup.profileId,
          directory: setup.directory.trim(),
        };
        const list = await window.nesvo.listMcpServers(target, setup.hostId);
        if (!mounted.current || latestSetup.current !== submittedSetup) return;
        const repository = list.repository;
        if (
          repository &&
          repository.identity?.status !== 'unverified' &&
          (repository.status === 'needs-trust' ||
            repository.status === 'unavailable' ||
            repository.changed)
        ) {
          setRepositoryReview({ hostId: setup.hostId, target, list, start });
          return;
        }
      }
      await start();
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
      {repositoryReview && (
        <RepositoryReviewDialog
          hostId={repositoryReview.hostId}
          target={repositoryReview.target}
          list={repositoryReview.list}
          onOpenChange={open => {
            if (!open) setRepositoryReview(undefined);
          }}
          onContinue={async () => {
            await repositoryReview.start();
            if (mounted.current) setRepositoryReview(undefined);
          }}
        />
      )}
      <div className="w-full max-w-(--composer-max-width) space-y-5">
        {showSetup ? (
          <ProviderSetup
            statuses={statuses}
            computerName={computer?.name ?? 'this computer'}
            onCheckAgain={() => {
              for (const item of providers) onRefreshProvider(item);
            }}
          />
        ) : (
          <header className="space-y-1 text-center">
            <h2 className="text-title font-semibold">What should we build?</h2>
            {project && (
              <Hint label={setup.directory.trim()}>
                <p
                  data-thread-project
                  className="truncate text-xs text-muted-foreground"
                >
                  {project}
                </p>
              </Hint>
            )}
          </header>
        )}
        <SelectSkill
          scope={{
            hostId: setup.hostId,
            provider: setup.provider,
            input: {
              provider: setup.provider,
              ...(setup.profileId ? { profileId: setup.profileId } : {}),
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
                <Composer className="z-10">
                  {skill && (
                    <SelectedSkillChip
                      skill={skill}
                      onRemove={() => setSkill(null)}
                    />
                  )}
                  <ComposerInput
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
                  />
                  <ComposerToolbar
                    start={
                      <>
                        <WorkflowPicker
                          key={`${setup.hostId}:${setup.directory.trim()}`}
                          hostId={setup.hostId}
                          directory={setup.directory}
                          connected={connected}
                          authorProvider={setup.provider}
                          statuses={statuses}
                          api={hostApi.workflows}
                          value={workflow}
                          disabled={pending}
                          onChange={changeWorkflow}
                        />
                        <span className="min-w-0 truncate">
                          {pending ? 'Starting…' : blockedReason}
                        </span>
                      </>
                    }
                    end={
                      <>
                        <ModelPicker
                          provider={setup.provider}
                          model={model}
                          effort={effort}
                          claudeEffort
                          statuses={statuses}
                          disabled={pending}
                          onChange={(provider, nextModel, nextEffort) => {
                            if (provider !== setup.provider) setSkill(null);
                            onSetupChange({
                              ...setup,
                              provider,
                              profileId:
                                provider === setup.provider
                                  ? setup.profileId
                                  : accountFor(setup.hostId, provider),
                              model: nextModel,
                              effort: nextEffort,
                              mode: providerModes(
                                provider,
                                statuses[provider].status,
                              ).includes(setup.mode)
                                ? setup.mode
                                : 'read-only',
                            });
                          }}
                          onRefreshProvider={onRefreshProvider}
                        />
                        <ComposerSend
                          disabled={!canSend}
                          label={piped ? 'Start workflow task' : 'Send message'}
                          shortcut="Enter"
                        />
                      </>
                    }
                  />
                </Composer>,
              )}
              {notice}
              <div className="flex min-w-0 flex-wrap items-center gap-1 px-2">
                <HostPicker
                  computers={computers}
                  defaultFolders={defaultFolders}
                  hostId={setup.hostId}
                  disabled={pending}
                  onChange={hostId => {
                    if (hostId !== setup.hostId) {
                      setSkill(null);
                      changeWorkflow(null);
                      setWorktreeChoice(null);
                      setWorktreeBranch('');
                    }
                    const previousDefault = defaultFolders[setup.hostId] ?? '';
                    const keepsDefault =
                      !setup.directory.trim() ||
                      setup.directory.trim() === previousDefault;
                    onSetupChange({
                      ...setup,
                      hostId,
                      directory:
                        hostId !== setup.hostId && keepsDefault
                          ? (defaultFolders[hostId] ?? '')
                          : setup.directory,
                      profileId:
                        hostId === setup.hostId
                          ? setup.profileId
                          : accountFor(hostId, setup.provider),
                    });
                  }}
                  onManageComputers={onManageComputers}
                  onImportConversation={() => setImportOpen(true)}
                />
                {(profiles.some(
                  profile => profile.provider === setup.provider,
                ) ||
                  setup.profileId) && (
                  <ProfileSelect
                    profiles={profiles}
                    provider={setup.provider}
                    value={setup.profileId}
                    disabled={pending || !connected}
                    className="max-w-40"
                    onChange={profileId => {
                      setSkill(null);
                      setError('');
                      onSetupChange({
                        ...setup,
                        profileId,
                        model: 'default',
                        effort: '',
                        mode: 'read-only',
                      });
                    }}
                  />
                )}
                <LocationPicker
                  directory={setup.directory}
                  defaultDirectory={defaultFolders[setup.hostId] ?? null}
                  computerName={computer?.name ?? 'this computer'}
                  disabled={pending}
                  open={locationOpen && !pending}
                  onOpenChange={setLocationOpen}
                  onChange={directory => {
                    if (directory !== setup.directory) {
                      setSkill(null);
                      changeWorkflow(null);
                      setWorktreeChoice(null);
                      setWorktreeBranch('');
                    }
                    onSetupChange({ ...setup, directory });
                  }}
                />
                {worktreeAvailable && (
                  <Chip
                    type="button"
                    icon={<GitFork aria-hidden="true" />}
                    selected={useWorktree}
                    aria-pressed={useWorktree}
                    disabled={pending}
                    onClick={() => setWorktreeChoice(!useWorktree)}
                  >
                    <span>Worktree</span>
                  </Chip>
                )}
                {planFirstAvailable && (
                  <Hint label="The first turn only plans. You approve, correct or reject the plan before it runs with the chosen permissions.">
                    <Chip
                      type="button"
                      icon={<ListChecks aria-hidden="true" />}
                      selected={usePlanFirst}
                      aria-pressed={usePlanFirst}
                      disabled={pending}
                      onClick={() => setPlanFirst(!planFirst)}
                    >
                      <span>Plan first</span>
                    </Chip>
                  </Hint>
                )}
                {browserAvailable && (
                  <Hint
                    label={
                      browserReason ??
                      (setup.provider === 'Codex'
                        ? 'Uses a browser MCP server from the Codex configuration'
                        : 'Lets the session open pages in your browser')
                    }
                  >
                    <Chip
                      type="button"
                      icon={<Globe aria-hidden="true" />}
                      selected={useBrowser}
                      aria-pressed={useBrowser}
                      disabled={pending || !!browserReason}
                      onClick={() => setBrowser(!useBrowser)}
                    >
                      <span>Browser</span>
                    </Chip>
                  </Hint>
                )}
                <div className="flex-1" />
                <PermissionPicker
                  provider={setup.provider}
                  modes={providerModes(setup.provider, providerState.status)}
                  mode={setup.mode}
                  disabled={pending}
                  onChange={mode => onSetupChange({ ...setup, mode })}
                />
              </div>
              {worktreeAvailable && useWorktree && !attached && (
                <Field
                  id="thread-worktree-branch"
                  label="Branch name (optional)"
                  hint="Starts from the current commit with tracked files only."
                  messages={
                    isolation.success
                      ? []
                      : [
                          {
                            severity: 'error',
                            message: 'Use a valid Git branch name.',
                          },
                        ]
                  }
                  className="px-2"
                >
                  <Input
                    id="thread-worktree-branch"
                    aria-describedby={
                      isolation.success
                        ? 'thread-worktree-branch-hint'
                        : 'thread-worktree-branch-messages'
                    }
                    aria-invalid={!isolation.success}
                    placeholder="Generate a branch name"
                    value={worktreeBranch}
                    maxLength={200}
                    spellCheck={false}
                    disabled={pending}
                    onChange={event => setWorktreeBranch(event.target.value)}
                  />
                </Field>
              )}
              {customWorktrees && useWorktree && !attached && (
                <div className="space-y-2 px-2">
                  {worktreePreview?.provider && (
                    <div className="grid grid-cols-2 gap-2">
                      <Field id="worktree-task-type" label="Task type">
                        <Input
                          id="worktree-task-type"
                          placeholder="fix"
                          value={worktreeTaskType}
                          onChange={event =>
                            setWorktreeTaskType(event.target.value)
                          }
                          disabled={pending}
                        />
                      </Field>
                      <Field id="worktree-ticket" label="Ticket">
                        <Input
                          id="worktree-ticket"
                          placeholder="TASK-123"
                          value={worktreeTicket}
                          onChange={event =>
                            setWorktreeTicket(event.target.value)
                          }
                          disabled={pending}
                        />
                      </Field>
                    </div>
                  )}
                  {worktreePreview?.reason ? (
                    <StatusMessage tone="warning">
                      {worktreePreview.reason}
                    </StatusMessage>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {worktreePreview?.provider?.name ?? 'Built-in Git'}
                      {worktreePreview?.branch
                        ? ` · ${worktreePreview.branch.replace(/00000000$/, '…')}`
                        : ''}
                    </p>
                  )}
                </div>
              )}
              {customWorktrees && (
                <div className="flex items-center gap-2 px-2">
                  {attached ? (
                    <>
                      <span className="text-xs text-muted-foreground">
                        Adopt {attached.branch}
                      </span>
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => setAttachment(undefined)}
                      >
                        Clear
                      </Button>
                    </>
                  ) : (
                    <AttachWorktreePicker
                      key={setup.hostId + ':' + setup.directory}
                      hostId={setup.hostId}
                      directory={setup.directory}
                      onAdopt={choice => {
                        setAttachment({
                          directory: setup.directory,
                          hostId: setup.hostId,
                          choice,
                        });
                        setWorktreeChoice(true);
                      }}
                      onView={directory => {
                        onSetupChange({ ...setup, directory });
                        setWorktreeChoice(false);
                      }}
                    />
                  )}
                </div>
              )}
              <WorktreeRecipeHint
                api={hostApi}
                directory={setup.directory}
                boundWorktree={
                  !!attached || worktreePreview?.provider?.kind === 'external'
                }
                enabled={
                  worktreeAvailable &&
                  useWorktree &&
                  connected &&
                  !!computer?.capabilities.includes('worktree-recipes')
                }
              />
              {!piped && useWorktree && !worktreeAvailable && (
                <StatusMessage tone="warning" variant="notice">
                  Choose a Git project folder to create the worktree.
                </StatusMessage>
              )}
              {error && (
                <StatusMessage tone="error" variant="notice">
                  {error}
                </StatusMessage>
              )}
              {startNotice && (
                <StatusMessage tone="success" variant="notice">
                  {startNotice}
                </StatusMessage>
              )}
              {issues.length > 0 && (
                <ul
                  aria-label="Workflow issues"
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
        <ImportConversation
          key={[setup.hostId, computer?.instanceId].join(':')}
          open={importOpen}
          onOpenChange={setImportOpen}
          computer={computer}
          profiles={profiles}
          initialProfileId={setup.profileId}
          api={hostApi}
          onAdopted={onAdopted}
        />
      </div>
    </section>
  );
}
