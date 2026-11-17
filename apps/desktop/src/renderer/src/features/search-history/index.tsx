import { Fragment, useEffect, useMemo, useState } from 'react';
import type {
  Computer,
  HistorySearchPage,
  HistorySearchResult,
  HostId,
} from '@nesvo/contracts';
import { directoryLabel, ProviderGlyph } from '@/entities/session';
import { formatRelativeTime } from '@/shared/lib/relative-time';
import { useNow } from '@/shared/lib/use-now';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui/dialog';
import { Listbox } from '@/shared/ui/listbox';
import { listboxOptionId } from '@/shared/ui/listbox-option-id';
import { SearchField } from '@/shared/ui/search-field';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  computers: Computer[];
  initialQuery: string;
  onClose: () => void;
  onOpenResult: (hostId: HostId, result: HistorySearchResult) => void;
  returnFocus: HTMLElement | null;
};

type HostResults = { page: HistorySearchPage | null };

const canSearch = (computer: Computer) =>
  computer.status === 'connected' &&
  computer.capabilities.includes('history-search');

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

const resultKey = (computer: Computer, result: HistorySearchResult) =>
  `history-result-${computer.id}-${result.sessionId}-${result.messageId ?? 'title'}`;

export function HistorySearchDialog({
  computers,
  initialQuery,
  onClose,
  onOpenResult,
  returnFocus,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [activeKey, setActiveKey] = useState('');
  const [search, setSearch] = useState<{
    key: string;
    hosts: Record<string, HostResults>;
  }>({ key: '', hosts: {} });
  const term = query.trim();
  const eligible = useMemo(() => computers.filter(canSearch), [computers]);
  const requestKey = JSON.stringify([
    term,
    eligible.map(computer => [computer.id, computer.instanceId]),
  ]);
  const now = useNow(60_000);

  useEffect(() => {
    if (!term || !eligible.length) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      for (const computer of eligible) {
        const complete = (page: HistorySearchPage | null) => {
          if (controller.signal.aborted) return;
          setSearch(previous => ({
            key: requestKey,
            hosts: {
              ...(previous.key === requestKey ? previous.hosts : {}),
              [computer.id]: { page },
            },
          }));
        };
        void window.nesvo
          .searchHistory({ query: term }, computer.id)
          .then(complete, () => complete(null));
      }
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [eligible, requestKey, term]);

  const hosts = search.key === requestKey ? search.hosts : {};
  const groups = eligible.map(computer => ({
    computer,
    groups: groupResults(hosts[computer.id]?.page?.results ?? []),
  }));
  const rows = groups.flatMap(({ computer, groups }) =>
    groups.flat().map(result => ({
      key: resultKey(computer, result),
      hostId: computer.id,
      computerName: computer.name,
      result,
    })),
  );
  const active = rows.findIndex(row => row.key === activeKey);
  const current = rows[Math.max(active, 0)];
  const pending = !!term && eligible.some(computer => !hosts[computer.id]);
  const open = (key: string) => {
    const row = rows.find(item => item.key === key);
    if (row) onOpenResult(row.hostId, row.result);
  };

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onCloseAutoFocus={event => {
          event.preventDefault();
          if (returnFocus?.isConnected) returnFocus.focus();
        }}
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
              onOpenResult(current.hostId, current.result);
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
        {rows.length > 0 && (
          <Listbox
            id={RESULTS_ID}
            label="History matches"
            options={rows.map(row => ({
              value: row.key,
              label: row.result.title,
              group: row.computerName,
              icon: <ProviderGlyph provider={row.result.provider} />,
              description: <HighlightedSnippet {...row.result.snippet} />,
              trailing: (
                <>
                  {directoryLabel(row.result.directory)} ·{' '}
                  <time dateTime={row.result.createdAt}>
                    {formatRelativeTime(row.result.createdAt, now)}
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
              <StatusMessage tone="loading">Searching history…</StatusMessage>
            )}
            {!pending &&
              !rows.length &&
              eligible.some(computer => hosts[computer.id]?.page) && (
                <StatusMessage>No matches.</StatusMessage>
              )}
            {computers.map(computer => {
              const status =
                computer.status !== 'connected'
                  ? 'offline, not searched'
                  : !canSearch(computer)
                    ? 'not searched, host update required'
                    : hosts[computer.id]?.page === null
                      ? 'search failed'
                      : hosts[computer.id]?.page?.truncated
                        ? 'partial results'
                        : '';
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
