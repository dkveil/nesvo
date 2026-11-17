import { Fragment, useEffect, useMemo, useState } from 'react';
import type {
  Computer,
  HistorySearchPage,
  HistorySearchResult,
  HostId,
} from '@nesvo/contracts';
import { Search } from 'lucide-react';
import { directoryLabel, ProviderGlyph } from '@/entities/session';
import { formatRelativeTime } from '@/shared/lib/relative-time';
import { useNow } from '@/shared/lib/use-now';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui/dialog';

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
          <mark className="rounded-sm bg-warning-foreground/15 text-warning-foreground">
            {text.slice(start, end)}
          </mark>
        </Fragment>
      ))}
      {text.slice(ranges.at(-1)?.end ?? 0)}
    </>
  );
}

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
      result,
    })),
  );
  const active = rows.findIndex(row => row.key === activeKey);
  const current = rows[Math.max(active, 0)];
  const pending = !!term && eligible.some(computer => !hosts[computer.id]);
  const setActive = (key: string) => {
    setActiveKey(key);
    document.getElementById(key)?.scrollIntoView({ block: 'nearest' });
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
        <div className="flex items-center gap-3 border-b px-4">
          <Search aria-hidden="true" className="size-4 text-muted-foreground" />
          <input
            role="combobox"
            aria-label="Search all history"
            aria-autocomplete="list"
            aria-expanded
            aria-controls="history-results"
            aria-activedescendant={current?.key}
            placeholder="Search messages and session titles"
            maxLength={200}
            className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            value={query}
            onChange={event => {
              setQuery(event.target.value);
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
                if (next) setActive(next.key);
              }
            }}
          />
        </div>
        <div
          id="history-results"
          role="listbox"
          aria-label="History matches"
          aria-busy={pending}
          className="max-h-[min(55vh,28rem)] overflow-y-auto p-2"
        >
          {groups.map(
            ({ computer, groups }) =>
              groups.length > 0 && (
                <div
                  key={computer.id}
                  role="group"
                  aria-label={computer.name}
                  className="pb-2"
                >
                  <div
                    aria-hidden="true"
                    className="px-2 py-1 text-xs font-medium text-muted-foreground"
                  >
                    {computer.name}
                  </div>
                  {groups.map(group => (
                    <div
                      key={group[0]?.sessionId}
                      role="group"
                      aria-label={group[0]?.title}
                      className="mb-1"
                    >
                      {group.map(result => {
                        const key = resultKey(computer, result);
                        return (
                          <div
                            key={key}
                            id={key}
                            role="option"
                            aria-selected={current?.key === key}
                            className="cursor-pointer rounded-md px-2 py-1.5 text-sm hover:bg-accent aria-selected:bg-accent"
                            onMouseDown={event => event.preventDefault()}
                            onClick={() => onOpenResult(computer.id, result)}
                          >
                            <div className="flex items-center gap-2">
                              <ProviderGlyph provider={result.provider} />
                              <span className="sr-only">{result.provider}</span>
                              <span className="min-w-0 truncate font-medium">
                                {result.title}
                              </span>
                              <span className="min-w-0 truncate text-xs text-muted-foreground">
                                {directoryLabel(result.directory)}
                              </span>
                              <time
                                dateTime={result.createdAt}
                                className="ml-auto shrink-0 text-xs text-muted-foreground"
                              >
                                {formatRelativeTime(result.createdAt, now)}
                              </time>
                            </div>
                            <p className="mt-0.5 line-clamp-2 break-words pl-5 text-xs leading-relaxed text-muted-foreground">
                              <HighlightedSnippet {...result.snippet} />
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ),
          )}
        </div>
        {term && (
          <div
            role="status"
            className="space-y-1 px-4 pb-3 text-xs text-muted-foreground empty:hidden"
          >
            {pending && <p>Searching history…</p>}
            {!pending &&
              !rows.length &&
              eligible.some(computer => hosts[computer.id]?.page) && (
                <p>No matches.</p>
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
                <p key={computer.id}>
                  {computer.name} · {status}
                </p>
              ) : null;
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
