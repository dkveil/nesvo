import type {
  ClaudeStatus,
  CodexStatus,
  DesktopSession as Session,
} from '@nesvo/contracts';

export type { DesktopSession as Session } from '@nesvo/contracts';
export { ProviderGlyph } from './provider-glyph';
export { effortLabel } from './effort-label';

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

export const statusLabels: Record<Session['status'], string> = {
  ready: 'Ready',
  running: 'Working',
  stopping: 'Stopping…',
  completed: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

export function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error.';
}

export type Provider = Session['provider'];
export type ProviderState = {
  status: ClaudeStatus | CodexStatus | null;
  loading: boolean;
  error: string;
};
export type ProviderStates = Record<Provider, ProviderState>;

export const providers: Provider[] = ['Claude Code', 'Codex'];
export const providerMarks: Record<Provider, string> = {
  'Claude Code': 'CL',
  Codex: 'CX',
};
export const modeLabels: Record<Session['mode'], string> = {
  'read-only': 'Read-only',
  supervised: 'Workspace edits',
};

export function modelLabel(model: string) {
  return modelLabels[model] ?? model;
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
