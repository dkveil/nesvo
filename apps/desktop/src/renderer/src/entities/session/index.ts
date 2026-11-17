import type {
  ClaudeStatus,
  CodexStatus,
  DesktopSession as Session,
  SessionMode,
} from '@nesvo/contracts';
import type { Tone } from '@/entities/status';

export type { DesktopSession as Session } from '@nesvo/contracts';
export { ProviderGlyph } from './provider-glyph';
export { effortLabel } from './effort-label';
export { ModeIcon } from './mode-icon';
export {
  sessionFilterKeys,
  sessionFilterLabels,
  sessionFilters,
  type SessionFilter,
  type SessionFilterKeys,
} from './session-filters';

export const roleLabels: Record<Session['role'], string> = {
  orchestrator: 'Orchestrator',
  standalone: 'Session',
  worker: 'Worker',
};

const modelLabels: Record<string, string> = {
  default: 'Default',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
};

export const statusTones: Partial<Record<Session['status'], Tone>> = {
  running: 'info',
  stopping: 'info',
  completed: 'success',
  failed: 'error',
};

export const statusLabels: Record<Session['status'], string> = {
  ready: 'Ready',
  running: 'Working',
  stopping: 'Stopping…',
  completed: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

const IPC_ERROR_PREFIX =
  /^Error invoking remote method '[^']+': (?:\w*Error: )?/;

export function errorDetail(error: unknown) {
  return error instanceof Error
    ? error.message.replace(IPC_ERROR_PREFIX, '')
    : 'Unknown error.';
}

export type Provider = Session['provider'];
export type ProviderState = {
  status: ClaudeStatus | CodexStatus | null;
  loading: boolean;
  error: string;
};
export type ProviderStates = Record<Provider, ProviderState>;

export const providers: Provider[] = ['Claude Code', 'Codex'];
export const providerCommands: Record<
  Provider,
  { install: string; signIn: string }
> = {
  'Claude Code': {
    install: 'npm install -g @anthropic-ai/claude-code',
    signIn: 'claude auth login',
  },
  Codex: {
    install: 'npm install -g @openai/codex',
    signIn: 'codex login',
  },
};

export function providerChecked({ status, error }: ProviderState) {
  return !!status || !!error;
}

export function providerUsable({ status, error }: ProviderState) {
  return status?.status === 'ready' && !error;
}

export const providerSlugs: Record<Provider, string> = {
  'Claude Code': 'claude-code',
  Codex: 'codex',
};
export const modeLabels: Record<Session['mode'], string> = {
  'read-only': 'Read-only',
  supervised: 'Workspace edits',
  'accept-edits': 'Accept edits',
  auto: 'Auto',
};

const modeDescriptions: Record<SessionMode, string> = {
  'read-only': 'Reads files in a read-only sandbox.',
  supervised:
    'Edits files in the working directory; asks before commands and risky changes.',
  'accept-edits':
    'Edits files without asking. Commands are not available in this mode.',
  auto: "Lets the agent's own review approve routine actions; refused actions stay visible.",
};

const legacyModes: Record<Provider, SessionMode[]> = {
  'Claude Code': ['read-only'],
  Codex: ['read-only', 'supervised'],
};

export function modeLabel(provider: Provider, mode: SessionMode) {
  return provider === 'Claude Code' && mode === 'read-only'
    ? 'Plan'
    : modeLabels[mode];
}

export function modeDescription(provider: Provider, mode: SessionMode) {
  return provider === 'Claude Code' && mode === 'read-only'
    ? 'Reads and searches files, proposes changes as text.'
    : modeDescriptions[mode];
}

export function providerModes(
  provider: Provider,
  status: ClaudeStatus | CodexStatus | null | undefined,
) {
  return status?.modes.length ? status.modes : legacyModes[provider];
}

const versionedClaudeModel = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/;

export function modelLabel(model: string) {
  const known = modelLabels[model];
  if (known) return known;
  const versioned = versionedClaudeModel.exec(model);
  if (!versioned) return model;
  const [, family, major, minor] = versioned;
  return `${modelLabels[family!]} ${major}.${minor}`;
}

export function providerStatusLabel(provider: Provider, state: ProviderState) {
  if (state.loading) return `Checking ${provider}…`;
  return {
    ready: `${provider} is ready`,
    missing: `${provider} was not found`,
    unauthenticated: `${provider} needs sign-in`,
    unsupported: `This ${provider} version is not supported`,
    error: `${provider} is unavailable`,
  }[state.status?.status ?? 'error'];
}

export const delegationStatusLabels: Record<
  Session['delegations'][number]['status'],
  string
> = {
  pending: 'Awaiting decision',
  declined: 'Declined',
  planning: 'Planning',
  'plan-ready': 'Plan ready',
  running: 'Working',
  completed: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

export function sessionStatusLabel(session: Session) {
  if (
    session.status === 'running' &&
    (session.pendingApprovals.length > 0 ||
      session.delegations.some(
        delegation =>
          delegation.runId === session.runId && delegation.status === 'pending',
      ))
  )
    return 'Needs approval';
  return statusLabels[session.status];
}

export function sessionRoleLabel(session: Session) {
  if (session.parentId) return 'Worker';
  if (session.delegations.length > 0) return 'Orchestrator';
  return '';
}

export function directoryLabel(directory: string) {
  const name =
    directory
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || directory;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    name,
  )
    ? 'Working directory'
    : name;
}
