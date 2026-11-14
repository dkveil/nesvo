import { useId, useState, type KeyboardEvent } from 'react';
import { pipelineDefinitionLimits } from '@nesvo/contracts';
import { cn } from 'cn';
import { Input } from '@/shared/ui/input';
import {
  describedBy,
  hasError,
  inspectorInput,
  type FieldNote,
} from './field-notes';
import type { SkillSummary } from './index';

type Props = {
  id: string;
  value: string | null;
  skills: SkillSummary[];
  notes: FieldNote[];
  onChange: (skill: string | null) => void;
};

const SKILL_OPTIONS = 8;

const matches = (skills: SkillSummary[], query: string) => {
  const needle = query.trim().toLowerCase();
  return skills
    .filter(skill =>
      `${skill.name} ${skill.description}`.toLowerCase().includes(needle),
    )
    .slice(0, SKILL_OPTIONS);
};

export function SkillField({ id, value, skills, notes, onChange }: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const text = value ?? '';
  const options = open ? matches(skills, text) : [];
  const current = options[Math.min(active, options.length - 1)];
  const choose = (name: string) => {
    onChange(name);
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setNavigated(true);
      if (!options.length) return;
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      setActive(index => (index + offset + options.length) % options.length);
    } else if (event.key === 'Enter' && open && navigated && current) {
      event.preventDefault();
      choose(current.name);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };
  const optionId = (index: number) => `${listId}-${index}`;
  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={options.length > 0}
        aria-activedescendant={
          options.length && current
            ? optionId(options.indexOf(current))
            : undefined
        }
        aria-invalid={hasError(notes) || undefined}
        aria-describedby={describedBy(id, notes)}
        autoComplete="off"
        spellCheck={false}
        placeholder={skills.length ? 'Search skills' : 'code-review'}
        maxLength={pipelineDefinitionLimits.name}
        value={text}
        onChange={event => {
          onChange(event.target.value ? event.target.value : null);
          setOpen(true);
          setActive(0);
          setNavigated(false);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className={cn(inspectorInput, 'font-mono')}
      />
      {options.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Skills"
          className="glass-popover absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border p-1 text-popover-foreground"
        >
          {options.map((skill, index) => (
            <li
              key={skill.id}
              id={optionId(index)}
              role="option"
              aria-selected={skill.name === value}
              data-active={skill === current || undefined}
              onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(skill.name)}
              className="cursor-pointer space-y-0.5 rounded-sm px-2 py-1 data-active:bg-highlight"
            >
              <span className="block truncate font-mono text-xs">
                {skill.name}
              </span>
              {skill.description && (
                <span className="block truncate text-2xs text-muted-foreground">
                  {skill.description}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
