import { useState } from 'react';
import {
  RULE_ENTRY_TRIGGER,
  lessonChangesSchema,
  localDate,
  ruleEntryLimits,
  ruleEntryProviderSchema,
  ruleEntryRoleSchema,
  type Lesson,
  type LessonChanges,
  type RuleEntryProvider,
  type RuleEntryRole,
} from '@nesvo/contracts';
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
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { StatusMessage } from '@/shared/ui/status-message';
import { Textarea } from '@/shared/ui/textarea';
import { lessonRoleLabels } from './labels';

type LessonEditDialogProps = {
  lesson: Lesson;
  approve: boolean;
  pending: boolean;
  error: string;
  onSubmit: (changes: LessonChanges) => void;
  onClose: () => void;
};

const PROVIDER_LABELS: Record<RuleEntryProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

const listText = (values: readonly string[] | undefined) =>
  values?.join(', ') ?? '';

const listValue = (text: string) => {
  const values = text
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
};

const toggled = <T,>(values: T[], value: T, on: boolean) =>
  on ? [...new Set([...values, value])] : values.filter(item => item !== value);

export function LessonEditDialog({
  lesson,
  approve,
  pending,
  error,
  onSubmit,
  onClose,
}: LessonEditDialogProps) {
  const [description, setDescription] = useState(lesson.description);
  const [kind, setKind] = useState(lesson.kind);
  const [rule, setRule] = useState(lesson.body.rule);
  const [why, setWhy] = useState(lesson.body.why);
  const [check, setCheck] = useState(lesson.body.check);
  const [providers, setProviders] = useState<RuleEntryProvider[]>(
    lesson.scope.providers ?? [],
  );
  const [roles, setRoles] = useState<RuleEntryRole[]>(lesson.scope.roles ?? []);
  const [workflows, setWorkflows] = useState(listText(lesson.scope.workflows));
  const [steps, setSteps] = useState(listText(lesson.scope.steps));
  const [paths, setPaths] = useState(listText(lesson.scope.paths));
  const [enforcedBy, setEnforcedBy] = useState(lesson.enforcedBy);
  const [review, setReview] = useState(lesson.review ?? '');
  const [project, setProject] = useState(lesson.project ?? '');
  const [today] = useState(() => localDate(new Date()));
  const proposal = lesson.state === 'proposed';
  const changes = lessonChangesSchema.safeParse({
    description: description.trim(),
    kind,
    body: { rule: rule.trim(), why: why.trim(), check: check.trim() },
    scope: {
      providers: providers.length ? providers : undefined,
      roles: roles.length ? roles : undefined,
      workflows: listValue(workflows),
      steps: listValue(steps),
      paths: listValue(paths),
    },
    enforcedBy: enforcedBy.trim() || 'none',
    ...(review && review !== lesson.review ? { review } : {}),
    ...(proposal ? { project: project.trim() || null } : {}),
  });
  const reviewValid = !review || review > today || review === lesson.review;
  const issue = changes.success ? '' : (changes.error.issues[0]?.message ?? '');
  const valid = changes.success && reviewValid;
  const submit = () => {
    if (!valid || pending || !changes.success) return;
    onSubmit(changes.data);
  };
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent showCloseButton={!pending} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {approve ? 'Approve lesson' : `Edit ${lesson.id ?? 'lesson'}`}
          </DialogTitle>
          <DialogDescription>
            Approved lessons are files in the workflows folder. Agents always
            see the description; the rule, Why and Check load only when a
            workflow, step or path matches.
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[60vh] gap-3 overflow-y-auto pr-1">
          <Field
            id="lesson-description"
            label="Description"
            hint={`Third person, starting with "${RULE_ENTRY_TRIGGER} …".`}
          >
            <Input
              id="lesson-description"
              size="md"
              value={description}
              maxLength={ruleEntryLimits.description}
              disabled={pending}
              onChange={event => setDescription(event.target.value)}
            />
          </Field>
          <SegmentedControl
            label="Lesson kind"
            value={kind}
            fullWidth
            options={[
              { value: 'instruction', label: 'Instruction' },
              { value: 'check', label: 'Check' },
            ]}
            onChange={setKind}
            disabled={pending}
          />
          <Field id="lesson-rule" label="Rule">
            <Textarea
              id="lesson-rule"
              value={rule}
              rows={3}
              disabled={pending}
              onChange={event => setRule(event.target.value)}
            />
          </Field>
          <Field id="lesson-why" label="Why">
            <Input
              id="lesson-why"
              size="md"
              value={why}
              disabled={pending}
              onChange={event => setWhy(event.target.value)}
            />
          </Field>
          <Field id="lesson-check" label="Check">
            <Input
              id="lesson-check"
              size="md"
              value={check}
              disabled={pending}
              onChange={event => setCheck(event.target.value)}
            />
          </Field>
          <div className="grid gap-1.5">
            <span className="text-2xs font-medium text-muted-foreground">
              Providers
            </span>
            <div className="flex flex-wrap gap-3">
              {ruleEntryProviderSchema.options.map(option => (
                <Label key={option} className="flex items-center gap-2">
                  <Checkbox
                    checked={providers.includes(option)}
                    disabled={pending}
                    onCheckedChange={value =>
                      setProviders(toggled(providers, option, value === true))
                    }
                  />
                  {PROVIDER_LABELS[option]}
                </Label>
              ))}
            </div>
          </div>
          <div className="grid gap-1.5">
            <span className="text-2xs font-medium text-muted-foreground">
              Roles
            </span>
            <div className="flex flex-wrap gap-3">
              {ruleEntryRoleSchema.options.map(option => (
                <Label key={option} className="flex items-center gap-2">
                  <Checkbox
                    checked={roles.includes(option)}
                    disabled={pending}
                    onCheckedChange={value =>
                      setRoles(toggled(roles, option, value === true))
                    }
                  />
                  {lessonRoleLabels[option]}
                </Label>
              ))}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field id="lesson-workflows" label="Workflows">
              <Input
                id="lesson-workflows"
                size="md"
                value={workflows}
                placeholder="Any"
                disabled={pending}
                onChange={event => setWorkflows(event.target.value)}
              />
            </Field>
            <Field id="lesson-steps" label="Steps">
              <Input
                id="lesson-steps"
                size="md"
                value={steps}
                placeholder="Any"
                disabled={pending}
                onChange={event => setSteps(event.target.value)}
              />
            </Field>
            <Field id="lesson-paths" label="Paths">
              <Input
                id="lesson-paths"
                size="md"
                value={paths}
                placeholder="Any"
                spellCheck={false}
                disabled={pending}
                onChange={event => setPaths(event.target.value)}
              />
            </Field>
          </div>
          {proposal && (
            <Field
              id="lesson-project"
              label="Project folder"
              hint="Leave empty to save the lesson in the global workflows folder."
            >
              <Input
                id="lesson-project"
                size="md"
                value={project}
                spellCheck={false}
                disabled={pending}
                onChange={event => setProject(event.target.value)}
              />
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              id="lesson-enforced"
              label="Enforced by"
              hint="none, lint:<rule>, test:<file> or ci:<job>. Enforced lessons are not added to prompts."
            >
              <Input
                id="lesson-enforced"
                size="md"
                value={enforcedBy}
                spellCheck={false}
                disabled={pending}
                onChange={event => setEnforcedBy(event.target.value)}
              />
            </Field>
            <Field
              id="lesson-review"
              label="Review on"
              hint="The lesson returns to the Inbox on this date."
            >
              <Input
                id="lesson-review"
                type="date"
                size="md"
                value={review}
                disabled={pending}
                aria-invalid={!reviewValid || undefined}
                onChange={event => setReview(event.target.value)}
              />
            </Field>
          </div>
          {issue && <StatusMessage tone="warning">{issue}</StatusMessage>}
          {error && <StatusMessage tone="error">{error}</StatusMessage>}
        </div>
        <DialogFooter>
          <DialogCancel disabled={pending} onClick={onClose} />
          <Button
            size="lg"
            disabled={!valid || pending}
            aria-busy={pending || undefined}
            onClick={submit}
          >
            {pending ? 'Saving…' : approve ? 'Approve' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
