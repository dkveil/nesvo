import { useState, type ClipboardEvent, type FormEvent } from 'react';
import {
  GITHUB_REPOSITORY_PATTERN,
  type Computer,
  type DesktopApi,
  type PullRequestListScope,
} from '@nesvo/contracts';
import { GitPullRequest, Link2, ListChecks, RefreshCw } from 'lucide-react';
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
  apiFor: (hostId: string) => (PullRequestApi & ReviewStartApi) | null;
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
  const [repositoryDraft, setRepositoryDraft] = useState('');
  const [repository, setRepository] = useState('');
  const [repositoryError, setRepositoryError] = useState('');
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
            hostId={result.hostId}
            selected={selection.selected}
            full={selection.full}
            directory={directory}
            onDone={selection.stop}
            onOpenSettings={onOpenCodeReviewSettings}
          />
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
                  checked={selection.active ? selection.has(item) : undefined}
                  onOpen={() =>
                    selection.active
                      ? selection.toggle(item)
                      : onOpen({
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
