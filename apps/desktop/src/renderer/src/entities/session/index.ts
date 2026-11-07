import type { Session } from '@nesvo/contracts';

export type { Session } from '@nesvo/contracts';

export const roleLabels: Record<Session['role'], string> = {
  orchestrator: 'Orkiestrator',
  standalone: 'Samodzielna',
};

export const modelLabels: Record<Session['model'], string> = {
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
