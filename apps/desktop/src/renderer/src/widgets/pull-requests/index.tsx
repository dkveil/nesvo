import { useState, type FormEvent } from 'react';
import {
  GITHUB_REPOSITORY_PATTERN,
  type Computer,
  type PullRequestListScope,
} from '@nesvo/contracts';
import { GitPullRequest, Link2, RefreshCw } from 'lucide-react';
import { cn } from 'cn';
import {
  parseReferenceInput,
  pullRequestsUnavailableReason,
  sameReference,
  type PullRequestApi,
  type PullRequestTarget,
} from '@/entities/pull-request';
import { directoryLabel } from '@/entities/session';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { PanelSearch } from '@/shared/ui/panel';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';
import { PullRequestRow } from './pull-request-row';
import { usePullRequestList } from './use-pull-request-list';

const RELATIVE_TIME_REFRESH_MS = 60_000;

const SCOPE_OPTIONS: { value: PullRequestListScope; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'authored', label: 'Authored' },
  { value: 'review-requested', label: 'Review requested' },
];

type PullRequestsViewProps = {
  computers: Computer[];
  hostId: string;
  directory: string;
  apiFor: (hostId: string) => PullRequestApi | null;
  openTarget: PullRequestTarget | null;
  onOpen: (target: PullRequestTarget) => void;
};

export function PullRequestsView({
  computers,
  hostId: sessionHostId,
  directory: sessionDirectory,
  apiFor,
  openTarget,
  onOpen,
}: PullRequestsViewProps) {
  const capable = computers.filter(computer =>
    computer.capabilities.includes('pull-requests'),
  );
  const [hostId, setHostId] = useState(sessionHostId);
  const computer = computers.find(item => item.id === hostId);
  const unavailable = pullRequestsUnavailableReason(computer);
  const directory = hostId === sessionHostId ? sessionDirectory : '';
  const [repositoryDraft, setRepositoryDraft] = useState('');
  const [repository, setRepository] = useState('');
  const [repositoryError, setRepositoryError] = useState('');
  const [scope, setScope] = useState<PullRequestListScope>('open');
  const [query, setQuery] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [reference, setReference] = useState('');
  const [referenceError, setReferenceError] = useState('');
  const now = useNow(RELATIVE_TIME_REFRESH_MS);
  const api = unavailable ? null : apiFor(hostId);
  const result = usePullRequestList({
    api,
    hostId,
    directory,
    repository,
    scope,
    query: query.trim(),
    refresh,
  });
  const currentRepository = repository || result.list?.repository || null;
  const commitRepository = () => {
    const value = repositoryDraft.trim();
    if (value && !GITHUB_REPOSITORY_PATTERN.test(value)) {
      setRepositoryError('Use owner/name.');
      return;
    }
    setRepositoryError('');
    setRepository(value);
  };
  const openReference = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseReferenceInput(reference, currentRepository);
    if (!parsed) {
      setReferenceError(
        currentRepository
          ? 'Paste a GitHub pull request link or a number.'
          : 'Paste a full GitHub pull request link, or choose a repository first.',
      );
      return;
    }
    setReferenceError('');
    setReference('');
    onOpen({ hostId, reference: parsed });
  };
  const items = result.list?.items ?? [];
  return (
    <>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <section
          aria-label="Pull requests"
          className="mx-auto w-full max-w-4xl px-5 py-5 lg:px-8"
        >
          <div className="flex flex-wrap items-center gap-2 px-1 pb-2">
            {capable.length > 1 && (
              <Select value={hostId} onValueChange={setHostId}>
                <SelectTrigger
                  size="sm"
                  aria-label="Computer"
                  className="h-7 w-36 border-transparent bg-transparent text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground dark:bg-transparent dark:hover:bg-accent"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {capable.map(item => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <label className="flex h-7 min-w-40 flex-1 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors duration-150 ease-out focus-within:bg-accent focus-within:ring-1 focus-within:ring-ring/70 focus-within:ring-inset hover:bg-accent">
              <GitPullRequest
                className="size-3.5 shrink-0"
                aria-hidden="true"
              />
              <span className="sr-only">Repository</span>
              <input
                value={repositoryDraft}
                maxLength={140}
                spellCheck={false}
                aria-invalid={!!repositoryError}
                aria-describedby={
                  repositoryError ? 'pull-request-repository-error' : undefined
                }
                placeholder={
                  directory
                    ? `${result.list?.repository ?? directoryLabel(directory)} · or type owner/name`
                    : 'owner/name'
                }
                onChange={event => setRepositoryDraft(event.target.value)}
                onBlur={commitRepository}
                onKeyDown={event => {
                  if (event.key === 'Enter') commitRepository();
                }}
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
            <SegmentedControl
              label="Pull request scope"
              value={scope}
              options={SCOPE_OPTIONS}
              onChange={setScope}
            />
            <PanelSearch
              aria-label="Search pull requests"
              placeholder="Search"
              maxLength={200}
              value={query}
              onChange={event => setQuery(event.target.value)}
              className="h-7 w-40 [&_input]:text-xs"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Refresh pull requests"
                  disabled={!api || result.status === 'loading'}
                  onClick={() => setRefresh(value => value + 1)}
                  className="size-7 text-muted-foreground enabled:hover:text-foreground disabled:cursor-not-allowed"
                >
                  <RefreshCw
                    className={cn(
                      'size-3.5',
                      result.status === 'loading' &&
                        'animate-spin motion-reduce:animate-none',
                    )}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Refresh</TooltipContent>
            </Tooltip>
          </div>
          {repositoryError && (
            <p
              id="pull-request-repository-error"
              role="alert"
              className="px-3 pb-2 text-2xs text-error-foreground"
            >
              {repositoryError}
            </p>
          )}
          <form
            onSubmit={openReference}
            className="mx-1 mb-3 flex h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors duration-150 ease-out focus-within:bg-accent focus-within:ring-1 focus-within:ring-ring/70 focus-within:ring-inset hover:bg-accent"
          >
            <Link2 className="size-3.5 shrink-0" aria-hidden="true" />
            <input
              value={reference}
              maxLength={300}
              spellCheck={false}
              disabled={!!unavailable}
              aria-label="Open a pull request by link or number"
              aria-invalid={!!referenceError}
              placeholder="Paste a pull request link or #number"
              onChange={event => {
                setReference(event.target.value);
                setReferenceError('');
              }}
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
            />
            {reference.trim() && (
              <Button
                type="submit"
                variant="ghost"
                size="xs"
                className="h-5 text-2xs text-muted-foreground enabled:hover:text-foreground"
              >
                Open
              </Button>
            )}
          </form>
          {referenceError && (
            <p
              role="alert"
              className="-mt-2 px-3 pb-3 text-2xs text-error-foreground"
            >
              {referenceError}
            </p>
          )}
          {unavailable ? (
            <InlineNotice>{unavailable}</InlineNotice>
          ) : !directory && !repository ? (
            <InlineNotice>
              Type a repository as owner/name, or open a session in a project
              folder to list its pull requests.
            </InlineNotice>
          ) : result.status === 'error' ? (
            <div className="flex flex-wrap items-center gap-2">
              <InlineNotice tone="error" className="min-w-0 flex-1">
                {result.error}
              </InlineNotice>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setRefresh(value => value + 1)}
              >
                Try again
              </Button>
            </div>
          ) : result.status === 'loading' && items.length === 0 ? (
            <p
              role="status"
              className="px-3 py-3 text-xs text-muted-foreground"
            >
              Loading pull requests…
            </p>
          ) : items.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              {query.trim()
                ? 'No pull requests match this search.'
                : scope === 'authored'
                  ? 'You have no open pull requests in this repository.'
                  : scope === 'review-requested'
                    ? 'No reviews are requested from you here.'
                    : 'No open pull requests.'}
            </p>
          ) : (
            <>
              <p className="flex items-center justify-between px-3 pb-1 text-2xs text-muted-foreground tabular-nums">
                <span className="truncate">{result.list?.repository}</span>
                <span>
                  {items.length}
                  {result.list?.truncated ? '+' : ''} pull requests
                </span>
              </p>
              <ul
                aria-busy={result.status === 'loading'}
                className={cn(
                  'space-y-px transition-opacity duration-150 ease-out',
                  result.status === 'loading' && 'opacity-60',
                )}
              >
                {items.map(item => (
                  <PullRequestRow
                    key={`${item.repository}#${item.number}`}
                    pullRequest={item}
                    now={now}
                    selected={
                      openTarget?.hostId === result.hostId &&
                      sameReference(openTarget.reference, item)
                    }
                    onOpen={() =>
                      onOpen({
                        hostId: result.hostId,
                        reference: {
                          repository: item.repository,
                          number: item.number,
                        },
                      })
                    }
                  />
                ))}
              </ul>
              {result.list?.truncated && (
                <p className="px-3 pt-2 text-2xs text-muted-foreground">
                  Showing the most recent pull requests. Search to narrow the
                  list.
                </p>
              )}
            </>
          )}
        </section>
      </ScrollArea>
    </>
  );
}
