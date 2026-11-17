import { useState, type FormEvent } from 'react';
import {
  createCostBudgetSchema,
  type CostBudget,
  type CreateCostBudgetInput,
  type DesktopSession,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { formatCost } from '@/shared/lib/format-cost';

import { periodLabels, scopeLabels, actionLabels } from './labels';

type BudgetDialogProps = {
  budget?: CostBudget;
  removing: boolean;
  timeZone: string;
  sessions: DesktopSession[];
  onSave: (input: CreateCostBudgetInput) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
  onClose: () => void;
};

const selectClass =
  'h-8 w-full min-w-0 rounded-md border border-input bg-card px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring';

export function BudgetDialog({
  budget,
  removing,
  timeZone,
  sessions,
  onSave,
  onRemove,
  onClose,
}: BudgetDialogProps) {
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
          .map(directory => ({ value: directory, label: directory }))
      : sessions.map(session => ({ value: session.id, label: session.title }));
  if (target && !targets.some(option => option.value === target))
    targets.unshift({ value: target, label: target });

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
      <DialogContent showCloseButton={!saving}>
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
              ? `Remove the ${budget.scope} budget ${budget.id.slice(0, 8)} of ${formatCost(budget.limitUsd)} per ${budget.period}.`
              : `Periods follow ${timeZone}. The host checks reported spend before each new turn.`}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={event => void submit(event)}>
          {!removing && (
            <fieldset className="grid gap-3" disabled={saving}>
              <div className="grid gap-1.5">
                <Label htmlFor="budget-scope">Scope</Label>
                <select
                  id="budget-scope"
                  className={selectClass}
                  value={scope}
                  onChange={event => {
                    setScope(event.target.value as CostBudget['scope']);
                    setTarget('');
                  }}
                >
                  {Object.entries(scopeLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              {scope !== 'computer' && (
                <div className="grid min-w-0 gap-1.5">
                  <Label htmlFor="budget-target">{scopeLabels[scope]}</Label>
                  <select
                    id="budget-target"
                    className={selectClass}
                    value={target}
                    onChange={event => setTarget(event.target.value)}
                    required
                  >
                    <option value="" disabled>
                      Choose a {scope}
                    </option>
                    {targets.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="budget-limit">Limit (USD)</Label>
                  <Input
                    size="md"
                    id="budget-limit"
                    className="h-8"
                    type="number"
                    step="any"
                    min="0"
                    required
                    value={limit}
                    onChange={event => setLimit(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="budget-period">Period</Label>
                  <select
                    id="budget-period"
                    className={selectClass}
                    value={period}
                    onChange={event =>
                      setPeriod(event.target.value as CostBudget['period'])
                    }
                  >
                    {Object.entries(periodLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="budget-action">When the limit is reached</Label>
                <select
                  id="budget-action"
                  className={selectClass}
                  value={action}
                  onChange={event =>
                    setAction(event.target.value as CostBudget['action'])
                  }
                >
                  {Object.entries(actionLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>
          )}
          {error && <InlineNotice tone="error">{error}</InlineNotice>}
          <DialogFooter>
            <Button
              type="button"
              size="md"
              variant="ghost"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="md"
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
