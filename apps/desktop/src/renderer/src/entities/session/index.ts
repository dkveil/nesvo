import type { ClaudeStatus, CodexStatus, Session } from '@nesvo/contracts';

export type { Session } from '@nesvo/contracts';

export const roleLabels: Record<Session['role'], string> = {
  orchestrator: 'Orkiestrator',
  standalone: 'Samodzielna',
};

const modelLabels: Record<string, string> = {
  default: 'Domyślny',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
};

export const statusLabels: Record<Session['status'], string> = {
  ready: 'Gotowa',
  running: 'Pracuje',
  stopping: 'Zatrzymywanie…',
  completed: 'Ukończona',
  stopped: 'Zatrzymana',
  failed: 'Błąd',
  interrupted: 'Przerwana',
};

export function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : 'Nieznany błąd.';
}

export type Provider = Session['provider'];
export type ProviderState = {
  status: ClaudeStatus | CodexStatus | null;
  loading: boolean;
  error: string;
};
export type ProviderStates = Record<Provider, ProviderState>;

export const providers: Provider[] = ['Claude Code', 'Codex'];
export const modeLabels: Record<Session['mode'], string> = {
  'read-only': 'Analiza · tylko odczyt',
  supervised: 'Praca nadzorowana',
};

export function modelLabel(model: string) {
  return modelLabels[model] ?? model;
}

export function providerStatusLabel(provider: Provider, state: ProviderState) {
  if (state.loading) return `Sprawdzanie ${provider}…`;
  return {
    ready: `${provider} jest gotowy`,
    missing: `Nie znaleziono ${provider}`,
    unauthenticated: `${provider} wymaga logowania`,
    unsupported: `Ta wersja ${provider} nie jest obsługiwana`,
    error: `${provider} jest niedostępny`,
  }[state.status?.status ?? 'error'];
}
