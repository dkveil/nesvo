import { pathBasename } from '@/shared/lib/path-basename';
import { useState, type FormEvent } from 'react';
import {
  createCostBudgetSchema,
  type CostBudget,
  type CreateCostBudgetInput,
  type DesktopSession,
  type SessionGroup,
} from '@nesvo/contracts';
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
import { InlineNotice } from '@/shared/ui/inline-notice';
import { Input } from '@/shared/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { formatSpend } from './format-spend';
import { periodLabels, scopeLabels, actionLabels } from './labels';

type BudgetDialogProps = {
  budget?: CostBudget;
  removing: boolean;
  timeZone: string;
  sessions: DesktopSession[];
  groups: SessionGroup[];
  computerName: string;
  groupBudgets: boolean;
  onSave: (input: CreateCostBudgetInput) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
  onClose: () => void;
};

function BudgetSelect<T extends string>({
  id,
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: Partial<Record<T, string>>;
  placeholder?: string;
  onChange: (value: T) => void;
}) {
  return (
    <Field id={id} label={label} className="min-w-0">
      <Select
        required
        value={value}
        onValueChange={next => onChange(next as T)}
      >
        <SelectTrigger size="md" id={id} className="w-full min-w-0">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {(Object.entries(options) as Array<[T, string]>).map(
            ([option, text]) => (
              <SelectItem key={option} value={option}>
                {text}
              </SelectItem>
            ),
          )}
        </SelectContent>
      </Select>
    </Field>
  );
}

export function BudgetDialog({
  budget,
  removing,
  timeZone,
  sessions,
  groups,
  computerName,
  groupBudgets,
  onSave,
  onRemove,
  onClose,
}: BudgetDialogProps) {
  const { group, ...otherScopes } = scopeLabels;
  const availableScopes = groupBudgets
    ? { ...otherScopes, group }
    : otherScopes;
  const [scope, setScope] = useState(budget?.scope ?? 'computer');
  const [target, setTarget] = useState(
    budget && 'target' in budget ? budget.target : '',
  );
  const [period, setPeriod] = useState(budget?.period ?? 'month');
  const [action, setAction] = useState(budget?.action ?? 'warn');
  const [limit, setLimit] = useState(budget ? String(budget.limitUsd) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const targets =
    scope === 'directory'
      ? [...new Set(sessions.map(session => session.directory))]
          .sort()
          .map(directory => ({
            value: directory,
            label: pathBasename(directory),
          }))
      : scope === 'group'
        ? groups.map(group => ({ value: group.id, label: group.name }))
        : sessions.map(session => ({
            value: session.id,
            label: session.title,
          }));
  if (target && !targets.some(option => option.value === target))
    targets.unshift({
      value: target,
      label:
        scope === 'directory' ? pathBasename(target) : 'Unavailable target',
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const parsed = createCostBudgetSchema.safeParse({
      scope,
      period,
      action,
      limitUsd: Number(limit),
      ...(scope !== 'computer' ? { target } : {}),
    });
    if (!removing && !parsed.success) {
      setError(
        'Choose a budget target and enter a positive amount in US dollars.',
      );
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (removing) await onRemove();
      else if (parsed.success) await onSave(parsed.data);
      onClose();
    } catch (cause) {
      setError(errorDetail(cause));
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent surface="panel" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>
            {removing
              ? 'Delete budget?'
              : budget
                ? 'Edit budget'
                : 'New budget'}
          </DialogTitle>
          <DialogDescription>
            {removing && budget
              ? `Remove the budget for ${budget.scope === 'computer' ? computerName : (targets.find(item => item.value === budget.target)?.label ?? 'the selected scope')} of ${formatSpend(budget.limitUsd)} per ${budget.period}.`
              : `Periods follow ${timeZone}. The host checks known transcript costs before each new turn.`}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={event => void submit(event)}>
          {!removing && (
            <fieldset className="grid gap-3" disabled={saving}>
              <BudgetSelect
                id="budget-scope"
                label="Scope"
                value={scope}
                options={availableScopes}
                onChange={value => {
                  setScope(value);
                  setTarget('');
                }}
              />
              {scope !== 'computer' && (
                <BudgetSelect
                  id="budget-target"
                  label={scopeLabels[scope]}
                  value={target}
                  placeholder={`Choose a ${scope}`}
                  options={Object.fromEntries(
                    targets.map(option => [option.value, option.label]),
                  )}
                  onChange={setTarget}
                />
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field id="budget-limit" label="Limit (USD)">
                  <Input
                    size="md"
                    id="budget-limit"
                    type="number"
                    step="any"
                    min="0"
                    required
                    value={limit}
                    onChange={event => setLimit(event.target.value)}
                  />
                </Field>
                <BudgetSelect
                  id="budget-period"
                  label="Period"
                  value={period}
                  options={periodLabels}
                  onChange={setPeriod}
                />
              </div>
              <BudgetSelect
                id="budget-action"
                label="When the limit is reached"
                value={action}
                options={actionLabels}
                onChange={setAction}
              />
            </fieldset>
          )}
          {error && <InlineNotice tone="error">{error}</InlineNotice>}
          <DialogFooter>
            <DialogCancel disabled={saving} onClick={onClose} />
            <Button
              type="submit"
              size="lg"
              variant={removing ? 'destructive' : 'default'}
              disabled={saving}
            >
              {saving
                ? removing
                  ? 'Deleting…'
                  : 'Saving…'
                : removing
                  ? 'Delete budget'
                  : 'Save budget'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
