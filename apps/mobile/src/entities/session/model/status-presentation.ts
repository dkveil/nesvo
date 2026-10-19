import type { SessionStatus, SessionStatusSource } from './session';

export function statusNeedsAttention(status: SessionStatus): boolean {
  return status === 'question' || status === 'blocked' || status === 'failed';
}

/** Activity reports terminal I/O, not an agent's internal progress. */
export function sessionStatusLabel(status: SessionStatus, source?: SessionStatusSource): string {
  if (source === 'activity' && status === 'working') return 'Otwarta';
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
    return status === 'working' ? 'Ostatnio używany terminal' : 'Brak sygnału pracy agenta';
  if (source === 'screen') return 'Stan przybliżony, wywnioskowany z treści terminala';
  if (source === 'hook') return 'Stan potwierdzony zdarzeniem agenta';
  if (source === 'process') return 'Stan procesu na komputerze';
  return 'Brak informacji o stanie agenta';
}
