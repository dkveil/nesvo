import { useState } from 'react';
import {
  Bot,
  CalendarClock,
  Hand,
  Play,
  Plus,
  Terminal,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { ResolvedStep, StepPhase, StepType } from '@nesvo/contracts';
import { cn } from 'cn';
import { phaseLabels } from '@/entities/workflow';
import { PanelSearch } from '@/shared/ui/panel';
import { Popover, PopoverAnchor, PopoverContent } from '@/shared/ui/popover';
import { StepGlyph } from './step-glyph';
import type { AddOrigin } from './use-editor-state';

export type AddRequest = {
  origin: AddOrigin;
  phase: StepPhase | null;
  anchor: { x: number; y: number };
};

type Props = {
  request: AddRequest | null;
  steps: ResolvedStep[];
  inWorkflow: string[];
  onPickStep: (step: ResolvedStep, origin: AddOrigin) => void;
  onNewStep: (
    type: StepType,
    phase: StepPhase | null,
    origin: AddOrigin,
  ) => void;
  onAddSchedule: () => void;
  onClose: () => void;
};

type Category = {
  type: StepType;
  label: string;
  icon: LucideIcon;
  newLabel: string;
  description: string;
};

const categories: Category[] = [
  {
    type: 'command',
    label: 'Checks',
    icon: Terminal,
    newLabel: 'New check',
    description: 'A command that passes or fails',
  },
  {
    type: 'agent',
    label: 'Agents',
    icon: Bot,
    newLabel: 'New agent step',
    description: 'A read-only session returns a verdict',
  },
  {
    type: 'human',
    label: 'Approvals',
    icon: Hand,
    newLabel: 'New approval',
    description: 'Waits for your accept, reject or fix',
  },
  {
    type: 'action',
    label: 'Actions',
    icon: Zap,
    newLabel: 'New action',
    description: 'Runs something with an effect',
  },
];

const row =
  'flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-100 outline-none enabled:hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50';

const stepDetail = (step: ResolvedStep) => {
  if (step.type === 'human') return 'Waits for your decision';
  if (step.skill) return `Skill ${step.skill}`;
  const line = step.body
    .split('\n')
    .map(item => item.trim())
    .find(item => item && !item.startsWith('#'));
  return line ?? '';
};

const matches = (needle: string, ...parts: string[]) =>
  !needle || parts.some(part => part.toLocaleLowerCase().includes(needle));

export function NodePicker({
  request,
  steps,
  inWorkflow,
  onPickStep,
  onNewStep,
  onAddSchedule,
  onClose,
}: Props) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const close = () => {
    setQuery('');
    onClose();
  };
  const origin = request?.origin;
  const showTriggers = origin?.kind === 'start';
  const triggers = showTriggers
    ? [
        {
          id: 'manual',
          label: 'Manual run',
          detail: 'Always available from a new thread with a task spec',
          icon: Play,
          disabled: true,
          onPick: () => {},
        },
        {
          id: 'schedule',
          label: 'Schedule',
          detail: 'Run on a schedule through an automation',
          icon: CalendarClock,
          disabled: false,
          onPick: () => {
            close();
            onAddSchedule();
          },
        },
      ].filter(item => matches(needle, item.label, item.detail))
    : [];
  const groups = categories
    .map(category => ({
      category,
      steps: steps.filter(
        step =>
          step.type === category.type &&
          matches(
            needle,
            step.name,
            step.phase,
            step.skill ?? '',
            stepDetail(step),
          ),
      ),
      showNew: matches(needle, category.newLabel, category.label),
    }))
    .filter(group => group.steps.length > 0 || group.showNew);
  const empty = triggers.length === 0 && groups.length === 0;
  return (
    <Popover
      open={!!request}
      onOpenChange={open => {
        if (!open) close();
      }}
    >
      <PopoverAnchor asChild>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute size-px"
          style={{ left: request?.anchor.x ?? 0, top: request?.anchor.y ?? 0 }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={10}
        collisionPadding={12}
        aria-label="Add a step"
        data-node-picker
        className="flex max-h-[min(30rem,var(--radix-popover-content-available-height))] w-80 flex-col gap-1 p-1.5"
      >
        <PanelSearch
          aria-label="Search steps"
          placeholder="Search steps"
          autoFocus
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <div
          role="listbox"
          aria-label="Node picker"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {triggers.length > 0 && (
            <div className="py-1">
              <h4 className="flex h-6 items-center px-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                Triggers
              </h4>
              {triggers.map(trigger => (
                <button
                  key={trigger.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  data-picker-trigger={trigger.id}
                  disabled={trigger.disabled}
                  className={row}
                  onClick={trigger.onPick}
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary">
                    <trigger.icon className="size-3.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {trigger.label}
                    </span>
                    <span className="block truncate text-2xs text-muted-foreground">
                      {trigger.detail}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {groups.map(({ category, steps: items, showNew }) => (
            <div key={category.type} className="py-1">
              <h4 className="flex h-6 items-center px-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                {category.label}
              </h4>
              {items.map(step => {
                const used = inWorkflow.includes(step.name);
                const otherPhase =
                  !!request?.phase &&
                  request.origin.kind !== 'start' &&
                  step.phase !== request.phase;
                return (
                  <button
                    key={step.name}
                    type="button"
                    role="option"
                    aria-selected={false}
                    data-picker-step={step.name}
                    disabled={used}
                    title={step.body.trim().slice(0, 200) || undefined}
                    className={row}
                    onClick={() => {
                      if (!origin) return;
                      close();
                      onPickStep(step, origin);
                    }}
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-muted-foreground">
                      <StepGlyph type={step.type} className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">
                        {step.name}
                      </span>
                      <span className="block truncate text-2xs text-muted-foreground">
                        {phaseLabels[step.phase]}
                        {stepDetail(step) ? ` · ${stepDetail(step)}` : ''}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'shrink-0 text-2xs text-muted-foreground',
                        otherPhase && !used && 'text-warning-foreground',
                      )}
                    >
                      {used ? 'In workflow' : otherPhase ? 'Other phase' : ''}
                    </span>
                  </button>
                );
              })}
              {showNew && (
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  data-picker-new={category.type}
                  className={row}
                  onClick={() => {
                    if (!origin) return;
                    close();
                    onNewStep(category.type, request?.phase ?? null, origin);
                  }}
                >
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground">
                    <Plus className="size-3.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {category.newLabel}
                    </span>
                    <span className="block truncate text-2xs text-muted-foreground">
                      {category.description}
                    </span>
                  </span>
                </button>
              )}
            </div>
          ))}
          {empty && (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No step matches.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
