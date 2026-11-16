import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
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

type Item = {
  id: string;
  label: string;
  detail: string;
  aside: string;
  asideTone: 'muted' | 'warning';
  icon: ReactNode;
  disabled: boolean;
  attributes: Record<string, string>;
  pick: () => void;
};

type Group = { key: string; label: string; items: Item[] };

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

const tileClass =
  'flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-muted-foreground';

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
  const listId = useId();
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const close = () => {
    setQuery('');
    setActiveId('');
    onClose();
  };
  const origin = request?.origin;
  const groups: Group[] = [];
  if (origin?.kind === 'start') {
    const allTriggers: Item[] = [
      {
        id: 'trigger-manual',
        label: 'Manual run',
        detail: 'Always available from a new thread with a task spec',
        aside: '',
        asideTone: 'muted',
        icon: <Play className="size-3.5" aria-hidden="true" />,
        disabled: true,
        attributes: { 'data-picker-trigger': 'manual' },
        pick: () => {},
      },
      {
        id: 'trigger-schedule',
        label: 'Schedule',
        detail: 'Run on a schedule through an automation',
        aside: '',
        asideTone: 'muted',
        icon: <CalendarClock className="size-3.5" aria-hidden="true" />,
        disabled: false,
        attributes: { 'data-picker-trigger': 'schedule' },
        pick: () => {
          close();
          onAddSchedule();
        },
      },
    ];
    const triggers = allTriggers.filter(item =>
      matches(needle, item.label, item.detail),
    );
    if (triggers.length)
      groups.push({ key: 'triggers', label: 'Triggers', items: triggers });
  }
  for (const category of categories) {
    const items: Item[] = steps
      .filter(
        step =>
          step.type === category.type &&
          matches(
            needle,
            step.name,
            step.phase,
            step.skill ?? '',
            stepDetail(step),
          ),
      )
      .map(step => {
        const used = inWorkflow.includes(step.name);
        const otherPhase =
          !!request?.phase &&
          request.origin.kind !== 'start' &&
          step.phase !== request.phase;
        return {
          id: `step-${step.name}`,
          label: step.name,
          detail: `${phaseLabels[step.phase]}${stepDetail(step) ? ` · ${stepDetail(step)}` : ''}`,
          aside: used ? 'In workflow' : otherPhase ? 'Other phase' : '',
          asideTone: otherPhase && !used ? 'warning' : 'muted',
          icon: <StepGlyph type={step.type} className="size-3.5" />,
          disabled: used,
          attributes: { 'data-picker-step': step.name },
          pick: () => {
            if (!origin) return;
            close();
            onPickStep(step, origin);
          },
        } satisfies Item;
      });
    if (matches(needle, category.newLabel, category.label))
      items.push({
        id: `new-${category.type}`,
        label: category.newLabel,
        detail: category.description,
        aside: '',
        asideTone: 'muted',
        icon: <Plus className="size-3.5" aria-hidden="true" />,
        disabled: false,
        attributes: { 'data-picker-new': category.type },
        pick: () => {
          if (!origin) return;
          close();
          onNewStep(category.type, request?.phase ?? null, origin);
        },
      });
    if (items.length)
      groups.push({ key: category.type, label: category.label, items });
  }
  const enabled = groups.flatMap(group =>
    group.items.filter(item => !item.disabled),
  );
  const active =
    enabled.find(item => item.id === activeId) ?? enabled[0] ?? null;
  const optionId = (id: string) => `${listId}-${id}`;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!enabled.length) return;
      const index = enabled.findIndex(item => item.id === active?.id);
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      const next = enabled[(index + offset + enabled.length) % enabled.length];
      if (next) {
        setActiveId(next.id);
        document
          .getElementById(optionId(next.id))
          ?.scrollIntoView({ block: 'nearest' });
      }
    } else if (event.key === 'Enter' && active) {
      event.preventDefault();
      active.pick();
    }
  };
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
          role="combobox"
          aria-label="Search steps"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={active ? optionId(active.id) : undefined}
          placeholder="Search steps"
          autoFocus
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setActiveId('');
          }}
          onKeyDown={onKeyDown}
        />
        <div
          id={listId}
          role="listbox"
          aria-label="Node picker"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {groups.map(group => (
            <div key={group.key} className="py-1">
              <h4 className="flex h-6 items-center px-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                {group.label}
              </h4>
              {group.items.map(item => {
                const highlighted = active?.id === item.id;
                return (
                  <button
                    key={item.id}
                    id={optionId(item.id)}
                    type="button"
                    role="option"
                    aria-selected={highlighted}
                    tabIndex={-1}
                    disabled={item.disabled}
                    className={cn(row, highlighted && 'bg-accent')}
                    onMouseEnter={() => {
                      if (!item.disabled) setActiveId(item.id);
                    }}
                    onClick={item.pick}
                    {...item.attributes}
                  >
                    <span
                      className={cn(
                        tileClass,
                        item.id.startsWith('trigger-') &&
                          'bg-primary/12 text-primary',
                        item.id.startsWith('new-') &&
                          'border border-dashed bg-transparent',
                      )}
                    >
                      {item.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">
                        {item.label}
                      </span>
                      <span className="block truncate text-2xs text-muted-foreground">
                        {item.detail}
                      </span>
                    </span>
                    {item.aside && (
                      <span
                        className={cn(
                          'shrink-0 text-2xs text-muted-foreground',
                          item.asideTone === 'warning' &&
                            'text-warning-foreground',
                        )}
                      >
                        {item.aside}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
          {groups.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No step matches.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
