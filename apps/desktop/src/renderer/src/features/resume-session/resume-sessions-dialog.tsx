import { useId, useRef, useState } from 'react';
import {
  RESUME_CONTINUATION_LEAD,
  resumeContinuationText,
  type Computer,
} from '@nesvo/contracts';
import { sessionProjectLabel, type Session } from '@/entities/session';
import { entityKey } from '@/shared/lib/host-key';
import { Button } from '@/shared/ui/button';
import { Checkbox } from '@/shared/ui/checkbox';
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { EmptyState } from '@/shared/ui/empty-state';
import { Field } from '@/shared/ui/field';
import { Label } from '@/shared/ui/label';
import { StatusMessage } from '@/shared/ui/status-message';
import { Textarea } from '@/shared/ui/textarea';
import type { ResumeCandidate } from './resume-candidates';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: ResumeCandidate[];
  computers: Computer[];
  resume: (
    session: Session,
    messageId: string,
    text: string,
  ) => Promise<string | null>;
};

const LEAD_LIMIT = 2000;

const statusLabels: Partial<Record<Session['status'], string>> = {
  failed: 'Failed',
  interrupted: 'Interrupted',
  stopped: 'Stopped',
};

const sessionCount = (count: number) =>
  `${count} session${count === 1 ? '' : 's'}`;

function CandidateRow({
  candidate,
  checked,
  computerName,
  preview,
  error,
  disabled,
  onCheckedChange,
}: {
  candidate: ResumeCandidate;
  checked: boolean;
  computerName: string;
  preview: string;
  error: string;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { session, restartOnly } = candidate;
  const details = [
    statusLabels[session.status],
    sessionProjectLabel(session),
    computerName,
    restartOnly ? 'Needs Restart' : '',
  ].filter(Boolean);
  return (
    <li>
      <Label
        data-resume-candidate={session.id}
        className="flex min-w-0 cursor-pointer items-start gap-2.5 rounded-control px-2.5 py-1.5 font-normal transition-colors duration-100 hover:bg-accent"
      >
        <Checkbox
          className="mt-0.5"
          checked={checked}
          disabled={disabled || restartOnly}
          onCheckedChange={value => onCheckedChange(value === true)}
        />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="block truncate text-ui leading-5 text-foreground">
            {session.title}
          </span>
          <span className="block truncate text-2xs leading-4 text-muted-foreground">
            {details.join(' · ')}
          </span>
          {!restartOnly && (
            <span className="line-clamp-2 text-2xs leading-4 text-muted-foreground">
              {preview}
            </span>
          )}
          {error && <StatusMessage tone="error">{error}</StatusMessage>}
        </span>
      </Label>
    </li>
  );
}

export function ResumeSessionsDialog({
  open,
  onOpenChange,
  candidates,
  computers,
  resume,
}: Props) {
  const id = useId();
  const [lead, setLead] = useState(RESUME_CONTINUATION_LEAD);
  const [includeDetail, setIncludeDetail] = useState(true);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const messageIds = useRef(new Map<string, string>());
  const isChecked = (candidate: ResumeCandidate) =>
    !candidate.restartOnly &&
    candidate.selectedByDefault !== toggled.has(entityKey(candidate.session));
  const selected = candidates.filter(isChecked);
  const textOf = (session: Session) =>
    includeDetail ? resumeContinuationText(session, lead) : lead.trim();
  const computerName = (hostId: string) =>
    computers.length > 1
      ? (computers.find(computer => computer.id === hostId)?.name ?? hostId)
      : '';
  const reset = () => {
    setLead(RESUME_CONTINUATION_LEAD);
    setIncludeDetail(true);
    setToggled(new Set());
    setErrors({});
    messageIds.current = new Map();
  };
  const close = (next: boolean) => {
    if (pending) return;
    if (!next) reset();
    onOpenChange(next);
  };
  const toggle = (session: Session) =>
    setToggled(previous => {
      const next = new Set(previous);
      const key = entityKey(session);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const messageIdOf = (session: Session) => {
    const key = entityKey(session);
    const existing = messageIds.current.get(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    messageIds.current.set(key, created);
    return created;
  };
  const resumeSelected = async () => {
    if (!lead.trim() || selected.length === 0) return;
    setPending(true);
    const failures: Record<string, string> = {};
    for (const { session } of selected) {
      const error = await resume(
        session,
        messageIdOf(session),
        textOf(session),
      );
      if (error) failures[entityKey(session)] = error;
    }
    setPending(false);
    setErrors(failures);
    if (Object.keys(failures).length === 0) {
      reset();
      onOpenChange(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="gap-4 sm:max-w-lg" data-resume-sessions="">
        <DialogHeader>
          <DialogTitle>Resume sessions</DialogTitle>
          <DialogDescription>
            Each selected session receives this message in its own provider
            conversation, folder, group and permission mode. Nothing runs until
            you resume. Sessions without a resumable conversation need Restart.
          </DialogDescription>
        </DialogHeader>
        <Field id={id} label="Continuation message">
          <Textarea
            id={id}
            value={lead}
            maxLength={LEAD_LIMIT}
            rows={2}
            disabled={pending}
            onChange={event => setLead(event.target.value)}
          />
        </Field>
        <Label className="text-xs font-normal">
          <Checkbox
            checked={includeDetail}
            disabled={pending}
            onCheckedChange={value => setIncludeDetail(value === true)}
          />
          Add how each session stopped, including its error
        </Label>
        {candidates.length > 0 ? (
          <div className="space-y-1">
            <div className="flex justify-end px-2.5">
              <span
                className="text-2xs text-muted-foreground tabular-nums"
                data-resume-count=""
              >
                {selected.length} of {sessionCount(candidates.length)} selected
              </span>
            </div>
            <ul
              aria-label="Sessions to resume"
              className="max-h-72 overflow-y-auto rounded-surface border p-1"
            >
              {candidates.map(candidate => (
                <CandidateRow
                  key={entityKey(candidate.session)}
                  candidate={candidate}
                  checked={isChecked(candidate)}
                  computerName={computerName(candidate.session.hostId)}
                  preview={textOf(candidate.session)}
                  error={errors[entityKey(candidate.session)] ?? ''}
                  disabled={pending}
                  onCheckedChange={() => toggle(candidate.session)}
                />
              ))}
            </ul>
          </div>
        ) : (
          <EmptyState
            size="sm"
            title="No failed, interrupted or stopped sessions."
            className="rounded-surface border"
          />
        )}
        <DialogFooter>
          <DialogCancel onClick={() => close(false)} disabled={pending} />
          <Button
            size="lg"
            disabled={pending || !lead.trim() || selected.length === 0}
            aria-busy={pending || undefined}
            onClick={() => void resumeSelected()}
          >
            {pending
              ? 'Resuming…'
              : selected.length > 0
                ? `Resume ${sessionCount(selected.length)}`
                : 'Resume selected'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
