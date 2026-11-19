import { useState } from 'react';
import { X } from 'lucide-react';
import {
  checkStackDetectors,
  checkStackSchema,
  type CheckPreferences,
  type CheckStack,
} from '@nesvo/contracts';
import { Button } from '@/shared/ui/button';
import { Disclosure } from '@/shared/ui/disclosure';
import { FieldMessages } from '@/shared/ui/field';
import { IconButton } from '@/shared/ui/icon-button';
import { Input } from '@/shared/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { describedBy, hasError, notesId, type FieldNote } from './field-notes';

function StackPicker({
  label,
  stack,
  options,
  onChange,
}: {
  label: string;
  stack?: CheckStack;
  options: readonly CheckStack[];
  onChange: (stack: CheckStack) => void;
}) {
  return (
    <Select
      value={stack ?? ''}
      onValueChange={value => onChange(checkStackSchema.parse(value))}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-full">
        <SelectValue placeholder="Choose stack" />
      </SelectTrigger>
      <SelectContent position="popper">
        {options.map(option => (
          <SelectItem key={option} value={option}>
            {checkStackDetectors[option].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function PreferredCommands({
  id,
  preferred = {},
  messages,
  onChange,
}: {
  id: string;
  preferred?: CheckPreferences;
  messages: FieldNote[];
  onChange: (preferred: CheckPreferences | undefined) => void;
}) {
  const [adding, setAdding] = useState(false);
  const stacks = checkStackSchema.options.filter(stack => preferred[stack]);
  const remaining = checkStackSchema.options.filter(stack => !preferred[stack]);
  const replace = (previous: CheckStack, next?: CheckStack) => {
    const preferences = { ...preferred };
    delete preferences[previous];
    if (next)
      Object.assign(
        preferences,
        checkStackDetectors[next].withCandidate(
          checkStackDetectors[previous].preference(preferred) ?? '',
        ),
      );
    onChange(Object.keys(preferences).length ? preferences : undefined);
  };

  return (
    <section aria-label="Preferred commands" data-field={id}>
      <Disclosure
        title="Preferred commands"
        triggerLabel="Preferred commands"
        description={
          <span>
            Optional. Without preferences the agent picks from what the project
            offers.
          </span>
        }
        contentClassName="space-y-2 px-2"
      >
        {stacks.map((stack, index) => (
          <div
            key={stack}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5"
          >
            <StackPicker
              label={`Stack ${index + 1}`}
              stack={stack}
              options={checkStackSchema.options.filter(
                option => option === stack || !preferred[option],
              )}
              onChange={next => replace(stack, next)}
            />
            <Input
              aria-label={`Candidate ${index + 1}`}
              aria-invalid={hasError(messages) || undefined}
              aria-describedby={describedBy(id, messages)}
              size="sm"
              value={checkStackDetectors[stack].preference(preferred) ?? ''}
              placeholder="Candidate"
              maxLength={120}
              autoComplete="off"
              spellCheck={false}
              onChange={event =>
                onChange({
                  ...preferred,
                  ...checkStackDetectors[stack].withCandidate(
                    event.target.value,
                  ),
                })
              }
            />
            <IconButton
              label={`Remove ${checkStackDetectors[stack].label} preference`}
              size={24}
              onClick={() => replace(stack)}
            >
              <X />
            </IconButton>
          </div>
        ))}
        {remaining.length > 0 &&
          (adding ? (
            <div className="flex items-center gap-1.5">
              <StackPicker
                label="Stack for new preference"
                options={remaining}
                onChange={stack => {
                  setAdding(false);
                  onChange({
                    ...preferred,
                    ...checkStackDetectors[stack].withCandidate(''),
                  });
                }}
              />
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setAdding(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => setAdding(true)}
            >
              Add
            </Button>
          ))}
      </Disclosure>
      <FieldMessages id={notesId(id)} messages={messages} />
    </section>
  );
}
