import { useState, type FormEvent } from 'react';
import {
  GITHUB_REPOSITORY_PATTERN,
  type Computer,
  type PullRequestListScope,
} from '@nesvo/contracts';
import { GitPullRequest, Link2, RefreshCw } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
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
import { EmptyState } from '@/shared/ui/empty-state';
import { IconButton } from '@/shared/ui/icon-button';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { PanelBody, PanelSearch } from '@/shared/ui/panel';
import { SearchField } from '@/shared/ui/search-field';
import { SectionLabel } from '@/shared/ui/section-label';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { SkeletonList } from '@/shared/ui/skeleton';
import { StatusMessage } from '@/shared/ui/status-message';
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
  initialQuery?: string;
  apiFor: (hostId: string) => PullRequestApi | null;
  openTarget: PullRequestTarget | null;
  onOpen: (target: PullRequestTarget) => void;
};

export function PullRequestsView({
  computers,
  hostId: sessionHostId,
  directory: sessionDirectory,
  initialQuery = '',
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
  const [query, setQuery] = useState(initialQuery);
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
    <PanelBody className="min-w-0">
      <section
        aria-label="Pull requests"
        className="mx-auto w-full max-w-4xl space-y-2 px-5 py-5 lg:px-8"
      >
        <div className="flex flex-wrap items-center gap-2">
          {capable.length > 1 && (
            <Select value={hostId} onValueChange={setHostId}>
              <SelectTrigger
                variant="ghost"
                aria-label="Computer"
                className="w-36"
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
          <SearchField
            icon={<GitPullRequest />}
            aria-label="Repository"
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
            containerClassName="min-w-40 flex-1"
          />
          <SegmentedControl
            label="Pull request scope"
            value={scope}
            options={SCOPE_OPTIONS}
            onChange={setScope}
          />
          <PanelSearch
            aria-label="Search pull requests"
            placeholder="Search"
            maxLength={205}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onClear={() => setQuery('')}
            className="w-40"
          />
          <IconButton
            label="Refresh pull requests"
            disabled={!api || result.status === 'loading'}
            onClick={() => setRefresh(value => value + 1)}
          >
            <RefreshCw
              className={cn(
                'size-3.5',
                result.status === 'loading' && 'animate-spin',
              )}
            />
          </IconButton>
        </div>
        {repositoryError && (
          <StatusMessage
            id="pull-request-repository-error"
            tone="error"
            className="px-2"
          >
            {repositoryError}
          </StatusMessage>
        )}
        <form onSubmit={openReference}>
          <SearchField
            icon={<Link2 />}
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
            trailing={
              reference.trim() && (
                <Button type="submit" variant="ghost" size="xs">
                  Open
                </Button>
              )
            }
          />
        </form>
        {referenceError && (
          <StatusMessage tone="error" className="px-2">
            {referenceError}
          </StatusMessage>
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
              onClick={() => setRefresh(value => value + 1)}
            >
              Try again
            </Button>
          </div>
        ) : result.status === 'loading' && items.length === 0 ? (
          <SkeletonList
            label="Loading pull requests"
            density="two-line"
            rows={6}
          />
        ) : items.length === 0 ? (
          <EmptyState
            size="sm"
            icon={GitPullRequest}
            title={
              query.trim()
                ? 'No pull requests match this search.'
                : scope === 'authored'
                  ? 'You have no open pull requests in this repository.'
                  : scope === 'review-requested'
                    ? 'No reviews are requested from you here.'
                    : 'No open pull requests.'
            }
          />
        ) : (
          <div>
            <SectionLabel
              action={
                <span className="text-2xs text-muted-foreground tabular-nums">
                  {items.length}
                  {result.list?.truncated ? '+' : ''} pull requests
                </span>
              }
            >
              {result.list?.repository}
            </SectionLabel>
            <ul
              aria-busy={result.status === 'loading'}
              className={cn(
                'space-y-px transition-opacity duration-base ease-out',
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
              <p className="px-2 pt-2 text-2xs text-muted-foreground">
                Showing the most recent pull requests. Search to narrow the
                list.
              </p>
            )}
          </div>
        )}
      </section>
    </PanelBody>
  );
}
