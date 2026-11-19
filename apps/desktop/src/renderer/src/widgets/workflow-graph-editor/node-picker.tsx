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
import { phaseLabels } from '@/entities/workflow';
import { Listbox, type ListboxOption } from '@/shared/ui/listbox';
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

type Item = ListboxOption<string> & { pick: () => void };

const categories: Category[] = [
  {
    type: 'command',
    label: 'Checks',
    icon: Terminal,
    newLabel: 'New check',
    description: 'A command that passes or fails',
  },
  {
    type: 'check',
    label: 'Checks',
    icon: Terminal,
    newLabel: 'New portable check',
    description: 'Selects and verifies a test suite from the project',
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

const stepDetail = (step: ResolvedStep) => {
  if (step.type === 'human') return 'Waits for your decision';
  if (step.skill) return `Skill ${step.skill}`;
  const line = step.body
    .split('\n')
    .map(item => item.trim())
    .find(item => item && !item.startsWith('#'));
  return line ?? '';
};

export function NodePicker({
  request,
  steps,
  inWorkflow,
  onPickStep,
  onNewStep,
  onAddSchedule,
  onClose,
}: Props) {
  const origin = request?.origin;
  const items: Item[] = [];
  if (origin?.kind === 'start')
    items.push(
      {
        value: 'trigger-manual',
        label: 'Manual run',
        description: 'Always available from a new thread with a task spec',
        group: 'Triggers',
        icon: <Play aria-hidden="true" />,
        disabled: true,
        attributes: { 'data-picker-trigger': 'manual' },
        pick: () => {},
      },
      {
        value: 'trigger-schedule',
        label: 'Schedule',
        description: 'Run on a schedule through an automation',
        group: 'Triggers',
        icon: <CalendarClock aria-hidden="true" />,
        attributes: { 'data-picker-trigger': 'schedule' },
        pick: () => {
          onClose();
          onAddSchedule();
        },
      },
    );
  for (const category of categories) {
    for (const step of steps.filter(item => item.type === category.type)) {
      const used = inWorkflow.includes(step.name);
      const otherPhase =
        !!request?.phase &&
        request.origin.kind !== 'start' &&
        step.phase !== request.phase;
      const detail = stepDetail(step);
      items.push({
        value: `step-${step.name}`,
        label: step.name,
        description: `${phaseLabels[step.phase]}${detail ? ` · ${detail}` : ''}`,
        group: category.label,
        keywords: `${step.phase} ${step.skill ?? ''} ${category.label}`,
        icon: <StepGlyph type={step.type} />,
        trailing: used ? (
          'In workflow'
        ) : otherPhase ? (
          <span className="text-warning-foreground">Other phase</span>
        ) : undefined,
        disabled: used,
        attributes: { 'data-picker-step': step.name },
        pick: () => {
          if (!origin) return;
          onClose();
          onPickStep(step, origin);
        },
      });
    }
    items.push({
      value: `new-${category.type}`,
      label: category.newLabel,
      description: category.description,
      group: category.label,
      keywords: category.label,
      icon: <Plus aria-hidden="true" />,
      attributes: { 'data-picker-new': category.type },
      pick: () => {
        if (!origin) return;
        onClose();
        onNewStep(category.type, request?.phase ?? null, origin);
      },
    });
  }
  return (
    <Popover
      open={!!request}
      onOpenChange={open => {
        if (!open) onClose();
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
        surface="solid"
        size="md"
        padding="none"
        className="flex max-h-[min(30rem,var(--radix-popover-content-available-height))] flex-col overflow-hidden"
      >
        <Listbox
          key={request ? `${request.anchor.x}:${request.anchor.y}` : 'closed'}
          label="Node picker"
          searchable
          searchLabel="Search steps"
          searchPlaceholder="Search steps"
          emptyText="No step matches."
          autoFocus
          options={items}
          onSelect={value => items.find(item => item.value === value)?.pick()}
        />
      </PopoverContent>
    </Popover>
  );
}
