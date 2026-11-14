import { useState } from 'react';
import { pipelineDefinitionLimits, stepNeedSchema } from '@nesvo/contracts';
import { X } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Switch } from '@/shared/ui/switch';
import {
  describedBy,
  inspectorInput,
  notesId,
  type FieldNote,
} from './field-notes';
import { FieldNotes } from './fields';

type Props = {
  id: string;
  needs: string[];
  notes: FieldNote[];
  onChange: (needs: string[]) => void;
};

const BROWSER_NEED = 'browser';
const ENV_PREFIX = 'env:';
const ENV_NAME_LENGTH = 60;

const draftNotes = (need: string, needs: string[]): FieldNote[] => {
  if (!need.slice(ENV_PREFIX.length)) return [];
  const parsed = stepNeedSchema.safeParse(need);
  if (!parsed.success)
    return parsed.error.issues.map(issue => ({
      severity: 'error',
      message: issue.message,
    }));
  if (needs.includes(need))
    return [{ severity: 'error', message: 'List each need once.' }];
  if (needs.length >= pipelineDefinitionLimits.needs)
    return [
      {
        severity: 'error',
        message: `A step lists at most ${pipelineDefinitionLimits.needs} needs.`,
      },
    ];
  return [];
};

export function NeedsField({ id, needs, notes, onChange }: Props) {
  const [name, setName] = useState('');
  const inputId = `${id}-env`;
  const need = `${ENV_PREFIX}${name.trim()}`;
  const pending = draftNotes(need, needs);
  const variables = needs.filter(item => item !== BROWSER_NEED);
  const browser = needs.includes(BROWSER_NEED);
  const canAdd = !!name.trim() && pending.length === 0;
  const add = () => {
    if (!canAdd) return;
    onChange([...needs, need]);
    setName('');
  };
  return (
    <fieldset className="space-y-1.5" aria-describedby={describedBy(id, notes)}>
      <legend className="text-2xs leading-none font-medium text-muted-foreground">
        Needs
      </legend>
      <div className="flex items-center justify-between gap-2 pt-1">
        <Label htmlFor={`${id}-browser`} className="text-xs font-normal">
          Browser
        </Label>
        <Switch
          id={`${id}-browser`}
          checked={browser}
          disabled={!browser && needs.length >= pipelineDefinitionLimits.needs}
          onCheckedChange={checked =>
            onChange(
              checked
                ? [...needs, BROWSER_NEED]
                : needs.filter(item => item !== BROWSER_NEED),
            )
          }
        />
      </div>
      {variables.length > 0 && (
        <ul aria-label="Environment variables" className="flex flex-wrap gap-1">
          {variables.map(item => (
            <li
              key={item}
              className="inline-flex h-6 items-center gap-1 rounded-md border bg-card pr-0.5 pl-2 font-mono text-2xs"
            >
              {item}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${item}`}
                onClick={() =>
                  onChange(needs.filter(existing => existing !== item))
                }
                className="size-5"
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1.5">
        <Label htmlFor={inputId} className="sr-only">
          Environment variable
        </Label>
        <div className="flex min-w-0 flex-1 items-center rounded-md border border-input focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 has-aria-invalid:border-destructive dark:bg-input/30">
          <span
            aria-hidden="true"
            className="pl-2 font-mono text-xs text-muted-foreground"
          >
            {ENV_PREFIX}
          </span>
          <Input
            id={inputId}
            value={name}
            placeholder="NAME"
            autoComplete="off"
            spellCheck={false}
            maxLength={ENV_NAME_LENGTH}
            aria-invalid={pending.length > 0 || undefined}
            aria-describedby={
              pending.length ? notesId(inputId) : describedBy(id, notes)
            }
            onChange={event => setName(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing)
                return;
              event.preventDefault();
              add();
            }}
            className={cn(
              inspectorInput,
              'border-0 bg-transparent pl-0.5 font-mono shadow-none focus-visible:ring-0 dark:bg-transparent',
            )}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={!canAdd}
          onClick={add}
          className="h-7"
        >
          Add
        </Button>
      </div>
      <FieldNotes id={notesId(inputId)} notes={pending} />
      <FieldNotes id={notesId(id)} notes={notes} />
    </fieldset>
  );
}
