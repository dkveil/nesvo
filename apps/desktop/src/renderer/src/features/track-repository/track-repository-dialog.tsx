import { useEffect, useState, type FormEvent } from 'react';
import {
  parseGitHubRepository,
  type TrackedRepository,
  type TrackedRepositorySuggestion,
} from '@nesvo/contracts';
import { FolderGit2, GitPullRequest } from 'lucide-react';
import {
  setTrackedRepositories,
  type TrackedRepositoryApi,
} from '@/entities/tracked-repository';
import { errorDetail } from '@/entities/session';
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
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import { ListRow } from '@/shared/ui/list-row';
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusMessage } from '@/shared/ui/status-message';

type TrackRepositoryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: TrackedRepositoryApi;
  hostId: string;
  computerName: string;
  tracked: TrackedRepository[];
  recentRepositories?: string[];
  onTracked?: (repository: TrackedRepository) => void;
};

type Suggestions =
  | { status: 'loading'; items: TrackedRepositorySuggestion[] }
  | { status: 'ready'; items: TrackedRepositorySuggestion[] }
  | { status: 'error'; items: TrackedRepositorySuggestion[]; error: string };

const MAX_SHOWN_SUGGESTIONS = 8;

export function TrackRepositoryDialog({
  open,
  onOpenChange,
  api,
  hostId,
  computerName,
  tracked,
  recentRepositories = [],
  onTracked,
}: TrackRepositoryDialogProps) {
  const [repository, setRepository] = useState('');
  const [directory, setDirectory] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestions>({
    status: 'loading',
    items: [],
  });
  useEffect(() => {
    if (!open) return;
    let active = true;
    api.suggestTrackedRepositories().then(
      items => {
        if (active) setSuggestions({ status: 'ready', items });
      },
      (failure: unknown) => {
        if (active)
          setSuggestions({
            status: 'error',
            items: [],
            error: errorDetail(failure),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [api, open]);
  const known = new Set(tracked.map(item => item.repository.toLowerCase()));
  const shown = [
    ...suggestions.items,
    ...recentRepositories.map((name): TrackedRepositorySuggestion => ({
      repository: name,
      directory: null,
      source: 'pull-request',
    })),
  ]
    .filter(
      (item, index, all) =>
        !known.has(item.repository.toLowerCase()) &&
        all.findIndex(
          other =>
            other.repository.toLowerCase() === item.repository.toLowerCase(),
        ) === index,
    )
    .slice(0, MAX_SHOWN_SUGGESTIONS);
  const track = async (name: string, folder: string) => {
    if (!parseGitHubRepository(name)) {
      setError('Use owner/name or a GitHub repository link.');
      return;
    }
    setError('');
    setPending(name);
    try {
      const repositories = await api.addTrackedRepository({
        repository: name,
        ...(folder.trim() ? { directory: folder.trim() } : {}),
      });
      setTrackedRepositories(hostId, repositories);
      const canonical = parseGitHubRepository(name)!.toLowerCase();
      const added = repositories.find(
        item => item.repository.toLowerCase() === canonical,
      );
      setRepository('');
      setDirectory('');
      onOpenChange(false);
      if (added) onTracked?.(added);
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setPending('');
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void track(repository, directory);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!pending} className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Track a repository</DialogTitle>
            <DialogDescription>
              Pull requests from tracked repositories are listed together on the
              Pull requests page. {computerName} checks the repository with its
              GitHub CLI; no token is stored.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Field id="track-repository-name" label="Repository">
              <Input
                id="track-repository-name"
                size="md"
                value={repository}
                autoFocus
                spellCheck={false}
                maxLength={300}
                disabled={!!pending}
                aria-invalid={!!error}
                placeholder="owner/name or https://github.com/owner/name"
                onChange={event => {
                  setRepository(event.target.value);
                  setError('');
                }}
              />
            </Field>
            <Field
              id="track-repository-directory"
              label="Local checkout"
              hint={`Optional. A clone of this repository on ${computerName}, offered for reviews and automations.`}
            >
              <Input
                id="track-repository-directory"
                size="md"
                value={directory}
                spellCheck={false}
                maxLength={4096}
                disabled={!!pending}
                placeholder="Absolute path on this computer"
                onChange={event => {
                  setDirectory(event.target.value);
                  setError('');
                }}
              />
            </Field>
          </div>
          {error && <StatusMessage tone="error">{error}</StatusMessage>}
          {(shown.length > 0 || suggestions.status === 'loading') && (
            <div>
              <SectionLabel>Suggestions</SectionLabel>
              {suggestions.status === 'loading' && shown.length === 0 ? (
                <StatusMessage tone="loading" className="px-2">
                  Looking at session folders…
                </StatusMessage>
              ) : (
                <ul aria-label="Suggested repositories" className="space-y-px">
                  {shown.map(item => (
                    <li key={item.repository}>
                      <ListRow
                        density="two-line"
                        leading={
                          item.source === 'session-folder' ? (
                            <FolderGit2 className="size-3.5 text-muted-foreground" />
                          ) : (
                            <GitPullRequest className="size-3.5 text-muted-foreground" />
                          )
                        }
                        title={item.repository}
                        description={
                          item.directory ?? 'From a recent pull request'
                        }
                        onClick={() => {
                          setRepository(item.repository);
                          setDirectory(item.directory ?? '');
                          setError('');
                        }}
                        mainProps={{
                          'aria-label': `Fill in ${item.repository}`,
                          disabled: !!pending,
                        }}
                        actions={
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={!!pending}
                            aria-label={`Track ${item.repository}`}
                            onClick={() =>
                              void track(item.repository, item.directory ?? '')
                            }
                          >
                            {pending === item.repository
                              ? 'Tracking…'
                              : 'Track'}
                          </Button>
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {suggestions.status === 'error' && (
            <StatusMessage tone="warning">
              Suggestions are unavailable: {suggestions.error}
            </StatusMessage>
          )}
          <DialogFooter>
            <DialogCancel
              type="button"
              disabled={!!pending}
              onClick={() => onOpenChange(false)}
            />
            <Button
              type="submit"
              size="lg"
              disabled={!!pending || !repository.trim()}
              aria-busy={!!pending || undefined}
            >
              {pending && pending === repository
                ? 'Tracking…'
                : 'Track repository'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
