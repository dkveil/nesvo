import { Fragment, useEffect, useMemo, useState } from 'react';
import type {
  Computer,
  HistorySearchPage,
  HistorySearchResult,
  HostId,
  TranscriptSearchPage,
  TranscriptSearchResult,
} from '@nesvo/contracts';
import { directoryLabel, ProviderGlyph } from '@/entities/session';
import { formatRelativeTime } from '@/shared/lib/relative-time';
import { useNow } from '@/shared/lib/use-now';
import { Checkbox } from '@/shared/ui/checkbox';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui/dialog';
import { Label } from '@/shared/ui/label';
import { Listbox } from '@/shared/ui/listbox';
import { listboxOptionId } from '@/shared/ui/listbox-option-id';
import { SearchField } from '@/shared/ui/search-field';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  computers: Computer[];
  initialQuery: string;
  onClose: () => void;
  onOpenResult: (hostId: HostId, result: HistorySearchResult) => void;
  onOpenTranscript: (hostId: HostId, result: TranscriptSearchResult) => void;
  returnFocus: HTMLElement | null;
};

type HostResults = {
  page: HistorySearchPage | null;
  transcripts?: TranscriptSearchPage | null;
};

type ResultRow = {
  key: string;
  hostId: HostId;
  group: string;
  title: string;
  sessionKey?: string;
  messageMatch?: boolean;
  provider: HistorySearchResult['provider'];
  snippet: HistorySearchResult['snippet'];
  directory: string;
  at: string;
  open: () => void;
};

const TRANSCRIPT_SCOPE_KEY = 'nesvo.history-search.transcripts';

const canSearch = (computer: Computer) =>
  computer.status === 'connected' &&
  computer.capabilities.includes('history-search');

const canSearchTranscripts = (computer: Computer) =>
  computer.status === 'connected' &&
  computer.capabilities.includes('transcript-search');

function readTranscriptScope() {
  try {
    return window.localStorage.getItem(TRANSCRIPT_SCOPE_KEY) === 'on';
  } catch {
    return false;
  }
}

function saveTranscriptScope(enabled: boolean) {
  try {
    window.localStorage.setItem(TRANSCRIPT_SCOPE_KEY, enabled ? 'on' : 'off');
  } catch {
    return;
  }
}

function hostStatus(
  computer: Computer,
  results: HostResults | undefined,
  includeTranscripts: boolean,
) {
  if (computer.status !== 'connected') return 'offline, not searched';
  if (!canSearch(computer)) return 'not searched, host update required';
  const notes = [
    results?.page === null && 'search failed',
    results?.page?.truncated && 'partial results',
  ];
  if (includeTranscripts)
    notes.push(
      !canSearchTranscripts(computer)
        ? 'CLI transcripts need a host update'
        : results?.transcripts === null
          ? 'CLI transcript search failed'
          : results?.transcripts?.truncated &&
            'CLI transcripts partially indexed',
    );
  return notes.filter(Boolean).join(', ');
}

function groupResults(results: HistorySearchResult[]) {
  const groups = new Map<string, HistorySearchResult[]>();
  for (const result of results) {
    const group = groups.get(result.sessionId) ?? [];
    group.push(result);
    groups.set(result.sessionId, group);
  }
  return Array.from(groups.values());
}

function HighlightedSnippet({ text, ranges }: HistorySearchResult['snippet']) {
  return (
    <>
      {ranges.map(({ start, end }, index) => (
        <Fragment key={start}>
          {text.slice(ranges[index - 1]?.end ?? 0, start)}
          <mark className="rounded-sm bg-accent text-warning-foreground">
            {text.slice(start, end)}
          </mark>
        </Fragment>
      ))}
      {text.slice(ranges.at(-1)?.end ?? 0)}
    </>
  );
}

const RESULTS_ID = 'history-results';

const transcriptKey = (computer: Computer, result: TranscriptSearchResult) =>
  ['transcript-result', computer.id, result.provider, result.providerSessionId]
    .join('-')
    .replaceAll(' ', '-');

const resultKey = (computer: Computer, result: HistorySearchResult) =>
  `history-result-${computer.id}-${result.sessionId}-${result.messageId ?? 'title'}`;

export function HistorySearchDialog({
  computers,
  initialQuery,
  onClose,
  onOpenResult,
  onOpenTranscript,
  returnFocus,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [includeTranscripts, setIncludeTranscripts] =
    useState(readTranscriptScope);
  const [activeKey, setActiveKey] = useState('');
  const [search, setSearch] = useState<{
    key: string;
    hosts: Record<string, HostResults>;
  }>({ key: '', hosts: {} });
  const term = query.trim();
  const eligible = useMemo(() => computers.filter(canSearch), [computers]);
  const requestKey = JSON.stringify([
    term,
    includeTranscripts,
    eligible.map(computer => [computer.id, computer.instanceId]),
  ]);
  const now = useNow(60_000);

  useEffect(() => {
    if (!term || !eligible.length) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      for (const computer of eligible) {
        const complete = (results: Partial<HostResults>) => {
          if (controller.signal.aborted) return;
          setSearch(previous => {
            const hosts = previous.key === requestKey ? previous.hosts : {};
            return {
              key: requestKey,
              hosts: {
                ...hosts,
                [computer.id]: {
                  page: null,
                  ...hosts[computer.id],
                  ...results,
                },
              },
            };
          });
        };
        void window.nesvo.searchHistory({ query: term }, computer.id).then(
          page => complete({ page }),
          () => complete({ page: null }),
        );
        if (includeTranscripts && canSearchTranscripts(computer))
          void window.nesvo
            .searchTranscripts({ query: term }, computer.id)
            .then(
              transcripts => complete({ transcripts }),
              () => complete({ transcripts: null }),
            );
      }
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [eligible, includeTranscripts, requestKey, term]);

  const hosts = search.key === requestKey ? search.hosts : {};
  const historyRows = eligible.flatMap(computer =>
    groupResults(hosts[computer.id]?.page?.results ?? [])
      .flat()
      .map((result): ResultRow => ({
        key: resultKey(computer, result),
        hostId: computer.id,
        group: computer.name,
        title: result.title,
        sessionKey: `${computer.id}/${result.sessionId}`,
        messageMatch: !!result.messageId,
        provider: result.provider,
        snippet: result.snippet,
        directory: result.directory,
        at: result.createdAt,
        open: () => onOpenResult(computer.id, result),
      })),
  );
  const transcriptRows = includeTranscripts
    ? eligible.flatMap(computer =>
        (hosts[computer.id]?.transcripts?.results ?? []).map(
          (result): ResultRow => ({
            key: transcriptKey(computer, result),
            hostId: computer.id,
            group: computer.name + ' · CLI transcripts',
            title: result.title,
            provider: result.provider,
            snippet: result.snippet,
            directory: result.directory,
            at: result.lastActivityAt,
            open: () => onOpenTranscript(computer.id, result),
          }),
        ),
      )
    : [];
  const rows = [...historyRows, ...transcriptRows];
  const active = rows.findIndex(row => row.key === activeKey);
  const current = rows[Math.max(active, 0)];
  const pending =
    !!term &&
    eligible.some(
      computer =>
        !hosts[computer.id] ||
        (includeTranscripts &&
          canSearchTranscripts(computer) &&
          hosts[computer.id]?.transcripts === undefined),
    );
  const open = (key: string) => rows.find(item => item.key === key)?.open();

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onCloseAutoFocus={event => {
          event.preventDefault();
          if (returnFocus?.isConnected) returnFocus.focus();
        }}
        placement="top"
        className="gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <DialogTitle className="sr-only">Search all history</DialogTitle>
        <SearchField
          variant="palette"
          role="combobox"
          aria-label="Search all history"
          aria-autocomplete="list"
          aria-expanded
          aria-controls={RESULTS_ID}
          aria-activedescendant={
            current ? listboxOptionId(RESULTS_ID, current.key) : undefined
          }
          placeholder="Search messages and session titles"
          maxLength={200}
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setActiveKey('');
          }}
          onClear={() => {
            setQuery('');
            setActiveKey('');
          }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || !current) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              current.open();
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const direction = event.key === 'ArrowDown' ? 1 : -1;
              const index =
                (Math.max(active, 0) + direction + rows.length) % rows.length;
              const next = rows[index];
              if (next) setActiveKey(next.key);
            }
          }}
        />
        <div className="flex items-center border-b px-3.5 py-2">
          <Label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={includeTranscripts}
              onCheckedChange={value => {
                const enabled = value === true;
                setIncludeTranscripts(enabled);
                saveTranscriptScope(enabled);
                setActiveKey('');
              }}
            />
            Include CLI transcripts not yet imported
          </Label>
        </div>
        {rows.length > 0 && (
          <Listbox
            id={RESULTS_ID}
            label="History matches"
            options={rows.map((row, index) => ({
              ariaLabel: `${row.title}, ${row.messageMatch ? 'Message match' : 'Conversation'}`,
              value: row.key,
              label:
                row.sessionKey && row.sessionKey === rows[index - 1]?.sessionKey
                  ? row.messageMatch
                    ? 'Message match'
                    : 'Session title match'
                  : row.title,
              group: row.group,
              icon: <ProviderGlyph provider={row.provider} />,
              description: <HighlightedSnippet {...row.snippet} />,
              wrapDescription: true,
              trailing: (
                <>
                  {directoryLabel(row.directory)} ·{' '}
                  <time dateTime={row.at}>
                    {formatRelativeTime(row.at, now)}
                  </time>
                </>
              ),
            }))}
            active={current?.key ?? null}
            onActiveChange={next => {
              if (next) setActiveKey(next);
            }}
            onSelect={open}
            className="max-h-[min(55vh,28rem)]"
          />
        )}
        {term && (
          <div className="space-y-1 px-3.5 py-2.5 empty:hidden">
            {pending && (
              <StatusMessage tone="loading">
                {includeTranscripts
                  ? 'Searching history and CLI transcripts…'
                  : 'Searching history…'}
              </StatusMessage>
            )}
            {!pending &&
              !rows.length &&
              eligible.some(computer => hosts[computer.id]?.page) && (
                <StatusMessage>No matches.</StatusMessage>
              )}
            {computers.map(computer => {
              const status = hostStatus(
                computer,
                hosts[computer.id],
                includeTranscripts,
              );
              return status ? (
                <StatusMessage key={computer.id} tone="warning">
                  {computer.name} · {status}
                </StatusMessage>
              ) : null;
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
