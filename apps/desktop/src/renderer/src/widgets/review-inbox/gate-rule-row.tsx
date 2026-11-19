import { useId, useState } from 'react';
import type {
  DecideGateRuleInput,
  GateRuleEdit,
  GateRuleProposal,
} from '@nesvo/contracts';
import { gateRuleEditSchema } from '@nesvo/contracts';
import { ArrowUpRight } from 'lucide-react';
import { errorDetail } from '@/entities/session';
import { formatDateTime } from '@/shared/lib/format-date';
import { hostKey } from '@/shared/lib/host-key';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { NativeDisclosure } from '@/shared/ui/disclosure';
import { Field } from '@/shared/ui/field';
import { SavedInField } from '@/shared/ui/saved-in-field';
import { Input } from '@/shared/ui/input';
import { DecisionRow } from '@/entities/review/decision-row';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { StatusMessage } from '@/shared/ui/status-message';
import { Textarea } from '@/shared/ui/textarea';

type Props = {
  row: GateRuleProposal;
  hostId: string;
  location: string;
  title: string;
  onSession: (key: string) => void;
  onSaved: (row: GateRuleProposal, hostId: string) => void;
};

export function GateRuleRow({
  row,
  hostId,
  location,
  title,
  onSession,
  onSaved,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { proposal } = row;
  const precedent = row.origin === 'precedent';
  const learned = row.origin === 'mapping' || row.origin === 'route';
  const sourceLabel =
    row.origin === 'mapping'
      ? 'Recorded evidence'
      : `From your ${row.decisionKind === 'accept' ? 'Approve' : row.decisionKind === 'fix' ? 'Fix' : 'Reject'} ${precedent || learned ? 'decision' : 'comment'}`;
  const label = precedent
    ? 'Decision precedent'
    : row.origin === 'mapping'
      ? 'Project command mapping'
      : row.origin === 'route'
        ? 'Workflow route proposal'
        : 'Gate rule proposal';

  const decide = async (
    decisionFields:
      { action: 'accept' | 'dismiss' } | { action: 'edit'; edit: GateRuleEdit },
  ) => {
    const decision: DecideGateRuleInput = {
      proposalId: row.id,
      revision: row.revision,
      decisionId: crypto.randomUUID(),
      ...decisionFields,
    };
    setBusy(true);
    setError('');
    try {
      const overview = await window.nesvo.gateRules(
        { action: 'decide', decision },
        hostId,
      );
      const saved = overview.proposals.find(item => item.id === row.id);
      if (saved?.status === 'accepted' || saved?.status === 'dismissed')
        onSaved(saved, hostId);
      if (saved?.status === 'stale') setEditing(false);
    } catch (reason) {
      setError(errorDetail(reason));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(proposal.body.check);
    } catch (reason) {
      setError(errorDetail(reason));
    }
  };

  return (
    <article aria-label={label} data-host-id={hostId}>
      <DecisionRow
        heading={
          <>
            <p className="font-medium text-muted-foreground">{label}</p>
            <Button
              variant="link"
              size="inline"
              className="min-w-0 max-w-full text-ui text-foreground"
              onClick={() =>
                onSession(hostKey(row.taskSessionId ?? row.sessionId, hostId))
              }
            >
              <span className="truncate">{title}</span>
              <ArrowUpRight className="size-3 text-muted-foreground" />
            </Button>
            {location && <p className="text-muted-foreground">{location}</p>}
          </>
        }
        details={
          <>
            <div className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
              <span>
                {precedent
                  ? 'Decision at'
                  : learned
                    ? 'Workflow evidence from'
                    : 'Proposes a gate rule for'}{' '}
                {proposal.steps.join(', ')} · {row.workflow}
              </span>
              <Badge size="xs">
                {precedent
                  ? 'Precedent'
                  : proposal.kind === 'check'
                    ? 'Check suggestion'
                    : 'Instruction'}
              </Badge>
              <span>{row.scope === 'project' ? 'Project' : 'Global'}</span>
              <time dateTime={row.createdAt}>
                {formatDateTime(row.createdAt)}
              </time>
            </div>
            {row.current && (
              <p className="text-xs text-muted-foreground line-through [overflow-wrap:anywhere]">
                {row.current.rule}
              </p>
            )}
            <p className="text-ui whitespace-pre-wrap [overflow-wrap:anywhere]">
              {proposal.body.rule}
            </p>
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {sourceLabel}: “{proposal.quote}”
            </p>
            {proposal.kind === 'check' && (
              <div className="space-y-1 text-xs text-muted-foreground">
                <p className="font-mono [overflow-wrap:anywhere]">
                  {proposal.body.check}
                </p>
                {!learned && <p>Apply the check in your project when ready.</p>}
                {/\b(?:curl|wget|gh\s+pr|git\s+push|rm\s+-rf)\b/i.test(
                  proposal.body.check,
                ) && (
                  <StatusMessage tone="warning">
                    Review this suggestion for network access or changes before
                    using it.
                  </StatusMessage>
                )}
                <Button
                  variant="link"
                  size="inline"
                  onClick={() => void copy()}
                >
                  Copy suggestion
                </Button>
              </div>
            )}
            <NativeDisclosure title="Proposal details">
              <p className="mb-1 [overflow-wrap:anywhere]">
                {proposal.justification}
              </p>
              <Button
                variant="link"
                size="inline"
                onClick={() => onSession(hostKey(row.sessionId, hostId))}
              >
                {row.origin ? 'Open source session' : 'Open proposal session'}
              </Button>
            </NativeDisclosure>
          </>
        }
      >
        <div data-inbox-actions className="flex-wrap">
          {row.status === 'pending' && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || editing}
              onClick={() => void decide({ action: 'accept' })}
            >
              Accept
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setEditing(open => !open)}
          >
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void decide({ action: 'dismiss' })}
          >
            Dismiss
          </Button>
        </div>
        {(error || row.error) && (
          <StatusMessage className="col-span-full" tone="error">
            {error || row.error}
          </StatusMessage>
        )}
        {editing && (
          <GateRuleEditor
            key={row.revision}
            row={row}
            busy={busy}
            onSave={edit => void decide({ action: 'edit', edit })}
            onCancel={() => setEditing(false)}
          />
        )}
      </DecisionRow>
    </article>
  );
}

function GateRuleEditor({
  row,
  busy,
  onSave,
  onCancel,
}: {
  row: GateRuleProposal;
  busy: boolean;
  onSave: (edit: GateRuleEdit) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const { proposal } = row;
  const [edit, setEdit] = useState({
    description: proposal.description,
    steps: proposal.steps.join(', '),
    body: proposal.body,
    kind: proposal.kind,
    scope: row.scope,
  });
  const parsed = gateRuleEditSchema.safeParse({
    ...edit,
    steps: edit.steps
      .split(',')
      .map(step => step.trim())
      .filter(Boolean),
  });
  return (
    <form
      className="col-span-full grid gap-x-4 gap-y-2 border-t py-2 sm:grid-cols-2"
      aria-label="Edit gate rule"
      onSubmit={event => {
        event.preventDefault();
        if (parsed.success && !busy) onSave(parsed.data);
      }}
    >
      <Field label="Description" id={`${id}-description`}>
        <Input
          id={`${id}-description`}
          value={edit.description}
          onChange={event =>
            setEdit({ ...edit, description: event.target.value })
          }
        />
      </Field>
      <Field label="Rule" id={`${id}-rule`} className="sm:col-span-2">
        <Textarea
          id={`${id}-rule`}
          resize="none"
          rows={2}
          value={edit.body.rule}
          onChange={event =>
            setEdit({
              ...edit,
              body: { ...edit.body, rule: event.target.value },
            })
          }
        />
      </Field>
      <Field label="Why" id={`${id}-why`}>
        <Input
          id={`${id}-why`}
          value={edit.body.why}
          onChange={event =>
            setEdit({
              ...edit,
              body: { ...edit.body, why: event.target.value },
            })
          }
        />
      </Field>
      <Field label="Check" id={`${id}-check`}>
        <Input
          id={`${id}-check`}
          value={edit.body.check}
          onChange={event =>
            setEdit({
              ...edit,
              body: { ...edit.body, check: event.target.value },
            })
          }
        />
      </Field>
      <Field label="Target steps (comma-separated)" id={`${id}-steps`}>
        <Input
          id={`${id}-steps`}
          value={edit.steps}
          onChange={event => setEdit({ ...edit, steps: event.target.value })}
        />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Field label="Kind" id={`${id}-kind`}>
          <Select
            value={edit.kind}
            onValueChange={kind => {
              if (kind === 'instruction' || kind === 'check')
                setEdit({ ...edit, kind });
            }}
          >
            <SelectTrigger id={`${id}-kind`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="instruction">Instruction</SelectItem>
              <SelectItem value="check">Check suggestion</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <SavedInField
          id={`${id}-scope`}
          scope={edit.scope}
          className="min-w-0 flex-1"
          disabled={busy}
          onChange={scope => setEdit({ ...edit, scope })}
        />
      </div>
      {!parsed.success && (
        <StatusMessage tone="error" className="sm:col-span-2">
          {parsed.error.issues[0]?.message}
        </StatusMessage>
      )}
      <div className="flex justify-end gap-1 sm:col-span-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy || !parsed.success}>
          Save rule
        </Button>
      </div>
    </form>
  );
}
