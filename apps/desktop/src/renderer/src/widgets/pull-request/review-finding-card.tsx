import { useState } from 'react';
import {
  REVIEW_SEVERITY_ORDER,
  codeReviewLimits,
  reviewFindingTypeSchema,
  type ReviewDraftFinding,
  type ReviewFindingType,
  type ReviewSeverity,
  type UpdateReviewFindingInput,
} from '@nesvo/contracts';
import { BookmarkPlus, Check, Pencil, X } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import {
  findingTypeLabels,
  lineRange,
  severityLabels,
  severityTones,
} from '@/features/code-review';
import { MessageBody } from '@/widgets/conversation/message-body';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { Field } from '@/shared/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { Textarea } from '@/shared/ui/textarea';

type FindingChanges = Omit<
  UpdateReviewFindingInput,
  'draftId' | 'findingId' | 'expectedRevision'
>;

type ReviewFindingCardProps = {
  finding: ReviewDraftFinding;
  editable: boolean;
  pending: boolean;
  onChange: (changes: FindingChanges) => Promise<boolean>;
  onSaveRule: (finding: ReviewDraftFinding) => void;
};

const stateLabels = {
  pending: 'Not decided',
  kept: 'Kept',
  discarded: 'Discarded',
} as const satisfies Record<ReviewDraftFinding['state'], string>;

export function ReviewFindingCard({
  finding,
  editable,
  pending,
  onChange,
  onSaveRule,
}: ReviewFindingCardProps) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(finding.body);
  const [suggestion, setSuggestion] = useState(finding.suggestion ?? '');
  const [severity, setSeverity] = useState<ReviewSeverity>(finding.severity);
  const [type, setType] = useState<ReviewFindingType>(finding.type);
  const discarded = finding.state === 'discarded';
  const startEditing = () => {
    setBody(finding.body);
    setSuggestion(finding.suggestion ?? '');
    setSeverity(finding.severity);
    setType(finding.type);
    setEditing(true);
  };
  const save = async () => {
    const saved = await onChange({
      body: body.trim(),
      severity,
      type,
      suggestion: type === 'suggestion' ? suggestion : null,
      state: 'kept',
    });
    if (saved) setEditing(false);
  };
  return (
    <article
      aria-label={`${findingTypeLabels[finding.type]} on ${finding.path} ${lineRange(finding)}`}
      data-finding-id={finding.id}
      data-finding-state={finding.state}
      className={cn(
        'rounded-surface border bg-card text-foreground transition-opacity duration-base',
        discarded && 'opacity-60',
      )}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
        <Badge size="xs" tone={severityTones[finding.severity]}>
          {severityLabels[finding.severity]}
        </Badge>
        <Badge size="xs" appearance="outline">
          {findingTypeLabels[finding.type]}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
          {finding.path} {lineRange(finding)}
        </span>
        {finding.edited && (
          <Badge size="xs" appearance="outline">
            Edited
          </Badge>
        )}
        <Badge
          size="xs"
          tone={finding.state === 'kept' ? 'success' : 'neutral'}
        >
          {stateLabels[finding.state]}
        </Badge>
      </header>
      {editing ? (
        <div className="grid gap-2 p-3">
          <div className="grid grid-cols-2 gap-2">
            <Field id={`finding-${finding.id}-type`} label="Type">
              <Select
                value={type}
                onValueChange={value => setType(value as ReviewFindingType)}
                disabled={pending}
              >
                <SelectTrigger
                  id={`finding-${finding.id}-type`}
                  size="sm"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {reviewFindingTypeSchema.options.map(option => (
                    <SelectItem key={option} value={option}>
                      {findingTypeLabels[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id={`finding-${finding.id}-severity`} label="Severity">
              <Select
                value={severity}
                onValueChange={value => setSeverity(value as ReviewSeverity)}
                disabled={pending}
              >
                <SelectTrigger
                  id={`finding-${finding.id}-severity`}
                  size="sm"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {REVIEW_SEVERITY_ORDER.map(option => (
                    <SelectItem key={option} value={option}>
                      {severityLabels[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field id={`finding-${finding.id}-body`} label="Comment">
            <Textarea
              id={`finding-${finding.id}-body`}
              size="sm"
              rows={4}
              value={body}
              maxLength={codeReviewLimits.findingBody}
              disabled={pending}
              onChange={event => setBody(event.target.value)}
            />
          </Field>
          {type === 'suggestion' && (
            <Field
              id={`finding-${finding.id}-suggestion`}
              label="Suggested code"
              hint={`Replaces ${lineRange(finding)} when the author applies it.`}
            >
              <Textarea
                id={`finding-${finding.id}-suggestion`}
                size="sm"
                rows={4}
                value={suggestion}
                maxLength={codeReviewLimits.suggestion}
                spellCheck={false}
                disabled={pending}
                className="font-mono"
                onChange={event => setSuggestion(event.target.value)}
              />
            </Field>
          )}
          <div className="flex justify-end gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={pending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={pending || !body.trim()}
              onClick={() => void save()}
            >
              Save and keep
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 px-3 py-2">
          <MessageBody body={finding.body} className="text-xs leading-5" />
          {finding.suggestion !== null && (
            <CodeBlock
              code={finding.suggestion}
              label="Suggested code"
              copyable
              wrap
            />
          )}
        </div>
      )}
      {editable && !editing && (
        <footer className="flex flex-wrap items-center gap-1 border-t px-2 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            selected={finding.state === 'kept'}
            aria-pressed={finding.state === 'kept'}
            disabled={pending}
            onClick={() =>
              void onChange({
                state: finding.state === 'kept' ? 'pending' : 'kept',
              })
            }
          >
            <Check />
            Keep
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            selected={discarded}
            aria-pressed={discarded}
            disabled={pending}
            onClick={() =>
              void onChange({ state: discarded ? 'pending' : 'discarded' })
            }
          >
            <X />
            Discard
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={pending}
            onClick={startEditing}
          >
            <Pencil />
            Edit
          </Button>
          {(discarded || finding.edited) && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="ml-auto"
              disabled={pending}
              onClick={() => onSaveRule(finding)}
            >
              <BookmarkPlus />
              Save as rule
            </Button>
          )}
        </footer>
      )}
    </article>
  );
}
