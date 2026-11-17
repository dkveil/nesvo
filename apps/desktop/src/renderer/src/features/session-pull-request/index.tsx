import { useState, type FormEvent } from 'react';
import type { PullRequestReference } from '@nesvo/contracts';
import { GitPullRequest, Search } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import {
  parseReferenceInput,
  PullRequestStateIcon,
  visualStateLabels,
  type PullRequestApi,
} from '@/entities/pull-request';
import { errorDetail, type Session } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';
import { useLinkedState } from './use-linked-state';

type SessionPullRequestProps = {
  session: Session;
  unavailableReason: string;
  api: PullRequestApi;
  onOpen: (reference: PullRequestReference) => void;
  onLinked: (session: Session) => void;
};

type FindState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'found'; reference: PullRequestReference }
  | { status: 'missing' }
  | { status: 'error'; message: string };

export function SessionPullRequest({
  session,
  unavailableReason,
  api,
  onOpen,
  onLinked,
}: SessionPullRequestProps) {
  const linked = session.pullRequest;
  const state = useLinkedState({
    hostId: session.hostId,
    reference: linked,
    api,
    enabled: !unavailableReason,
  });
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState<FindState>({ status: 'idle' });
  const [text, setText] = useState('');
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState('');
  if (linked)
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Open pull request #${linked.number}${state ? `, ${visualStateLabels[state]}` : ''}`}
              onClick={() => onOpen(linked)}
              className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground tabular-nums transition-colors duration-150 ease-out outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            >
              {state ? (
                <PullRequestStateIcon state={state} className="size-3" />
              ) : (
                <GitPullRequest
                  aria-hidden="true"
                  className="size-3 shrink-0 text-muted-foreground"
                />
              )}
              #{linked.number}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{linked.repository}</TooltipContent>
        </Tooltip>
      </>
    );
  if (unavailableReason) return null;
  const link = async (reference: PullRequestReference) => {
    if (linking) return;
    setLinking(true);
    setError('');
    try {
      onLinked(
        await api.linkSessionPullRequest({
          sessionId: session.id,
          pullRequest: reference,
        }),
      );
      setOpen(false);
      setText('');
      setFind({ status: 'idle' });
    } catch (failure) {
      setError(`Could not link. ${errorDetail(failure)}`);
    } finally {
      setLinking(false);
    }
  };
  const findForBranch = async () => {
    setFind({ status: 'pending' });
    setError('');
    try {
      const reference = await api.findSessionPullRequest({
        sessionId: session.id,
      });
      setFind(
        reference ? { status: 'found', reference } : { status: 'missing' },
      );
    } catch (failure) {
      setFind({ status: 'error', message: errorDetail(failure) });
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const reference = parseReferenceInput(
      text,
      find.status === 'found' ? find.reference.repository : null,
    );
    if (!reference) {
      setError('Paste a GitHub pull request link.');
      return;
    }
    void link(reference);
  };
  return (
    <>
      <Popover
        open={open}
        onOpenChange={value => {
          setOpen(value);
          if (!value) setError('');
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Link a pull request"
                className="text-muted-foreground enabled:hover:text-foreground data-[state=open]:bg-highlight data-[state=open]:text-foreground"
              >
                <GitPullRequest className="size-3.5" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Pull request</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-80 space-y-3 p-3">
          <div className="space-y-1.5">
            <p className="text-xs font-medium">Link a pull request</p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={find.status === 'pending' || linking}
                onClick={() => void findForBranch()}
                className="disabled:cursor-not-allowed"
              >
                <Search />
                {find.status === 'pending' ? 'Looking…' : 'Find pull request'}
              </Button>
              <span className="min-w-0 text-2xs text-muted-foreground">
                {find.status === 'missing'
                  ? 'None found for this branch.'
                  : find.status === 'idle'
                    ? 'Uses the session branch.'
                    : ''}
              </span>
            </div>
            {find.status === 'error' && (
              <p
                role="alert"
                className="text-2xs text-error-foreground [overflow-wrap:anywhere]"
              >
                {find.message}
              </p>
            )}
            {find.status === 'found' && (
              <div className="flex animate-in items-center gap-2 rounded-md bg-accent px-2 py-1.5 text-xs duration-150 fade-in-0">
                <GitPullRequest
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate">
                  {find.reference.repository}{' '}
                  <span className="tabular-nums">#{find.reference.number}</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setOpen(false);
                    onOpen(find.reference);
                  }}
                  className="text-muted-foreground"
                >
                  Open
                </Button>
                <Button
                  type="button"
                  size="xs"
                  disabled={linking}
                  onClick={() => void link(find.reference)}
                >
                  {linking ? 'Linking…' : 'Link'}
                </Button>
              </div>
            )}
          </div>
          <form onSubmit={submit} className="space-y-1.5 border-t pt-3">
            <label
              htmlFor="session-pull-request-link"
              className="block text-2xs text-muted-foreground"
            >
              Link pull request…
            </label>
            <div className="flex items-center gap-1.5">
              <input
                id="session-pull-request-link"
                value={text}
                maxLength={300}
                spellCheck={false}
                placeholder="https://github.com/owner/name/pull/123"
                aria-invalid={!!error}
                onChange={event => {
                  setText(event.target.value);
                  setError('');
                }}
                className={cn(
                  'h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50',
                  error && 'border-destructive',
                )}
              />
              <Button
                type="submit"
                size="xs"
                disabled={!text.trim() || linking}
                className="h-7 disabled:cursor-not-allowed"
              >
                Link
              </Button>
            </div>
            {error && (
              <p
                role="alert"
                className="text-2xs text-error-foreground [overflow-wrap:anywhere]"
              >
                {error}
              </p>
            )}
          </form>
        </PopoverContent>
      </Popover>
    </>
  );
}
