import { useEffect, useId, useState } from 'react';
import { MessageSquareText, Square } from 'lucide-react';
import {
  providerSchema,
  setupAssistantOutputSchema,
  type Computer,
  type DesktopSession,
  type Provider,
} from '@nesvo/contracts';
import { errorDetail, type ProviderStates } from '@/entities/session';
import { ConfigurationChangeRow } from '@/features/configuration/change-row';
import { useConfigurationChanges } from '@/features/configuration/use-configuration-changes';
import {
  Composer,
  ComposerInput,
  ComposerSend,
  ComposerToolbar,
} from '@/shared/ui/composer';
import { Field } from '@/shared/ui/field';
import { IconButton } from '@/shared/ui/icon-button';
import { PanelBody } from '@/shared/ui/panel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { SidePanel, SidePanelHeader } from '@/shared/ui/side-panel';
import { StatusMessage } from '@/shared/ui/status-message';
import { MessageBody } from '@/widgets/conversation/message-body';

function reply(body: string) {
  try {
    const result = setupAssistantOutputSchema.safeParse(JSON.parse(body));
    return result.success ? result.data.reply : '';
  } catch {
    return '';
  }
}

export function SetupAssistant({
  computer,
  statuses,
  directory,
  close,
}: {
  computer: Computer;
  statuses?: ProviderStates;
  directory?: string;
  close: () => void;
}) {
  const id = useId();
  const { instanceId, id: hostId } = computer;
  const online = computer.status === 'connected';
  const ready = online && computer.capabilities.includes('setup-assistant-v1');
  const [provider, setProvider] = useState<Provider>();
  const [model, setModel] = useState('');
  const [text, setText] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<DesktopSession>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const changes = useConfigurationChanges([computer]);
  const running = sessionId === session?.id && session?.status === 'running';
  const display = sessionId === session?.id ? session : undefined;
  const models = provider ? (statuses?.[provider].status?.models ?? []) : [];

  useEffect(() => {
    if (!provider || !model || !ready || !instanceId) return;
    let current = true;
    void window.nesvo
      .setupAssistant(
        { action: 'read', instanceId, provider, model, directory },
        hostId,
      )
      .then(result => {
        if (!current) return;
        if (!result.ok) return setError(result.message);
        setSessionId(result.sessionId);
      })
      .catch(issue => current && setError(errorDetail(issue)));
    return () => {
      current = false;
    };
  }, [provider, model, ready, instanceId, hostId, directory]);

  useEffect(() => {
    if (!sessionId || !online) return;
    let current = true;
    const load = () =>
      void window.nesvo
        .getSession({ sessionId, limit: 80 }, hostId)
        .then(value => {
          if (current)
            setSession(previous =>
              previous?.id === value.id && previous.revision > value.revision
                ? previous
                : value,
            );
        })
        .catch(issue => current && setError(errorDetail(issue)));
    load();
    const unsubscribe = window.nesvo.subscribe(event => {
      if (
        (event.type === 'session-changed' ||
          event.type === 'session-message-upserted') &&
        event.session.id === sessionId &&
        event.session.hostId === hostId
      )
        load();
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [hostId, sessionId, online]);

  const send = async () => {
    if (
      !ready ||
      !instanceId ||
      !provider ||
      !model ||
      !text.trim() ||
      running ||
      pending
    )
      return;
    setPending(true);
    setError('');
    try {
      const result = await window.nesvo.setupAssistant(
        {
          action: 'send',
          instanceId,
          provider,
          model,
          directory,
          text,
          messageId: crypto.randomUUID(),
        },
        hostId,
      );
      if (!result.ok) throw new Error(result.message);
      setSessionId(result.sessionId);
      setText('');
    } catch (issue) {
      setError(errorDetail(issue));
    } finally {
      setPending(false);
    }
  };

  return (
    <SidePanel
      kind="assistant"
      aria-label="Setup assistant"
      resizeLabel="Resize setup assistant"
      focusOnOpen
      onEscape={close}
      className="min-h-80 max-h-[min(34rem,60dvh)]"
    >
      <SidePanelHeader
        titleBar={false}
        title="Setup assistant"
        icon={MessageSquareText}
        meta={computer.name}
        onClose={close}
        closeLabel="Close setup assistant"
      />
      <PanelBody className="max-h-96 space-y-3 px-3 py-2">
        {!ready && (
          <StatusMessage>
            {online
              ? 'Update this computer’s host to use its setup assistant.'
              : 'Offline snapshot. Reconnect to send a message.'}
          </StatusMessage>
        )}
        {display?.messages.map(message => {
          const body =
            message.author === 'operator' ? message.body : reply(message.body);
          return body ? (
            <MessageBody key={message.id} body={body} className="text-ui" />
          ) : null;
        })}
        {changes
          .filter(
            change =>
              change.source.kind === 'assistant' &&
              change.source.sessionId === sessionId,
          )
          .map(change => (
            <ConfigurationChangeRow
              key={change.id}
              change={change}
              computer={computer.name}
              online={online}
            />
          ))}
        {running && (
          <StatusMessage tone="loading">Preparing a reply…</StatusMessage>
        )}
        {display?.error && (
          <StatusMessage tone="error">{display.error}</StatusMessage>
        )}
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
      </PanelBody>
      <form
        className="space-y-2 px-3 pb-3 pt-1"
        onSubmit={event => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          <Field id={id + '-provider'} label="Provider">
            <Select
              value={provider ?? ''}
              disabled={!ready || running || pending}
              onValueChange={value => {
                setProvider(providerSchema.parse(value));
                setModel('');
                setSessionId(null);
              }}
            >
              <SelectTrigger id={id + '-provider'}>
                <SelectValue placeholder="Choose provider" />
              </SelectTrigger>
              <SelectContent>
                {providerSchema.options.map(choice => (
                  <SelectItem key={choice} value={choice}>
                    {choice}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id={id + '-model'} label="Model">
            <Select
              value={model}
              disabled={!provider || !ready || running || pending}
              onValueChange={value => {
                setModel(value);
                setSessionId(null);
              }}
            >
              <SelectTrigger id={id + '-model'}>
                <SelectValue placeholder="Choose model" />
              </SelectTrigger>
              <SelectContent>
                {!models.some(item => item.id === 'default') && (
                  <SelectItem value="default">Provider default</SelectItem>
                )}
                {models.map(item => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Composer aria-label="Setup assistant composer">
          <ComposerInput
            aria-label="Message to setup assistant"
            value={text}
            maxLength={8000}
            placeholder="Ask about this computer’s setup…"
            onChange={event => setText(event.target.value)}
          />
          <ComposerToolbar
            end={
              running ? (
                <IconButton
                  label="Stop setup assistant"
                  onClick={() => {
                    if (session?.runId)
                      void window.nesvo
                        .stopRun(
                          { sessionId: session.id, runId: session.runId },
                          hostId,
                        )
                        .catch(issue => setError(errorDetail(issue)));
                  }}
                >
                  <Square />
                </IconButton>
              ) : (
                <ComposerSend
                  label="Send to setup assistant"
                  pending={pending}
                  disabled={!ready || !text.trim() || !provider || !model}
                />
              )
            }
          />
        </Composer>
      </form>
    </SidePanel>
  );
}
