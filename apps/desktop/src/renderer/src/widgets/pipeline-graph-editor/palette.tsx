import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { ResolvedStep } from '@nesvo/contracts';
import { cn } from 'cn';
import { phaseLabels } from '@/entities/pipeline';
import { stepTypeLabels, stepTypeOrder } from '@/entities/pipeline-graph';
import { Button } from '@/shared/ui/button';
import { cardRowAction, cardValue } from '@/shared/ui/card-row-styles';
import { PanelSearch } from '@/shared/ui/panel';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { StepGlyph } from './step-glyph';

type Props = {
  steps: ResolvedStep[];
  inPipeline: string[];
  onAdd: (step: ResolvedStep) => void;
  onNew: () => void;
};

export function Palette({ steps, inPipeline, onAdd, onNew }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const visible = steps.filter(step =>
    `${step.name} ${step.type} ${step.phase} ${step.skill ?? ''}`
      .toLocaleLowerCase()
      .includes(needle),
  );
  const groups = stepTypeOrder
    .map(type => ({ type, steps: visible.filter(step => step.type === type) }))
    .filter(group => group.steps.length > 0);
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-7">
          <Plus />
          Add step
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex max-h-[min(28rem,var(--radix-popover-content-available-height))] w-80 flex-col gap-1 p-1.5"
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
          aria-label="Catalog steps"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {groups.map(group => (
            <div key={group.type} className="py-1">
              <h4 className="px-2.5 pb-1 text-2xs text-muted-foreground">
                {stepTypeLabels[group.type]}
              </h4>
              {group.steps.map(step => {
                const used = inPipeline.includes(step.name);
                return (
                  <button
                    key={step.name}
                    type="button"
                    role="option"
                    aria-selected={used}
                    data-palette-step={step.name}
                    disabled={used}
                    title={step.body.trim().slice(0, 200) || undefined}
                    onClick={() => {
                      onAdd(step);
                      setOpen(false);
                      setQuery('');
                    }}
                    className={cn(cardRowAction, 'font-normal')}
                  >
                    <StepGlyph type={step.type} />
                    <span className="min-w-0 flex-1 truncate">{step.name}</span>
                    <span className={cardValue}>
                      {used ? 'In pipeline' : phaseLabels[step.phase]}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {groups.length === 0 && (
            <p className="px-2.5 py-2 text-xs text-muted-foreground">
              {steps.length === 0
                ? 'No steps in this folder yet.'
                : 'No step matches.'}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 justify-start"
          onClick={() => {
            onNew();
            setOpen(false);
            setQuery('');
          }}
        >
          <Plus />
          New step
        </Button>
      </PopoverContent>
    </Popover>
  );
}
