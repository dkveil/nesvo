import { useState } from 'react';
import { workflowDefinitionLimits, stepNeedSchema } from '@nesvo/contracts';
import { X } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { Chip } from '@/shared/ui/chip';
import { IconButton } from '@/shared/ui/icon-button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Switch } from '@/shared/ui/switch';
import { describedBy, notesId, type FieldNote } from './field-notes';
import { FieldMessages } from '@/shared/ui/field';

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
  if (needs.length >= workflowDefinitionLimits.needs)
    return [
      {
        severity: 'error',
        message: `A step lists at most ${workflowDefinitionLimits.needs} needs.`,
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
        <Label htmlFor={`${id}-browser`} className="text-ui font-normal">
          Browser
        </Label>
        <Switch
          id={`${id}-browser`}
          checked={browser}
          disabled={!browser && needs.length >= workflowDefinitionLimits.needs}
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
            <li key={item}>
              <Chip
                size="sm"
                interactive={false}
                className="border bg-card pr-0.5 font-mono text-foreground"
              >
                <span>{item}</span>
                <IconButton
                  size={20}
                  label={`Remove ${item}`}
                  onClick={() =>
                    onChange(needs.filter(existing => existing !== item))
                  }
                >
                  <X />
                </IconButton>
              </Chip>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1.5">
        <Label htmlFor={inputId} className="sr-only">
          Environment variable
        </Label>
        <div className="focus-ring-within flex h-7 min-w-0 flex-1 items-center gap-0.5 rounded-control border border-input shadow-xs has-aria-invalid:border-error-foreground dark:bg-input/30">
          <span
            aria-hidden="true"
            className="pl-2 font-mono text-ui text-muted-foreground"
          >
            {ENV_PREFIX}
          </span>
          <Input
            variant="ghost"
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
            className="pr-2 font-mono"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={!canAdd}
          onClick={add}
        >
          Add
        </Button>
      </div>
      <FieldMessages id={notesId(inputId)} messages={pending} />
      <FieldMessages id={notesId(id)} messages={notes} />
    </fieldset>
  );
}
