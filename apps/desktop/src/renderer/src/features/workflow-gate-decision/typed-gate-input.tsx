import { useId, useState } from 'react';
import {
  validateHumanAnswer,
  type PinnedHumanDecision,
  type HumanDecisionAnswer,
} from '@nesvo/contracts';
import { Button } from '@/shared/ui/button';
import { Checkbox } from '@/shared/ui/checkbox';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';

export function TypedGateInput({
  decision,
  narrowedPaths,
  enabled,
  onSubmit,
}: {
  decision: PinnedHumanDecision;
  narrowedPaths?: string[] | undefined;
  enabled: boolean;
  onSubmit: (answer: HumanDecisionAnswer) => void;
}) {
  const id = useId();
  const [choice, setChoice] = useState('');
  const [paths, setPaths] = useState<string[]>([]);
  const [allFiles, setAllFiles] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const { form } = decision;
  if (form.kind === 'binary') return null;
  const answer: HumanDecisionAnswer =
    form.kind === 'choice'
      ? { kind: 'choice', option: choice }
      : form.kind === 'files'
        ? { kind: 'files', paths }
        : {
            kind: 'fields',
            values: Object.fromEntries(
              form.fields.flatMap(field => {
                const value = fields[field.id];
                if (!value?.trim()) return [];
                const parsed =
                  field.type === 'boolean'
                    ? value === 'yes'
                    : field.type === 'number'
                      ? Number(value)
                      : value.trim();
                return [[field.id, parsed]];
              }),
            ),
          };
  const valid =
    validateHumanAnswer(decision, answer) &&
    (answer.kind !== 'files' || paths.length > 0);
  return (
    <form
      aria-label="Gate decision"
      className="col-span-full min-w-0 max-w-2xl space-y-2"
      onSubmit={event => {
        event.preventDefault();
        if (valid && enabled) onSubmit(answer);
      }}
    >
      {form.kind === 'choice' && (
        <Field id={id} label="Choose an option">
          <Select value={choice} onValueChange={setChoice} disabled={!enabled}>
            <SelectTrigger id={id}>
              <SelectValue placeholder="Choose an option" />
            </SelectTrigger>
            <SelectContent>
              {form.options.map(option => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {form.kind === 'files' && narrowedPaths?.length ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setAllFiles(value => !value)}
        >
          {allFiles ? 'Show suggested paths' : 'Show all changed files'}
        </Button>
      ) : null}
      {form.kind === 'files' && (
        <div
          role="group"
          aria-label="Changed files"
          className="max-h-56 overflow-y-auto divide-y divide-border"
        >
          {(narrowedPaths?.length && !allFiles
            ? narrowedPaths
            : decision.files
          )?.map((path, index) => (
            <label
              key={path}
              htmlFor={`${id}-file-${index}`}
              className="flex min-w-0 items-center gap-2 py-1.5 text-ui"
            >
              <Checkbox
                id={`${id}-file-${index}`}
                checked={paths.includes(path)}
                disabled={!enabled}
                onCheckedChange={checked =>
                  setPaths(current =>
                    checked
                      ? [...current, path]
                      : current.filter(item => item !== path),
                  )
                }
              />
              <span className="min-w-0 break-all">{path}</span>
            </label>
          ))}
        </div>
      )}
      {form.kind === 'fields' &&
        form.fields.map(field => {
          const fieldId = `${id}-${field.id}`;
          const value = fields[field.id] ?? '';
          const change = (next: string) =>
            setFields(current => ({ ...current, [field.id]: next }));
          return (
            <Field
              id={fieldId}
              key={field.id}
              label={field.label}
              hint={field.required ? null : 'Optional'}
            >
              {field.type === 'boolean' ? (
                <Select
                  value={value}
                  onValueChange={change}
                  disabled={!enabled}
                >
                  <SelectTrigger id={fieldId}>
                    <SelectValue placeholder="Choose yes or no" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes">Yes</SelectItem>
                    <SelectItem value="no">No</SelectItem>
                    {!field.required && (
                      <SelectItem value=" ">Clear</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={fieldId}
                  type={field.type === 'number' ? 'number' : 'text'}
                  step="any"
                  value={value}
                  disabled={!enabled}
                  maxLength={
                    field.type === 'text' ? field.max_length : undefined
                  }
                  onChange={event => change(event.target.value)}
                />
              )}
            </Field>
          );
        })}
      <Button type="submit" variant="secondary" disabled={!valid || !enabled}>
        {form.kind === 'files' ? 'Approve selected files' : 'Confirm decision'}
      </Button>
    </form>
  );
}
