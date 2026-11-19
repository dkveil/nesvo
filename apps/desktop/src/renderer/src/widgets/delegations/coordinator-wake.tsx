import { useState } from 'react';
import type { CoordinatorWakeState } from '@nesvo/contracts';
import { errorDetail, type Session } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { SettingsRow } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';
import { Switch } from '@/shared/ui/switch';

import type { useCoordinatorWake } from './use-coordinator-wake';

export function CoordinatorWakeSetting({
  label,
  control,
  id,
}: {
  label: string;
  control: ReturnType<typeof useCoordinatorWake>;
  id: string;
}) {
  const { state, pending, save, error } = control;
  return (
    <SettingsRow
      title={<label htmlFor={id}>{label}</label>}
      description={
        error ? (
          <StatusMessage tone="error">{error}</StatusMessage>
        ) : state?.sessionId && state.enabled && !state.effective ? (
          'Automatic updates are unavailable under the current computer policy.'
        ) : undefined
      }
    >
      <Switch
        id={id}
        checked={state?.enabled ?? false}
        disabled={!state || pending}
        onCheckedChange={value => void save(value)}
      />
    </SettingsRow>
  );
}

const wakeReasons = {
  restart: null,
  stopped: 'Updates paused after Stop.',
  failed: 'The previous update could not complete.',
  thread: 'The recorded provider conversation needs attention.',
  mode: 'This permission mode requires a manual start.',
  hold: 'A decision or a paused update is waiting.',
  folder: 'Waiting for the session folder.',
  rate: 'Waiting for the update limit to reset.',
  budget: 'Waiting for the budget to allow another turn.',
  overflow:
    'Some child updates were omitted. Review the batch before continuing.',
} satisfies Record<NonNullable<CoordinatorWakeState['reason']>, string | null>;

export function CoordinatorWakeFooter({
  session,
  children,
  control,
}: {
  session: Session;
  children: Session[];
  control: ReturnType<typeof useCoordinatorWake>;
}) {
  const { state, resume } = control;
  const [attempt, setAttempt] = useState<{
    batchId: string;
    messageId: string;
  } | null>(null);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState('');
  const busy = session.status === 'running' || session.status === 'stopping';
  const waiting =
    !busy &&
    children.some(
      child =>
        child.status === 'running' ||
        child.status === 'stopping' ||
        child.queue.some(entry => !entry.held),
    );
  if (!state || (!state.pending && (!state.effective || !waiting))) return null;
  const title =
    state.reason === 'restart'
      ? 'Continue after restart'
      : state.pending
        ? 'Updates waiting'
        : 'Waiting for children';
  const submit = async () => {
    if (!state.batchId) return;
    const next =
      attempt?.batchId === state.batchId
        ? attempt
        : { batchId: state.batchId, messageId: crypto.randomUUID() };
    setAttempt(next);
    setResuming(true);
    setError('');
    try {
      await resume(next.messageId);
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setResuming(false);
    }
  };
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t px-2 py-1.5 text-xs text-muted-foreground"
      data-coordinator-wake={state.reason ?? title}
    >
      <span>{title}</span>
      {state.reason && wakeReasons[state.reason] && (
        <span>{wakeReasons[state.reason]}</span>
      )}
      {state.continueRequired && (
        <Button
          size="xs"
          disabled={busy || resuming || !state.batchId}
          onClick={() => void submit()}
        >
          Continue
        </Button>
      )}
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
    </div>
  );
}
