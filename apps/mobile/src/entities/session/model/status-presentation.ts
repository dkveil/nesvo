import type { SessionStatus, SessionStatusSource } from './session';

export function statusNeedsAttention(status: SessionStatus): boolean {
  return status === 'question' || status === 'blocked' || status === 'failed';
}

/** Activity reports terminal I/O, not an agent's internal progress. */
export function sessionStatusLabel(status: SessionStatus, source?: SessionStatusSource): string {
  if (source === 'activity' && status === 'working') return 'Aktywność';
  if (source === 'activity' && status === 'idle') return 'Cisza';
  return {
    working: 'Pracuje',
    idle: 'Bezczynna',
    done: 'Zakończona',
    blocked: 'Blokada',
    question: 'Pytanie',
    failed: 'Błąd',
    unknown: 'Nieznany',
  }[status];
}

export function sessionStatusDetail(status: SessionStatus, source?: SessionStatusSource): string {
  if (source === 'activity')
    return status === 'working' ? 'Nowe wyjście terminala' : 'Brak nowego wyjścia terminala';
  if (source === 'screen') return 'Stan przybliżony, wywnioskowany z treści terminala';
  if (source === 'process') return 'Stan procesu na komputerze';
  return 'Brak informacji o stanie agenta';
}
