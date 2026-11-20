import { useEffect, useState } from 'react';
import {
  sessionMessageWatcherDefinitionSchema,
  type SessionMessageWatcherInput,
  type SessionMessageWatcherReply,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';
import { PanelBody } from '@/shared/ui/panel';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { SettingsDrawer } from './settings-drawer';
import { StatusMessage } from '@/shared/ui/status-message';
import { Textarea } from '@/shared/ui/textarea';

type Listing = Extract<SessionMessageWatcherReply, { action: 'read' }>;
type Review = Extract<SessionMessageWatcherReply, { action: 'inspect' }>;

export function SessionWatcherSettings({
  hostId,
  ready,
  defaultSession,
}: {
  hostId: string;
  ready: boolean;
  defaultSession?: { id: string; directory: string };
}) {
  const [data, setData] = useState<Listing>();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(false);
  const [source, setSource] = useState('');
  const [review, setReview] = useState<Review>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [remove, setRemove] = useState<Listing['watchers'][number]>();
  useEffect(() => {
    if (!ready) return;
    let current = true;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const state = await window.nesvo.sessionMessageWatchers(
          { action: 'read' },
          hostId,
        );
        if (current && state.action === 'read') setData(state);
      } catch (reason) {
        if (current) setError(errorDetail(reason));
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 3000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [hostId, ready]);
  const execute = async (input: SessionMessageWatcherInput) => {
    setBusy(true);
    setError('');
    try {
      const reply = await window.nesvo.sessionMessageWatchers(input, hostId);
      if (reply.action === 'inspect') setReview(reply);
      else {
        const current = await window.nesvo.sessionMessageWatchers(
          { action: 'read' },
          hostId,
        );
        if (current.action === 'read') setData(current);
      }
      return true;
    } catch (reason) {
      setError(errorDetail(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    try {
      const parsed = sessionMessageWatcherDefinitionSchema.parse(
        JSON.parse(source),
      );
      const ok = await execute(
        review
          ? {
              action: 'approve',
              actionId: crypto.randomUUID(),
              definition: parsed,
              revision: review.revision,
            }
          : { action: 'inspect', definition: parsed },
      );
      if (review && ok) setOpen(false);
      if (!ok) setReview(undefined);
    } catch (reason) {
      setError(errorDetail(reason));
    }
  };
  return (
    <div className="relative">
      <SettingsSection
        title="Session message watchers"
        action={
          ready &&
          data && (
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setHistory(true)}
              >
                History
              </Button>
              <Dialog
                open={open}
                onOpenChange={next => {
                  if (busy) return;
                  setOpen(next);
                  setError('');
                  setReview(undefined);
                  setSource(
                    JSON.stringify(
                      {
                        version: 1,
                        name: '',
                        source: '',
                        directory: defaultSession?.directory ?? '',
                        command: {
                          executable: '',
                          argv: [],
                          timeoutMs: 300000,
                        },
                        destination: 'session',
                        defaultSessionId: defaultSession?.id ?? '',
                        allowedSessionIds: defaultSession
                          ? [defaultSession.id]
                          : [],
                        kinds: ['notify'],
                      },
                      null,
                      2,
                    ),
                  );
                }}
              >
                <DialogTrigger asChild>
                  <Button variant="secondary" size="xs">
                    Add watcher
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-xl">
                  <DialogHeader>
                    <DialogTitle>
                      {review
                        ? 'Review watcher command'
                        : 'Add session message watcher'}
                    </DialogTitle>
                    <DialogDescription>
                      {review
                        ? review.cwd
                        : 'The approved command emits one JSON event per line. Start it explicitly when you need it.'}
                    </DialogDescription>
                  </DialogHeader>
                  {review ? (
                    <CodeBlock
                      code={JSON.stringify(
                        {
                          executable: review.executable,
                          argv: review.argv,
                          revision: review.revision,
                        },
                        null,
                        2,
                      )}
                      wrap
                    />
                  ) : (
                    <Field
                      id="watcher-definition"
                      label="Watcher definition"
                      hint="Use an absolute executable, fixed arguments and the session IDs it may reach."
                    >
                      <Textarea
                        id="watcher-definition"
                        rows={13}
                        value={source}
                        onChange={event => setSource(event.target.value)}
                        className="resize-none font-mono"
                      />
                    </Field>
                  )}
                  {error && <StatusMessage tone="error">{error}</StatusMessage>}
                  <DialogFooter>
                    <DialogCancel disabled={busy} />
                    {review && (
                      <Button
                        size="lg"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setReview(undefined)}
                      >
                        Back
                      </Button>
                    )}
                    <Button
                      size="lg"
                      disabled={busy}
                      onClick={() => void submit()}
                    >
                      {review ? 'Approve watcher' : 'Review command'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          )
        }
      >
        {!ready ? (
          <SettingsRow
            title="Watcher lease unavailable"
            description="Connect a computer that supports leased session watchers."
          />
        ) : !data ? (
          <StatusMessage tone={error ? 'error' : 'loading'}>
            {error || 'Loading watchers…'}
          </StatusMessage>
        ) : (
          <>
            {!data.watchers.length && <SettingsRow title="No watchers" />}
            {data.watchers.map(watcher => (
              <SettingsRow
                key={watcher.id}
                title={watcher.name}
                description={`${{ idle: 'Ready', running: 'Running', held: 'Held' }[watcher.state]} · ${watcher.delivered} accepted · ${watcher.invalidLines} invalid${watcher.detail ? ' · ' + watcher.detail : ''}`}
              >
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void execute({
                      action: watcher.state === 'running' ? 'stop' : 'start',
                      actionId: crypto.randomUUID(),
                      watcherId: watcher.id,
                    })
                  }
                >
                  {watcher.state === 'running' ? 'Stop' : 'Start'}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setRemove(watcher)}
                >
                  Revoke
                </Button>
              </SettingsRow>
            ))}
            {error && !open && (
              <StatusMessage tone="error">{error}</StatusMessage>
            )}
          </>
        )}
      </SettingsSection>
      {history && (
        <SettingsDrawer
          title="Watcher history"
          closeLabel="Close watcher history"
          resizeLabel="Resize watcher history"
          onClose={() => setHistory(false)}
        >
          <PanelBody>
            {data?.history.length ? (
              data.history.map(entry => (
                <SettingsRow
                  key={entry.id}
                  title={
                    {
                      approve: 'Approved',
                      start: 'Started',
                      stop: 'Stopped',
                      revoke: 'Revoked',
                      held: 'Held',
                    }[entry.action]
                  }
                  description={
                    entry.detail ?? new Date(entry.at).toLocaleString()
                  }
                />
              ))
            ) : (
              <SettingsRow title="No decisions yet" />
            )}
          </PanelBody>
        </SettingsDrawer>
      )}
      <ConfirmDialog
        open={!!remove}
        onOpenChange={next => {
          if (!next) setRemove(undefined);
        }}
        title="Revoke watcher?"
        description="The host stops the command and withdraws its delivery grant."
        confirmLabel="Revoke"
        onConfirm={() =>
          remove
            ? execute({
                action: 'revoke',
                actionId: crypto.randomUUID(),
                watcherId: remove.id,
              })
            : true
        }
      >
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
      </ConfirmDialog>
    </div>
  );
}
