import { useEffect, useRef, useState } from 'react';
import { MessageSquareText, Square, SquarePen, X } from 'lucide-react';
import {
  configurationInboxOutputSchema,
  type Computer,
  type ConfigurationInboxContext,
  type ConfigurationInboxSubject,
  type DesktopSession,
} from '@nesvo/contracts';
import {
  errorDetail,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import { ConfigurationChangeRow } from '@/features/configuration/change-row';
import type { HostedConfigurationChange } from '@/features/configuration/use-configuration-changes';
import { ModelPicker } from '@/features/new-thread/model-picker';
import { Button } from '@/shared/ui/button';
import { Chip } from '@/shared/ui/chip';
import {
  Composer,
  ComposerInput,
  ComposerSend,
  ComposerToolbar,
} from '@/shared/ui/composer';
import { IconButton } from '@/shared/ui/icon-button';
import { PanelAction } from '@/shared/ui/panel';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { SidePanel, SidePanelHeader } from '@/shared/ui/side-panel';
import { StatusMessage } from '@/shared/ui/status-message';
import { MessageBody } from '@/widgets/conversation/message-body';

const pendingStatus = { status: null, loading: true, error: '' };
const initial: ProviderStates = {
  'Claude Code': pendingStatus,
  Codex: pendingStatus,
};
const routes = {
  inbox: 'Inbox',
  parent: 'Parent conversation',
  both: 'Inbox and parent conversation',
};

function reply(body: string) {
  try {
    const parsed = configurationInboxOutputSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.reply : '';
  } catch {
    return '';
  }
}

export function InboxAssistant({
  computer,
  subject,
  changes,
  close,
  openSession,
}: {
  computer: Computer;
  subject: ConfigurationInboxSubject | null;
  changes: HostedConfigurationChange[];
  close: () => void;
  openSession: (sessionId: string) => void;
}) {
  const hostId = computer.id;
  const online = computer.status === 'connected';
  const [row, setRow] = useState(subject);
  const [statuses, setStatuses] = useState(initial);
  const [provider, setProvider] = useState<Provider>('Codex');
  const [model, setModel] = useState('');
  const [context, setContext] = useState<ConfigurationInboxContext | null>(
    null,
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<DesktopSession | null>(null);
  const [newChat, setNewChat] = useState(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const composer = useRef<HTMLTextAreaElement>(null);
  const focus = () => composer.current?.focus();
  const currentModel = model || statuses[provider].status?.models[0]?.id || '';
  const running = session?.id === sessionId && session.status === 'running';

  const refreshProvider = async (choice: Provider) => {
    try {
      const status =
        choice === 'Codex'
          ? await window.nesvo.codexStatus(hostId)
          : await window.nesvo.claudeStatus(hostId);
      setStatuses(previous => ({
        ...previous,
        [choice]: { status, loading: false, error: '' },
      }));
    } catch (issue) {
      setStatuses(previous => ({
        ...previous,
        [choice]: { status: null, loading: false, error: errorDetail(issue) },
      }));
    }
  };
  useEffect(() => {
    if (!online) return;
    void window.nesvo
      .codexStatus(hostId)
      .then(status =>
        setStatuses(previous => ({
          ...previous,
          Codex: { status, loading: false, error: '' },
        })),
      )
      .catch(issue => setError(errorDetail(issue)));
    void window.nesvo
      .claudeStatus(hostId)
      .then(status =>
        setStatuses(previous => ({
          ...previous,
          'Claude Code': { status, loading: false, error: '' },
        })),
      )
      .catch(() => undefined);
  }, [hostId, online]);
  useEffect(() => {
    composer.current?.focus();
  }, []);
  useEffect(() => {
    if (!online || !currentModel) return;
    let current = true;
    void window.nesvo.configuration
      .lookup({ subject: row, provider, model: currentModel }, hostId)
      .then(result => {
        if (!current) return;
        setContext(result.context);
        if (!newChat) setSessionId(result.sessionId);
      })
      .catch(issue => {
        if (current) setError(errorDetail(issue));
      });
    return () => {
      current = false;
    };
  }, [hostId, row, provider, currentModel, online, newChat]);
  useEffect(() => {
    if (!sessionId || !online) return;
    let current = true;
    const load = () =>
      void window.nesvo
        .getSession({ sessionId, limit: 100 }, hostId)
        .then(value => {
          if (current)
            setSession(previous =>
              previous?.id === value.id && previous.revision > value.revision
                ? previous
                : value,
            );
        })
        .catch(issue => {
          if (current) setError(errorDetail(issue));
        });
    load();
    const unsubscribe = window.nesvo.subscribe(event => {
      if (
        (event.type === 'session-changed' ||
          event.type === 'session-message-upserted') &&
        event.session.hostId === hostId &&
        event.session.id === sessionId
      )
        load();
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [hostId, online, sessionId]);

  const startNew = () => {
    setNewChat(true);
    setSessionId(null);
    setError('');
    focus();
  };
  const send = async () => {
    if (!text.trim() || pending || running || !online || !currentModel) return;
    setPending(true);
    setError('');
    try {
      const sent = await window.nesvo.configuration.send(
        {
          subject: row,
          provider,
          model: currentModel,
          text,
          newChat,
          messageId: crypto.randomUUID(),
        },
        hostId,
      );
      setSessionId(sent.sessionId);
      setText('');
      setNewChat(false);
    } catch (issue) {
      setError(errorDetail(issue));
    } finally {
      setPending(false);
      focus();
    }
  };
  const stop = () => {
    if (!sessionId || !session?.runId) return;
    void window.nesvo
      .stopRun({ sessionId, runId: session.runId }, hostId)
      .catch(issue => setError(errorDetail(issue)));
  };
  const ownChanges = changes.filter(
    change =>
      change.hostId === hostId &&
      change.source.kind === 'assistant' &&
      change.source.sessionId === sessionId,
  );
  return (
    <SidePanel
      kind="assistant"
      aria-label="Inbox assistant"
      resizeLabel="Resize Inbox assistant"
      onEscape={close}
    >
      <SidePanelHeader
        titleBar={false}
        icon={MessageSquareText}
        title="Inbox assistant"
        meta={computer.name}
        onClose={close}
        closeLabel="Close Inbox assistant"
      >
        {sessionId && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openSession(sessionId)}
          >
            Open session
          </Button>
        )}
        <PanelAction
          label="New chat"
          disabled={pending || running}
          onClick={startNew}
        >
          <SquarePen />
        </PanelAction>
      </SidePanelHeader>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="space-y-4 px-4 py-3">
          {row && context && (
            <section className="space-y-1">
              <h3 className="text-ui font-medium">Why this is here</h3>
              <p className="text-xs text-muted-foreground">
                {context.explanation}
              </p>
              {context.route && (
                <p className="text-xs text-muted-foreground">
                  Delivery · {routes[context.route]}
                </p>
              )}
              {context.rule && (
                <p className="text-xs text-muted-foreground">
                  {context.rule.name} · {context.rule.scope} rule · Current
                  match {context.rule.current}
                </p>
              )}
            </section>
          )}
          {session?.id === sessionId &&
            session.messages.map(message => {
              const body =
                message.author === 'operator'
                  ? message.body
                  : reply(message.body);
              return body ? (
                <MessageBody key={message.id} body={body} className="text-ui" />
              ) : null;
            })}
          {ownChanges.map(change => (
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
          {session?.id === sessionId && session.error && (
            <StatusMessage tone="error">{session.error}</StatusMessage>
          )}
          {error && <StatusMessage tone="error">{error}</StatusMessage>}
          {!online && (
            <StatusMessage>
              Reconnect to {computer.name} to use the assistant.
            </StatusMessage>
          )}
        </div>
      </ScrollArea>
      <form
        className="px-3 pb-3 pt-1"
        onSubmit={event => {
          event.preventDefault();
          void send();
        }}
      >
        <Composer aria-label="Inbox assistant composer">
          <ComposerInput
            ref={composer}
            aria-label="Message to Inbox assistant"
            value={text}
            maxLength={8000}
            placeholder="Ask about Inbox delivery…"
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <ComposerToolbar
            start={
              <>
                <ModelPicker
                  compact
                  showEffort={false}
                  provider={provider}
                  model={currentModel}
                  effort=""
                  statuses={statuses}
                  disabled={pending || running || !online}
                  onRefreshProvider={choice => void refreshProvider(choice)}
                  onChange={(choice, choiceModel) => {
                    setProvider(choice);
                    setModel(choiceModel);
                    startNew();
                  }}
                />
                {row && (
                  <Chip
                    size="sm"
                    icon={<X />}
                    aria-label="Remove Inbox item context"
                    onClick={() => {
                      setRow(null);
                      setContext(null);
                      startNew();
                    }}
                  >
                    Inbox item
                  </Chip>
                )}
              </>
            }
            end={
              running ? (
                <IconButton label="Stop Inbox assistant" onClick={stop}>
                  <Square />
                </IconButton>
              ) : (
                <ComposerSend
                  label="Send to Inbox assistant"
                  pending={pending}
                  disabled={!text.trim() || !online || !currentModel}
                />
              )
            }
          />
        </Composer>
      </form>
    </SidePanel>
  );
}
