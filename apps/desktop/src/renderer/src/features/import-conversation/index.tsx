import { useEffect, useRef, useState } from 'react';
import type {
  Computer,
  ConversationImportCatalog,
  DesktopApi,
  DesktopSession,
  Provider,
} from '@nesvo/contracts';
import { errorDetail, ProviderGlyph } from '@/entities/session';
import { cn } from '@/shared/lib/cn';
import { formatRelativeTime } from '@/shared/lib/relative-time';
import { useNow } from '@/shared/lib/use-now';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/shared/ui/dialog';
import { ListRow } from '@/shared/ui/list-row';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { SearchField } from '@/shared/ui/search-field';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { StatusMessage } from '@/shared/ui/status-message';
import { Hint } from '@/shared/ui/tooltip';

type Conversation = ConversationImportCatalog['conversations'][number];
type Props = {
  computer: Computer | undefined;
  api: Pick<DesktopApi, 'listConversations' | 'adoptConversation'>;
  disabled: boolean;
  onAdopted: (session: DesktopSession) => void;
};

const conversationKey = (conversation: Conversation) =>
  [conversation.provider, conversation.providerSessionId].join(':');

const folderName = (directory: string) =>
  directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory;

const catalogNotice = ({
  truncated,
  skippedFiles,
}: ConversationImportCatalog) =>
  [
    truncated && 'Showing recent conversations only.',
    !!skippedFiles &&
      `${skippedFiles} unreadable ${skippedFiles === 1 ? 'transcript' : 'transcripts'} skipped.`,
  ]
    .filter(Boolean)
    .join(' ');

export function ImportConversation({
  computer,
  api,
  disabled,
  onAdopted,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const requests = useRef(new Map<string, string>());
  const requestIdFor = (key: string) => {
    const id = requests.current.get(key) ?? crypto.randomUUID();
    requests.current.set(key, id);
    return id;
  };
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!pending) setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled}>
          Import conversation…
        </Button>
      </DialogTrigger>
      {open && (
        <ConversationPicker
          computer={computer}
          api={api}
          pending={pending}
          setPending={setPending}
          requestIdFor={requestIdFor}
          onAdopted={session => {
            setOpen(false);
            onAdopted(session);
          }}
        />
      )}
    </Dialog>
  );
}

function ConversationPicker({
  computer,
  api,
  pending,
  setPending,
  requestIdFor,
  onAdopted,
}: Pick<Props, 'computer' | 'api' | 'onAdopted'> & {
  pending: boolean;
  setPending: (pending: boolean) => void;
  requestIdFor: (key: string) => string;
}) {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<Provider | 'all'>('all');
  const [selectedKey, setSelectedKey] = useState('');
  const [catalog, setCatalog] = useState<ConversationImportCatalog | null>(
    null,
  );
  const [listError, setListError] = useState('');
  const [adoptError, setAdoptError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const available =
    computer?.status === 'connected' &&
    computer.capabilities.includes('conversation-import');
  const now = useNow(60_000);

  useEffect(() => {
    if (!available) return;
    let current = true;
    void api.listConversations().then(
      result => {
        if (!current) return;
        setListError('');
        setCatalog(result);
      },
      error => {
        if (current) setListError(errorDetail(error));
      },
    );
    return () => {
      current = false;
    };
  }, [api, attempt, available]);

  const term = query.trim().toLowerCase();
  const matches = (catalog?.conversations ?? []).filter(
    conversation =>
      (provider === 'all' || conversation.provider === provider) &&
      [conversation.title, conversation.directory].some(value =>
        value.toLowerCase().includes(term),
      ),
  );
  const selected = matches.find(
    conversation => conversationKey(conversation) === selectedKey,
  );

  const adopt = async () => {
    if (!available || !selected || selected.adopted || pending) return;
    const requestId = requestIdFor(conversationKey(selected));
    setAdoptError('');
    setPending(true);
    try {
      onAdopted(
        await api.adoptConversation({
          provider: selected.provider,
          providerSessionId: selected.providerSessionId,
          requestId,
        }),
      );
    } catch (error) {
      setAdoptError(errorDetail(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <DialogContent
      showCloseButton={!pending}
      className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
    >
      <DialogHeader>
        <DialogTitle>Import conversation</DialogTitle>
        <DialogDescription>
          Adopt a CLI conversation on {computer?.name ?? 'this computer'} as a
          read-only session.
        </DialogDescription>
      </DialogHeader>
      {!available ? (
        <StatusMessage tone="warning">
          {computer?.status === 'connected'
            ? 'Update this computer’s Nesvo host and reconnect to import conversations.'
            : 'Connect this computer to import its conversations.'}
        </StatusMessage>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <SearchField
              aria-label="Search CLI conversations"
              placeholder="Search titles and folders"
              maxLength={200}
              value={query}
              onChange={event => setQuery(event.target.value)}
              onClear={() => setQuery('')}
              disabled={pending}
              containerClassName="min-w-40 flex-1"
            />
            <SegmentedControl<Provider | 'all'>
              label="Filter by provider"
              options={[
                { value: 'all', label: 'All' },
                { value: 'Claude Code', label: 'Claude Code' },
                { value: 'Codex', label: 'Codex' },
              ]}
              value={provider}
              onChange={setProvider}
              disabled={pending}
            />
          </div>
          {listError ? (
            <div className="flex items-center justify-between gap-2">
              <StatusMessage tone="error">{listError}</StatusMessage>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setListError('');
                  setAttempt(value => value + 1);
                }}
              >
                Retry
              </Button>
            </div>
          ) : !catalog ? (
            <StatusMessage tone="loading">Finding conversations…</StatusMessage>
          ) : !matches.length ? (
            <StatusMessage>
              {catalog.conversations.length
                ? 'No matching conversations.'
                : 'No CLI conversations found.'}
            </StatusMessage>
          ) : (
            <ScrollArea className={cn('min-w-0', matches.length > 5 && 'h-60')}>
              <div
                className="space-y-1"
                aria-label="CLI conversations"
                role="group"
              >
                {matches.map(conversation => {
                  const key = conversationKey(conversation);
                  return (
                    <ListRow
                      key={key}
                      density="two-line"
                      leading={
                        <ProviderGlyph provider={conversation.provider} />
                      }
                      title={conversation.title}
                      description={
                        <Hint label={conversation.directory}>
                          <span>{folderName(conversation.directory)}</span>
                        </Hint>
                      }
                      meta={
                        <time dateTime={conversation.lastActivityAt}>
                          {formatRelativeTime(conversation.lastActivityAt, now)}
                        </time>
                      }
                      trailing={
                        <>
                          <span className="text-2xs text-muted-foreground">
                            {conversation.messageCount}{' '}
                            {conversation.messageCount === 1
                              ? 'message'
                              : 'messages'}
                          </span>
                          {conversation.adopted && (
                            <Badge size="xs">Adopted</Badge>
                          )}
                        </>
                      }
                      selected={selectedKey === key}
                      mainProps={{
                        'aria-label': [
                          conversation.title,
                          conversation.provider,
                          conversation.directory,
                          ...(conversation.adopted ? ['Adopted'] : []),
                        ].join(', '),
                      }}
                      disabled={pending}
                      onClick={() => {
                        setSelectedKey(key);
                        setAdoptError('');
                      }}
                    />
                  );
                })}
              </div>
            </ScrollArea>
          )}
          {catalog && (catalog.truncated || !!catalog.skippedFiles) && (
            <StatusMessage>{catalogNotice(catalog)}</StatusMessage>
          )}
          {selected && (
            <div className="min-w-0 space-y-1 rounded-control bg-accent px-3 py-2">
              <p className="text-xs font-medium">Preview</p>
              <p className="text-xs whitespace-pre-wrap [overflow-wrap:anywhere] text-muted-foreground">
                {selected.preview}
              </p>
            </div>
          )}
          {adoptError && (
            <StatusMessage tone="error">{adoptError}</StatusMessage>
          )}
          <DialogFooter>
            <Button
              disabled={pending || !selected || selected.adopted}
              onClick={() => void adopt()}
            >
              {pending ? 'Adopting…' : 'Adopt as session'}
            </Button>
          </DialogFooter>
        </>
      )}
    </DialogContent>
  );
}
