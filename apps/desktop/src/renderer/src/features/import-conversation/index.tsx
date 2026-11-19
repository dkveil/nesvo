import { useEffect, useRef, useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import type {
  Computer,
  ConversationIdentity,
  ConversationImportCatalog,
  DesktopApi,
  DesktopSession,
  Provider,
  ProviderProfile,
} from '@nesvo/contracts';
import { errorDetail, ProviderGlyph } from '@/entities/session';
import { formatRelativeTime } from '@/shared/lib/relative-time';
import { useNow } from '@/shared/lib/use-now';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { EmptyState } from '@/shared/ui/empty-state';
import { ListRow } from '@/shared/ui/list-row';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { SearchField } from '@/shared/ui/search-field';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { SkeletonList } from '@/shared/ui/skeleton';
import { StatusMessage } from '@/shared/ui/status-message';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { Hint } from '@/shared/ui/tooltip';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  computer: Computer | undefined;
  profiles: ProviderProfile[];
  initialProfileId?: string | null;
  api: Pick<DesktopApi, 'listConversations' | 'adoptConversation'>;
  onAdopted: (session: DesktopSession) => void;
  initialSelection?: ConversationIdentity;
};

const conversationKey = (conversation: ConversationIdentity) =>
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
  open,
  onOpenChange,
  computer,
  profiles,
  initialProfileId,
  api,
  onAdopted,
  initialSelection,
}: Props) {
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
        if (!pending) onOpenChange(next);
      }}
    >
      {open && (
        <ConversationPicker
          computer={computer}
          profiles={profiles}
          initialProfileId={initialProfileId}
          api={api}
          pending={pending}
          setPending={setPending}
          requestIdFor={requestIdFor}
          initialSelection={initialSelection}
          onCancel={() => onOpenChange(false)}
          onAdopted={session => {
            onOpenChange(false);
            onAdopted(session);
          }}
        />
      )}
    </Dialog>
  );
}

function ConversationPicker({
  computer,
  profiles,
  initialProfileId,
  api,
  pending,
  setPending,
  requestIdFor,
  initialSelection,
  onCancel,
  onAdopted,
}: Pick<
  Props,
  | 'computer'
  | 'api'
  | 'onAdopted'
  | 'profiles'
  | 'initialProfileId'
  | 'initialSelection'
> & {
  onCancel: () => void;
  pending: boolean;
  setPending: (pending: boolean) => void;
  requestIdFor: (key: string) => string;
}) {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<Provider | 'all'>('all');
  const initialAccount = initialProfileId ?? 'default';
  const initialKey = initialSelection ? conversationKey(initialSelection) : '';
  const [selectedKey, setSelectedKey] = useState(initialKey);
  const [profileId, setProfileId] = useState(initialAccount);
  const profileProvider = profiles.find(
    profile => profile.id === profileId,
  )?.provider;
  const include = profileId === initialAccount ? initialSelection : undefined;
  const accountMissing = profileId !== 'default' && !profileProvider;
  const [loaded, setCatalog] = useState<{
    profileId: string;
    catalog: ConversationImportCatalog;
  }>();
  const catalog = loaded?.profileId === profileId ? loaded.catalog : null;
  const [listError, setListError] = useState('');
  const [adoptError, setAdoptError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const available =
    computer?.status === 'connected' &&
    computer.capabilities.includes('conversation-import');
  const now = useNow(60_000);

  useEffect(() => {
    if (!available || accountMissing) return;
    let current = true;
    void api
      .listConversations(
        profileProvider
          ? { provider: profileProvider, profileId, include }
          : include
            ? { include }
            : undefined,
      )
      .then(
        result => {
          if (!current) return;
          setListError('');
          setCatalog({ profileId, catalog: result });
        },
        error => {
          if (current) setListError(errorDetail(error));
        },
      );
    return () => {
      current = false;
    };
  }, [
    accountMissing,
    api,
    attempt,
    available,
    include,
    profileId,
    profileProvider,
  ]);

  const term = query.trim().toLowerCase();
  const matches = (catalog?.conversations ?? [])
    .filter(
      conversation =>
        (provider === 'all' || conversation.provider === provider) &&
        [conversation.title, conversation.directory].some(value =>
          value.toLowerCase().includes(term),
        ),
    )
    .toSorted(
      (left, right) =>
        Number(conversationKey(right) === (include ? initialKey : '')) -
        Number(conversationKey(left) === (include ? initialKey : '')),
    );
  const selected = matches.find(
    conversation => conversationKey(conversation) === selectedKey,
  );

  const adopt = async () => {
    if (!available || !selected || selected.adopted || pending) return;
    const requestId = requestIdFor(`${profileId}:${conversationKey(selected)}`);
    setAdoptError('');
    setPending(true);
    try {
      onAdopted(
        await api.adoptConversation({
          provider: selected.provider,
          providerSessionId: selected.providerSessionId,
          requestId,
          ...(profileProvider ? { profileId } : {}),
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
      className="flex h-[min(30rem,calc(100dvh-2rem))] flex-col overflow-y-auto sm:max-w-xl"
    >
      <DialogHeader>
        <DialogTitle>Import conversation</DialogTitle>
        <DialogDescription>
          Continue a Claude Code or Codex conversation from{' '}
          {computer?.name ?? 'this computer'} in a new read-only session.
        </DialogDescription>
      </DialogHeader>
      {!available ? (
        <StatusMessage tone="warning" variant="notice">
          {computer?.status === 'connected'
            ? 'Update this computer’s Nesvo host and reconnect to import conversations.'
            : 'Connect this computer to import its conversations.'}
        </StatusMessage>
      ) : (
        <>
          {(profiles.length > 0 || accountMissing) && (
            <Select
              value={profileId}
              disabled={pending}
              onValueChange={id => {
                setProfileId(id);
                setProvider('all');
                setSelectedKey('');
                setListError('');
                setAdoptError('');
              }}
            >
              <SelectTrigger
                aria-label="Conversation account"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default accounts</SelectItem>
                {profiles.map(profile => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.label} · {profile.provider}
                  </SelectItem>
                ))}
                {accountMissing && (
                  <SelectItem value={profileId}>Account unavailable</SelectItem>
                )}
              </SelectContent>
            </Select>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <SearchField
              aria-label="Search conversations"
              placeholder="Search titles and folders"
              maxLength={200}
              value={query}
              onChange={event => setQuery(event.target.value)}
              onClear={() => setQuery('')}
              disabled={pending}
              containerClassName="min-w-40 flex-1"
            />
            {!profileProvider && (
              <SegmentedControl<Provider | 'all'>
                label="Filter by provider"
                size="md"
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'Claude Code', label: 'Claude Code' },
                  { value: 'Codex', label: 'Codex' },
                ]}
                value={provider}
                onChange={setProvider}
                disabled={pending}
              />
            )}
          </div>
          {accountMissing ? (
            <StatusMessage tone="warning">
              Choose an available account to list conversations.
            </StatusMessage>
          ) : listError ? (
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
            <SkeletonList
              label="Loading conversations"
              density="two-line"
              rows={4}
            />
          ) : !matches.length ? (
            <EmptyState
              size="sm"
              icon={MessagesSquare}
              title={
                catalog.conversations.length
                  ? 'No matching conversations'
                  : 'No conversations found'
              }
              description={
                catalog.conversations.length
                  ? 'Try another title, folder or provider.'
                  : `Claude Code and Codex conversations started on ${computer?.name ?? 'this computer'} appear here.`
              }
            />
          ) : (
            <ScrollArea className="min-h-14 min-w-0 flex-1">
              <div
                className="space-y-1"
                aria-label="Conversations"
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
                          <span>
                            {folderName(conversation.directory)} ·{' '}
                            {conversation.messageCount}{' '}
                            {conversation.messageCount === 1
                              ? 'message'
                              : 'messages'}
                          </span>
                        </Hint>
                      }
                      meta={
                        <time dateTime={conversation.lastActivityAt}>
                          {formatRelativeTime(conversation.lastActivityAt, now)}
                        </time>
                      }
                      trailing={
                        <>
                          {conversation.adopted && (
                            <Badge size="xs">Imported</Badge>
                          )}
                        </>
                      }
                      selected={selectedKey === key}
                      mainProps={{
                        'aria-label': [
                          conversation.title,
                          conversation.provider,
                          conversation.directory,
                          ...(conversation.adopted ? ['Imported'] : []),
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
          <section
            aria-label="Preview"
            className="h-20 shrink-0 space-y-1 overflow-auto border-t pt-2"
          >
            <p className="text-xs font-medium">Preview</p>
            <p className="text-xs whitespace-pre-wrap [overflow-wrap:anywhere] text-muted-foreground">
              {selected?.preview || 'Select a conversation to preview it.'}
            </p>
          </section>
          {adoptError && (
            <StatusMessage tone="error">{adoptError}</StatusMessage>
          )}
        </>
      )}
      <DialogFooter className="mt-auto shrink-0">
        <DialogCancel disabled={pending} onClick={onCancel} />
        {available && (
          <Button
            size="lg"
            disabled={pending || !selected || selected.adopted}
            aria-busy={pending || undefined}
            onClick={() => void adopt()}
          >
            {pending ? 'Importing…' : 'Import conversation'}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
