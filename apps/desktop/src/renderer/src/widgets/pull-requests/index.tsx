import { useState, type ClipboardEvent, type FormEvent } from 'react';
import type {
  Computer,
  DesktopApi,
  PullRequestListScope,
  PullRequestSummary,
} from '@nesvo/contracts';
import {
  FolderGit2,
  GitPullRequest,
  Link2,
  ListChecks,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import {
  parseReferenceInput,
  pullRequestsUnavailableReason,
  recentPullRequestRepositories,
  sameReference,
  type PullRequestApi,
  type PullRequestTarget,
} from '@/entities/pull-request';
import { directoryLabel } from '@/entities/session';
import {
  useTrackedRepositories,
  type TrackedRepositoryApi,
} from '@/entities/tracked-repository';
import { TrackRepositoryDialog } from '@/features/track-repository';
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
import { PullRequestListProblem } from './pull-request-list-problem';
import { PullRequestRow } from './pull-request-row';
import {
  FOLDER_KEY,
  isNotRepositoryError,
  resolveSource,
  trackedKey,
} from './pull-request-source';
import { RepositoryFilter } from './repository-filter';
import { RepositorySourcePicker } from './repository-source-picker';
import {
  readExcludedRepositories,
  readSourcePreference,
  saveExcludedRepositories,
  saveSourcePreference,
} from './source-preference';
import { useTrackedPullRequestLists } from './use-tracked-pull-request-lists';
import { MAX_BATCH_REFERENCES, splitReferenceInput } from './reference-batch';
import { useAddedPullRequests } from './use-added-pull-requests';
import { ReviewSelectionBar } from './review-selection-bar';
import { useReviewSelection } from './use-review-selection';
import { usePullRequestList } from './use-pull-request-list';

const RELATIVE_TIME_REFRESH_MS = 60_000;
const REFERENCE_INPUT_MAX_LENGTH = 4000;

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
  apiFor: (
    hostId: string,
  ) => (PullRequestApi & ReviewStartApi & TrackedRepositoryApi) | null;
  openTarget: PullRequestTarget | null;
  onOpen: (target: PullRequestTarget) => void;
  onOpenCodeReviewSettings?: () => void;
};

type ReviewStartApi = Pick<
  DesktopApi,
  'readCodeReviewSettings' | 'startPullRequestReview'
>;

export function PullRequestsView({
  computers,
  hostId: sessionHostId,
  directory: sessionDirectory,
  initialQuery = '',
  apiFor,
  openTarget,
  onOpen,
  onOpenCodeReviewSettings,
}: PullRequestsViewProps) {
  const capable = computers.filter(computer =>
    computer.capabilities.includes('pull-requests'),
  );
  const [hostId, setHostId] = useState(sessionHostId);
  const computer = computers.find(item => item.id === hostId);
  const unavailable = pullRequestsUnavailableReason(computer);
  const directory = hostId === sessionHostId ? sessionDirectory : '';
  const [sourceChoice, setSourceChoice] = useState<string | null>(() =>
    initialQuery ? FOLDER_KEY : readSourcePreference(sessionHostId),
  );
  const [excluded, setExcluded] = useState(() =>
    readExcludedRepositories(sessionHostId),
  );
  const [tracking, setTracking] = useState(false);
  const [scope, setScope] = useState<PullRequestListScope>('open');
  const [query, setQuery] = useState(initialQuery);
  const [refresh, setRefresh] = useState(0);
  const [reference, setReference] = useState('');
  const [referenceError, setReferenceError] = useState('');
  const batch = useAddedPullRequests();
  const now = useNow(RELATIVE_TIME_REFRESH_MS);
  const selection = useReviewSelection();
  const reviewable = !!computer?.capabilities.includes('pull-request-reviews');
  const api = unavailable ? null : apiFor(hostId);
  const canTrack =
    !!api && !!computer?.capabilities.includes('tracked-repositories');
  const tracked = useTrackedRepositories(api, hostId, canTrack);
  const trackedReady =
    !canTrack ||
    tracked.status === 'ready' ||
    tracked.status === 'error' ||
    tracked.repositories.length > 0;
  const source = resolveSource({
    key: sourceChoice,
    tracked: tracked.repositories,
    trackedReady,
    directory,
  });
  const singleRepository =
    source.kind === 'tracked'
      ? source.tracked.repository
      : source.kind === 'repository'
        ? source.repository
        : '';
  const result = usePullRequestList({
    api,
    hostId,
    directory: source.kind === 'folder' ? directory : '',
    repository: singleRepository,
    scope,
    query: query.trim(),
    refresh,
  });
  const all = useTrackedPullRequestLists({
    api,
    hostId,
    enabled: source.kind === 'all',
    scope,
    query: query.trim(),
    refresh,
  });
  const hidden = new Set(excluded);
  const includedLists = all.lists.filter(
    list => !hidden.has(list.repository.toLowerCase()),
  );
  const failedLists = includedLists.filter(list => list.status === 'error');
  const allItems = includedLists
    .flatMap(list => (list.status === 'ready' ? list.items : []))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const currentRepository =
    singleRepository ||
    (source.kind === 'folder' ? (result.list?.repository ?? '') : '') ||
    (source.kind === 'all' && includedLists.length === 1
      ? includedLists[0]!.repository
      : '') ||
    null;
  const chooseSource = (key: string) => {
    setSourceChoice(key);
    saveSourcePreference(hostId, key);
    selection.stop();
  };
  const chooseHost = (next: string) => {
    setHostId(next);
    setSourceChoice(readSourcePreference(next));
    setExcluded(readExcludedRepositories(next));
    selection.stop();
  };
  const changeExcluded = (next: string[]) => {
    setExcluded(next);
    saveExcludedRepositories(hostId, next);
  };
  const retry = () => setRefresh(value => value + 1);
  const startTracking = canTrack ? () => setTracking(true) : undefined;
  const reviewDirectory =
    source.kind === 'folder'
      ? directory
      : source.kind === 'tracked'
        ? (source.tracked.directory ?? '')
        : (tracked.repositories.find(item =>
            selection.selected.some(
              selected =>
                selected.repository.toLowerCase() ===
                item.repository.toLowerCase(),
            ),
          )?.directory ?? '');
  const openReferences = async (inputs: string[]) => {
    if (!api) return;
    if (inputs.length > MAX_BATCH_REFERENCES) {
      setReferenceError(
        `Paste up to ${MAX_BATCH_REFERENCES} pull requests at once.`,
      );
      return;
    }
    setReferenceError('');
    const { opened, failures } = await batch.add(
      api,
      hostId,
      inputs,
      currentRepository,
    );
    setReference(failures.map(failure => failure.input).join(' '));
    if (opened) onOpen(opened);
  };
  const pasteReferences = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    if (!/[\r\n]/.test(text)) return;
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart ?? reference.length;
    const end = input.selectionEnd ?? reference.length;
    setReference(
      `${reference.slice(0, start)}${text.replace(/\s+/g, ' ').trim()}${reference.slice(end)}`,
    );
    setReferenceError('');
  };
  const openReference = (event: FormEvent) => {
    event.preventDefault();
    const inputs = splitReferenceInput(reference);
    if (inputs.length > 1) {
      void openReferences(inputs);
      return;
    }
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
  const isAll = source.kind === 'all';
  const items: PullRequestSummary[] = isAll
    ? allItems
    : (result.list?.items ?? []);
  const listLoading = isAll
    ? all.status === 'loading'
    : result.status === 'loading';
  const truncated = isAll
    ? includedLists.some(list => list.status === 'ready' && list.truncated)
    : !!result.list?.truncated;
  const emptyTitle = query.trim()
    ? 'No pull requests match this search.'
    : scope === 'authored'
      ? isAll
        ? 'You have no open pull requests in the tracked repositories.'
        : 'You have no open pull requests in this repository.'
      : scope === 'review-requested'
        ? 'No reviews are requested from you here.'
        : 'No open pull requests.';
  return (
    <PanelBody className="min-w-0">
      <section
        aria-label="Pull requests"
        className="mx-auto w-full max-w-4xl space-y-2 px-5 py-5 lg:px-8"
      >
        <div className="flex flex-wrap items-center gap-2">
          {capable.length > 1 && (
            <Select value={hostId} onValueChange={chooseHost}>
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
          <div className="flex min-w-40 flex-1 flex-wrap items-center gap-1">
            <RepositorySourcePicker
              source={source}
              tracked={tracked.repositories}
              directory={directory}
              folderRepository={
                source.kind === 'folder'
                  ? (result.list?.repository ?? null)
                  : null
              }
              canTrack={canTrack}
              onSelect={chooseSource}
              onTrack={() => setTracking(true)}
            />
            {source.kind === 'all' && all.lists.length > 1 && (
              <RepositoryFilter
                lists={all.lists}
                excluded={excluded}
                onChange={changeExcluded}
              />
            )}
          </div>
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
          {reviewable && (
            <IconButton
              label="Select pull requests to review"
              pressed={selection.active}
              disabled={!api}
              onClick={selection.active ? selection.stop : selection.start}
            >
              <ListChecks className="size-3.5" />
            </IconButton>
          )}
          <IconButton
            label="Refresh pull requests"
            disabled={!api || listLoading}
            onClick={retry}
          >
            <RefreshCw
              className={cn('size-3.5', listLoading && 'animate-spin')}
            />
          </IconButton>
        </div>
        <form onSubmit={openReference}>
          <SearchField
            icon={<Link2 />}
            value={reference}
            maxLength={REFERENCE_INPUT_MAX_LENGTH}
            spellCheck={false}
            disabled={!!unavailable || batch.pending > 0}
            aria-label="Open pull requests by link or number"
            aria-invalid={!!referenceError}
            placeholder="Paste pull request links or #numbers"
            onPaste={pasteReferences}
            onChange={event => {
              setReference(event.target.value);
              setReferenceError('');
              batch.dismissFailures();
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
        {batch.pending > 0 && (
          <StatusMessage tone="loading" className="px-2">
            Opening {batch.pending}{' '}
            {batch.pending === 1 ? 'pull request' : 'pull requests'}…
          </StatusMessage>
        )}
        {batch.failures.length > 0 && (
          <ul aria-label="Pull requests that could not be opened">
            {batch.failures.map((failure, index) => (
              <li key={`${index}:${failure.input}`}>
                <StatusMessage tone="error" className="px-2">
                  <span className="font-mono">{failure.input}</span>:{' '}
                  {failure.reason}
                </StatusMessage>
              </li>
            ))}
          </ul>
        )}
        {batch.added.length > 0 && (
          <div>
            <SectionLabel
              action={
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={batch.clear}
                >
                  Clear
                </Button>
              }
            >
              Added
            </SectionLabel>
            <ul className="space-y-px">
              {batch.added.map(entry => (
                <PullRequestRow
                  key={`${entry.hostId}/${entry.pullRequest.repository}#${entry.pullRequest.number}`}
                  pullRequest={entry.pullRequest}
                  now={now}
                  showRepository
                  selected={
                    openTarget?.hostId === entry.hostId &&
                    sameReference(openTarget.reference, entry.pullRequest)
                  }
                  onOpen={() =>
                    onOpen({
                      hostId: entry.hostId,
                      reference: {
                        repository: entry.pullRequest.repository,
                        number: entry.pullRequest.number,
                      },
                    })
                  }
                />
              ))}
            </ul>
          </div>
        )}
        {selection.active && api && (
          <ReviewSelectionBar
            api={api}
            hostId={hostId}
            selected={selection.selected}
            full={selection.full}
            directory={reviewDirectory}
            onDone={selection.stop}
            onOpenSettings={onOpenCodeReviewSettings}
          />
        )}
        {unavailable ? (
          <InlineNotice>{unavailable}</InlineNotice>
        ) : source.kind === 'pending' ? (
          <SkeletonList
            label="Loading repositories"
            density="two-line"
            rows={4}
          />
        ) : source.kind === 'none' ? (
          <PullRequestListProblem
            icon={FolderGit2}
            title="No repository to list"
            description={
              canTrack
                ? 'Track the GitHub repositories you work on to list their pull requests here, or type owner/name in the repository picker.'
                : 'Type owner/name in the repository picker, or open a session in a project folder to list its pull requests.'
            }
            onTrack={startTracking}
          />
        ) : !isAll && result.status === 'error' ? (
          source.kind === 'folder' && isNotRepositoryError(result.error) ? (
            <PullRequestListProblem
              icon={FolderGit2}
              title="This folder is not a GitHub repository"
              description={`${directoryLabel(directory)} has no GitHub remote. Track a repository to list its pull requests here.`}
              details={result.error}
              onTrack={startTracking}
              onRetry={retry}
            />
          ) : (
            <PullRequestListProblem
              icon={TriangleAlert}
              title="Pull requests could not be loaded"
              description="Check the GitHub CLI login on this computer, or choose another repository."
              details={result.error}
              onTrack={startTracking}
              onRetry={retry}
            />
          )
        ) : isAll && all.status === 'error' ? (
          <PullRequestListProblem
            icon={TriangleAlert}
            title="Tracked pull requests could not be loaded"
            description="Check the connection to this computer and try again."
            details={all.error}
            onRetry={retry}
          />
        ) : listLoading && items.length === 0 && failedLists.length === 0 ? (
          <SkeletonList
            label="Loading pull requests"
            density="two-line"
            rows={6}
          />
        ) : (
          <>
            {failedLists.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <ul
                  aria-label="Repositories that could not be loaded"
                  className="min-w-0 flex-1 space-y-0.5"
                >
                  {failedLists.map(list => (
                    <li key={list.trackedId}>
                      <StatusMessage tone="error" className="px-2">
                        <span className="font-mono">{list.repository}</span>:{' '}
                        {list.message}
                      </StatusMessage>
                    </li>
                  ))}
                </ul>
                <Button type="button" size="xs" variant="ghost" onClick={retry}>
                  Try again
                </Button>
              </div>
            )}
            {items.length === 0 ? (
              !isAll ||
              includedLists.length === 0 ||
              failedLists.length < includedLists.length ? (
                <EmptyState
                  size="sm"
                  icon={GitPullRequest}
                  title={
                    isAll && includedLists.length === 0
                      ? 'Every tracked repository is filtered out.'
                      : emptyTitle
                  }
                />
              ) : null
            ) : (
              <div>
                <SectionLabel
                  action={
                    <span className="text-2xs text-muted-foreground tabular-nums">
                      {items.length}
                      {truncated ? '+' : ''} pull requests
                    </span>
                  }
                >
                  {isAll ? 'All tracked' : result.list?.repository}
                </SectionLabel>
                <ul
                  aria-busy={listLoading}
                  className={cn(
                    'space-y-px transition-opacity duration-base ease-out',
                    listLoading && 'opacity-60',
                  )}
                >
                  {items.map(item => (
                    <PullRequestRow
                      key={`${item.repository}#${item.number}`}
                      pullRequest={item}
                      now={now}
                      showRepository={isAll}
                      selected={
                        openTarget?.hostId === hostId &&
                        sameReference(openTarget.reference, item)
                      }
                      checked={
                        selection.active ? selection.has(item) : undefined
                      }
                      onOpen={() =>
                        selection.active
                          ? selection.toggle(item)
                          : onOpen({
                              hostId,
                              reference: {
                                repository: item.repository,
                                number: item.number,
                              },
                            })
                      }
                    />
                  ))}
                </ul>
                {truncated && (
                  <p className="px-2 pt-2 text-2xs text-muted-foreground">
                    {isAll
                      ? 'Showing the most recent pull requests of each repository. Search to narrow the list.'
                      : 'Showing the most recent pull requests. Search to narrow the list.'}
                  </p>
                )}
              </div>
            )}
          </>
        )}
        {tracking && api && (
          <TrackRepositoryDialog
            open
            onOpenChange={setTracking}
            api={api}
            hostId={hostId}
            computerName={computer?.name ?? 'This computer'}
            tracked={tracked.repositories}
            recentRepositories={recentPullRequestRepositories(hostId)}
            onTracked={added => {
              if (source.kind !== 'all') chooseSource(trackedKey(added.id));
            }}
          />
        )}
      </section>
    </PanelBody>
  );
}
