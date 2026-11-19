import { useEffect, useState } from 'react';
import {
  externalSessionRuleInputSchema,
  type ExternalInboxDevice,
  type ExternalSessionSettings as Settings,
  type ExternalSessionSettingsInput,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
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
import { Input } from '@/shared/ui/input';
import { PanelBody } from '@/shared/ui/panel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { SidePanel, SidePanelHeader } from '@/shared/ui/side-panel';
import { StatusMessage } from '@/shared/ui/status-message';
import { ingressStatus } from '@/features/session-ingress/use-session-ingress-history';

const routes = {
  session: 'Session',
  inbox: 'Ask in Inbox',
  reject: 'Reject',
} as const;
const kinds = {
  both: ['send', 'notify'],
  send: ['send'],
  notify: ['notify'],
} as const;

export function ExternalSessionSettings({
  hostId,
  ready,
  sessions,
}: {
  hostId: string;
  ready: boolean;
  sessions: { id: string; title: string }[];
}) {
  const [data, setData] = useState<Settings>();
  const [devices, setDevices] = useState<ExternalInboxDevice[]>([]);
  const [source, setSource] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [destination, setDestination] = useState<keyof typeof routes>('inbox');
  const [kind, setKind] = useState<keyof typeof kinds>('both');
  const [sessionId, setSessionId] = useState('any');
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revoke, setRevoke] = useState<Settings['routes'][number]>();
  useEffect(() => {
    if (!ready) return;
    let current = true;
    void Promise.all([
      window.nesvo.externalSessionMessages({ action: 'read' }, hostId),
      window.nesvo.listExternalInboxDevices(hostId),
    ]).then(
      ([settings, recognized]) => {
        if (!current) return;
        setData(settings);
        setDevices(recognized);
      },
      reason => {
        if (current) setError(errorDetail(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [hostId, ready]);
  const execute = async (input: ExternalSessionSettingsInput) => {
    setBusy(true);
    setError('');
    try {
      setData(await window.nesvo.externalSessionMessages(input, hostId));
      return true;
    } catch (reason) {
      setError(errorDetail(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const parsed = externalSessionRuleInputSchema.safeParse({
    deviceId,
    source,
    destination,
    kinds: [...kinds[kind]],
    sessions: sessionId === 'any' ? [] : [sessionId],
  });
  return (
    <div className="relative">
      <SettingsSection
        title="External messages"
        action={
          ready &&
          data && (
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setHistory(true);
                  void execute({ action: 'read' });
                }}
              >
                History
              </Button>
              <Dialog
                open={open}
                onOpenChange={next => {
                  if (busy) return;
                  setOpen(next);
                  setError('');
                  setDeviceId(devices[0]?.id ?? '');
                  setSource('');
                }}
              >
                <DialogTrigger asChild>
                  <Button
                    variant="secondary"
                    size="xs"
                    disabled={!devices.length}
                  >
                    Add source
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add external message source</DialogTitle>
                    <DialogDescription>
                      Grant a paired device one exact source label and choose a
                      route.
                    </DialogDescription>
                  </DialogHeader>
                  <Field id="ingress-device" label="Device">
                    <Select value={deviceId} onValueChange={setDeviceId}>
                      <SelectTrigger id="ingress-device">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {devices.map(device => (
                          <SelectItem key={device.id} value={device.id}>
                            {device.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field id="ingress-source" label="Source label">
                    <Input
                      id="ingress-source"
                      value={source}
                      maxLength={64}
                      onChange={event => setSource(event.target.value)}
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field id="ingress-kind" label="Permission">
                      <Select
                        value={kind}
                        onValueChange={value =>
                          setKind(value as keyof typeof kinds)
                        }
                      >
                        <SelectTrigger id="ingress-kind">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="both">Send and notify</SelectItem>
                          <SelectItem value="send">Send</SelectItem>
                          <SelectItem value="notify">Notify</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field id="ingress-route" label="Route">
                      <Select
                        value={destination}
                        onValueChange={value =>
                          setDestination(value as keyof typeof routes)
                        }
                      >
                        <SelectTrigger id="ingress-route">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(routes).map(([key, label]) => (
                            <SelectItem key={key} value={key}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <Field id="ingress-session" label="Target restriction">
                    <Select value={sessionId} onValueChange={setSessionId}>
                      <SelectTrigger id="ingress-session">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">Any active session</SelectItem>
                        {sessions.slice(0, 80).map(session => (
                          <SelectItem key={session.id} value={session.id}>
                            {session.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  {error && <StatusMessage tone="error">{error}</StatusMessage>}
                  <DialogFooter>
                    <DialogCancel disabled={busy} />
                    <Button
                      size="lg"
                      disabled={busy || !parsed.success}
                      onClick={() => {
                        if (parsed.success)
                          void execute({
                            action: 'save-route',
                            actionId: crypto.randomUUID(),
                            rule: parsed.data,
                          }).then(ok => {
                            if (ok) setOpen(false);
                          });
                      }}
                    >
                      Save source
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
            title="Unavailable"
            description="Connect a computer with external session messaging."
          />
        ) : !data ? (
          <StatusMessage tone={error ? 'error' : 'loading'}>
            {error || 'Loading sources…'}
          </StatusMessage>
        ) : (
          <>
            {!devices.length && (
              <SettingsRow
                title="No paired devices"
                description="Pair an Inbox device in Settings › Devices and grant it a message scope here."
              />
            )}
            {devices.length > 0 && !data.routes.length && (
              <SettingsRow title="No message sources" />
            )}
            {data.routes.map(rule => (
              <SettingsRow
                key={rule.id}
                title={rule.source}
                description={`${devices.find(device => device.id === rule.deviceId)?.name ?? 'Revoked device'} · ${routes[rule.destination]}`}
              >
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setRevoke(rule)}
                >
                  Revoke
                </Button>
              </SettingsRow>
            ))}
            <SettingsRow
              title="Coordinator events and wake unavailable"
              description="This host supports history, Inbox decisions and operator-initiated delivery."
            />
          </>
        )}
      </SettingsSection>
      {history && (
        <SidePanel
          kind="details"
          resizeLabel="Resize external message history"
          focusOnOpen
          onEscape={() => setHistory(false)}
          className="min-[1200px]:absolute min-[1200px]:inset-y-0 min-[1200px]:right-0"
        >
          <SidePanelHeader
            title="External message history"
            closeLabel="Close external message history"
            onClose={() => setHistory(false)}
            titleBar={false}
          />
          <PanelBody className="min-h-40">
            {(data?.messages ?? []).map(({ receipt }) => (
              <SettingsRow
                key={receipt.id}
                title={receipt.source}
                description={`${ingressStatus[receipt.status]} · ${receipt.reason ?? new Date(receipt.at).toLocaleString()}`}
              />
            ))}
            {(data?.rulesHistory ?? []).map(entry => (
              <SettingsRow
                key={entry.actionId}
                title={
                  {
                    'save-route': 'Source saved',
                    'revoke-route': 'Source revoked',
                    continue: 'Queued after review',
                    dismiss: 'Message dismissed',
                  }[entry.action]
                }
                description={new Date(entry.at).toLocaleString()}
              />
            ))}
            {!data?.messages.length && !data?.rulesHistory.length && (
              <SettingsRow title="No messages or decisions yet" />
            )}
          </PanelBody>
        </SidePanel>
      )}
      <ConfirmDialog
        open={!!revoke}
        onOpenChange={value => {
          if (!value) setRevoke(undefined);
        }}
        title="Revoke this message source?"
        description="The device will lose this source’s session messaging scope."
        confirmLabel="Revoke"
        onConfirm={() =>
          revoke
            ? execute({
                action: 'revoke-route',
                actionId: crypto.randomUUID(),
                routeId: revoke.id,
              })
            : true
        }
      >
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
      </ConfirmDialog>
    </div>
  );
}
