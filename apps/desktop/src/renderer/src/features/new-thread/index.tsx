import { useEffect, useRef, useState } from 'react';
import { GitFork } from 'lucide-react';
import { sessionIsolationSchema } from '@nesvo/contracts';
import type {
  Computer,
  CreateSessionInput,
  DefinitionIssue,
  DesktopApi,
  DesktopSession,
  McpSelection,
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
import { ImportConversation } from '@/features/import-conversation';
import { ProviderSetup } from '@/features/provider-setup';
import { McpChip } from '@/features/session-mcp/mcp-chip';
import {
  Composer,
  ComposerInput,
  ComposerSend,
  ComposerToolbar,
} from '@/shared/ui/composer';
import { StatusMessage } from '@/shared/ui/status-message';
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
import { modelEfforts, resolveEffort } from './reasoning-effort';
import { deriveThreadTitle } from './thread-title';
import { readNewSessionDefaults } from './new-session-defaults';

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
  hostApi: Pick<
    DesktopApi,
    'discoverSkills' | 'workflows' | 'listConversations' | 'adoptConversation'
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
const NO_MCP: McpSelection = { servers: [], hooks: false };

export function NewThread({
  setup,
  onSetupChange,
  computers,
  statuses,
  onRefreshProvider,
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
  const [mcpChoice, setMcpChoice] = useState({
    target: '',
    selection: NO_MCP,
  });
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
  const isolation = sessionIsolationSchema.safeParse({
    kind: 'worktree',
    branch: worktreeBranch.trim() || undefined,
  });
  const providerState = statuses[setup.provider];
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
  const showSetup = connected && setupHostId === setup.hostId;
  const models = providerState.status?.models ?? [];
  const model = models.some(option => option.id === setup.model)
    ? setup.model
    : (models[0]?.id ?? '');
  const effort = resolveEffort(
    modelEfforts(providerState, model),
    setup.effort,
  );
  const mcpTarget = [setup.hostId, setup.provider, setup.directory.trim()].join(
    '|',
  );
  const mcp = mcpChoice.target === mcpTarget ? mcpChoice.selection : NO_MCP;
  const supportsMcp = !!computer?.capabilities.includes('mcp-servers');
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
      await onStart(
        {
          title: deriveThreadTitle(message),
          provider: setup.provider,
          model,
          ...(effort ? { effort } : {}),
          mode: setup.mode,
          directory: setup.directory.trim(),
          ...(useWorktree && isolation.success
            ? { isolation: isolation.data }
            : {}),
          ...(supportsMcp && (mcp.servers.length || mcp.hooks) ? { mcp } : {}),
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
            <h2 className="text-display font-normal tracking-tight text-foreground sm:text-display-lg">
              What should we build?
            </h2>
            <Hint label={setup.directory.trim() || 'Isolated folder'}>
              <p
                data-thread-project
                className="truncate text-ui font-semibold text-foreground"
              >
                {project || 'No project'}
              </p>
            </Hint>
          </header>
        )}
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
                          statuses={statuses}
                          disabled={pending}
                          onChange={(provider, nextModel, nextEffort) => {
                            if (provider !== setup.provider) setSkill(null);
                            onSetupChange({
                              ...setup,
                              provider,
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
                  hostId={setup.hostId}
                  disabled={pending}
                  onChange={hostId => {
                    if (hostId !== setup.hostId) {
                      setSkill(null);
                      changeWorkflow(null);
                      setWorktreeChoice(null);
                      setWorktreeBranch('');
                    }
                    onSetupChange({ ...setup, hostId });
                  }}
                  onManageComputers={onManageComputers}
                  onImportConversation={() => setImportOpen(true)}
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
                <div className="flex-1" />
                <McpChip
                  key={mcpTarget}
                  hostId={setup.hostId}
                  provider={setup.provider}
                  target={{
                    provider: setup.provider,
                    directory: setup.directory.trim(),
                  }}
                  selection={mcp}
                  readOnly={setup.mode === 'read-only'}
                  disabled={pending || !connected}
                  unsupported={!supportsMcp}
                  lockedReason={
                    piped ? 'Workflow tasks start without MCP servers' : ''
                  }
                  onChange={selection =>
                    setMcpChoice({ target: mcpTarget, selection })
                  }
                />
                <PermissionPicker
                  provider={setup.provider}
                  modes={providerModes(setup.provider, providerState.status)}
                  mode={setup.mode}
                  disabled={pending}
                  onChange={mode => onSetupChange({ ...setup, mode })}
                />
              </div>
              {worktreeAvailable && useWorktree && (
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
          api={hostApi}
          onAdopted={onAdopted}
        />
      </div>
    </section>
  );
}
