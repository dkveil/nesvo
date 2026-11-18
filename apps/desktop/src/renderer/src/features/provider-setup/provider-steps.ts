import {
  providerCommands,
  type Provider,
  type ProviderState,
} from '@/entities/session';
import type { StatusTone } from '@/shared/ui/status-message';

type Step = { label: string; code: string };

export function providerSummary(
  provider: Provider,
  { status, error, loading }: ProviderState,
): { tone: StatusTone; label: string } {
  if (loading) return { tone: 'loading', label: `Checking ${provider}…` };
  if (error) return { tone: 'error', label: 'Could not check' };
  const version = status?.version ? ` · ${status.version}` : '';
  switch (status?.status) {
    case 'ready':
      return { tone: 'success', label: `Detected${version}` };
    case 'unauthenticated':
      return { tone: 'warning', label: `Detected${version} · Not signed in` };
    case 'unsupported':
      return { tone: 'warning', label: `Detected${version} · Update needed` };
    case 'missing':
      return { tone: 'warning', label: 'Not installed' };
    default:
      return { tone: 'error', label: 'Unavailable' };
  }
}

export function providerSteps(
  provider: Provider,
  { status }: ProviderState,
): Step[] {
  const { install, signIn } = providerCommands[provider];
  const installStep = { label: 'Install', code: install };
  const updateStep = { label: 'Update', code: install };
  const signInStep = { label: 'Sign in', code: signIn };
  switch (status?.status) {
    case 'ready':
      return [];
    case 'unauthenticated':
      return [signInStep];
    case 'unsupported':
      return [updateStep, signInStep];
    default:
      return [installStep, signInStep];
  }
}
