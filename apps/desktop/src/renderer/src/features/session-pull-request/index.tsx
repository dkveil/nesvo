import { useState, type FormEvent } from 'react';
import type { PullRequestReference } from '@nesvo/contracts';
import { GitPullRequest, Search } from 'lucide-react';
import {
  checksLabels,
  parseReferenceInput,
  PullRequestStateIcon,
  usePullRequestDetails,
  visualState,
  visualStateLabels,
  type PullRequestApi,
} from '@/entities/pull-request';
import { errorDetail, type Session } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Chip } from '@/shared/ui/chip';
import { Field } from '@/shared/ui/field';
import { IconButton } from '@/shared/ui/icon-button';
import { Input } from '@/shared/ui/input';
import { ListRow } from '@/shared/ui/list-row';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { StatusDot } from '@/shared/ui/status-dot';
import { StatusMessage } from '@/shared/ui/status-message';
import { Hint } from '@/shared/ui/tooltip';
import { checksDotTones } from './checks-dot-tones';

const LINK_FIELD_ID = 'session-pull-request-link';

type SessionPullRequestProps = {
  session: Session;
  unavailableReason: string;
  api: PullRequestApi;
  reviewing?: boolean;
  onOpen: (reference: PullRequestReference) => void;
  onLinked: (session: Session) => void;
  onFinishAfterMerge?: () => void;
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
  reviewing = false,
  onOpen,
  onLinked,
  onFinishAfterMerge,
}: SessionPullRequestProps) {
  const linked = session.pullRequest;
  const { data } = usePullRequestDetails({
    hostId: session.hostId,
    reference: linked,
    api,
    enabled: !unavailableReason,
  });
  const state = data ? visualState(data) : null;
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState<FindState>({ status: 'idle' });
  const [text, setText] = useState('');
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState('');
  if (linked)
    return (
      <>
        <Hint
          label={
            data ? `${linked.repository} · ${data.title}` : linked.repository
          }
          side="bottom"
        >
          <Chip
            size="sm"
            selected={reviewing}
            data-session-pull-request={`${linked.repository}#${linked.number}`}
            aria-label={[
              `Review pull request #${linked.number}`,
              state && visualStateLabels[state],
              data && data.checks !== 'none' && checksLabels[data.checks],
            ]
              .filter(Boolean)
              .join(', ')}
            onClick={() => onOpen(linked)}
            icon={
              state ? (
                <PullRequestStateIcon state={state} className="size-3" />
              ) : (
                <GitPullRequest aria-hidden="true" className="size-3" />
              )
            }
            className="tabular-nums"
          >
            <span>#{linked.number}</span>
            {state && (
              <span className="text-2xs">{visualStateLabels[state]}</span>
            )}
            {data && data.checks !== 'none' && (
              <StatusDot tone={checksDotTones[data.checks]} />
            )}
          </Chip>
        </Hint>
        {data?.state === 'merged' && onFinishAfterMerge && (
          <Button
            variant="ghost"
            size="xs"
            data-finish-after-merge-trigger=""
            onClick={onFinishAfterMerge}
          >
            Finish after merge…
          </Button>
        )}
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
    <Popover
      open={open}
      onOpenChange={value => {
        setOpen(value);
        if (!value) setError('');
      }}
    >
      <PopoverTrigger asChild>
        <IconButton label="Link a pull request" size={24} tooltipSide="bottom">
          <GitPullRequest />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" size="md" className="space-y-3">
        <div className="space-y-1.5">
          <p className="text-ui font-medium">Link a pull request</p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={find.status === 'pending' || linking}
              onClick={() => void findForBranch()}
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
            <StatusMessage tone="error">{find.message}</StatusMessage>
          )}
          {find.status === 'found' && (
            <ListRow
              className="animate-in bg-accent duration-base ease-out fade-in-0"
              leading={<GitPullRequest />}
              title={
                <>
                  {find.reference.repository}{' '}
                  <span className="tabular-nums">#{find.reference.number}</span>
                </>
              }
              trailing={
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setOpen(false);
                      onOpen(find.reference);
                    }}
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
                </>
              }
            />
          )}
        </div>
        <form onSubmit={submit} className="space-y-1.5 border-t pt-3">
          <Field id={LINK_FIELD_ID} label="Link pull request…">
            <div className="flex items-center gap-1.5">
              <Input
                id={LINK_FIELD_ID}
                value={text}
                maxLength={300}
                spellCheck={false}
                placeholder="https://github.com/owner/name/pull/123"
                aria-invalid={!!error}
                onChange={event => {
                  setText(event.target.value);
                  setError('');
                }}
              />
              <Button type="submit" disabled={!text.trim() || linking}>
                Link
              </Button>
            </div>
          </Field>
          {error && <StatusMessage tone="error">{error}</StatusMessage>}
        </form>
      </PopoverContent>
    </Popover>
  );
}
