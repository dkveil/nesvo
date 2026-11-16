import { useId } from 'react';
import {
  workflowDefinitionLimits,
  workflowDefinitionSchema,
} from '@nesvo/contracts';
import { cn } from 'cn';
import { Badge } from '@/shared/ui/badge';
import { Input } from '@/shared/ui/input';
import { Textarea } from '@/shared/ui/textarea';
import {
  mergeNotes,
  schemaNotes,
  describedBy,
  hasError,
  inspectorInput,
  inspectorTextarea,
  type FieldNote,
} from './field-notes';
import { Field, FieldNotes } from './fields';
import type { WorkflowInspectorProps } from './index';

const workflowFields = ['name', 'description', 'body'] as const;

const workflowFieldsSchema = workflowDefinitionSchema.pick({
  name: true,
  description: true,
  body: true,
});

const scopeLabels = { global: 'Global', project: 'Project' } as const;

const counter = (length: number, limit: number) => (
  <span
    className={cn(
      'text-2xs tabular-nums',
      length > limit ? 'text-error-foreground' : 'text-muted-foreground',
    )}
  >
    {length.toLocaleString()}/{limit.toLocaleString()}
  </span>
);

export function WorkflowInspectorForm({
  name,
  description,
  body,
  scope,
  mode,
  issues,
  onChange,
}: WorkflowInspectorProps) {
  const prefix = useId();
  const fieldId = (field: string) => `${prefix}workflow-${field}`;
  const fields = { name, description, body };
  const notes = mergeNotes(
    schemaNotes(workflowFieldsSchema.safeParse(fields)),
    issues,
    workflowFields,
  );
  const notesOf = (field: string): FieldNote[] => notes[field] ?? [];
  const formNotes = notesOf('form');
  return (
    <div
      role="group"
      aria-label={`Workflow ${name || 'draft'}`}
      className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-3"
    >
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className="text-2xs">
          {scopeLabels[scope]}
        </Badge>
        {mode === 'create' && (
          <Badge variant="secondary" className="text-2xs">
            New workflow
          </Badge>
        )}
      </div>
      <Field
        id={fieldId('name')}
        label="Name"
        notes={notesOf('name')}
        hint={mode === 'edit' ? 'The name is the file name and stays.' : null}
      >
        <Input
          id={fieldId('name')}
          value={name}
          readOnly={mode === 'edit'}
          autoComplete="off"
          spellCheck={false}
          maxLength={workflowDefinitionLimits.name}
          placeholder="release"
          aria-invalid={hasError(notesOf('name')) || undefined}
          aria-describedby={describedBy(fieldId('name'), notesOf('name'))}
          onChange={event => onChange({ ...fields, name: event.target.value })}
          className={cn(
            inspectorInput,
            'font-mono',
            mode === 'edit' && 'text-muted-foreground',
          )}
        />
      </Field>
      <Field
        id={fieldId('description')}
        label="Description"
        notes={notesOf('description')}
        aside={counter(
          description.length,
          workflowDefinitionLimits.description,
        )}
      >
        <Textarea
          id={fieldId('description')}
          value={description}
          rows={3}
          maxLength={workflowDefinitionLimits.description}
          placeholder="What this workflow checks and when to use it."
          aria-invalid={hasError(notesOf('description')) || undefined}
          aria-describedby={describedBy(
            fieldId('description'),
            notesOf('description'),
          )}
          onChange={event =>
            onChange({ ...fields, description: event.target.value })
          }
          className="min-h-16 px-2 py-1.5 text-xs leading-5 md:text-xs"
        />
      </Field>
      <Field
        id={fieldId('body')}
        label="Notes"
        notes={notesOf('body')}
        hint="Free text kept below the frontmatter of the workflow file."
        aside={counter(body.length, workflowDefinitionLimits.body)}
      >
        <Textarea
          id={fieldId('body')}
          value={body}
          rows={6}
          maxLength={workflowDefinitionLimits.body}
          aria-invalid={hasError(notesOf('body')) || undefined}
          aria-describedby={describedBy(fieldId('body'), notesOf('body'))}
          onChange={event => onChange({ ...fields, body: event.target.value })}
          className={inspectorTextarea}
        />
      </Field>
      {formNotes.length > 0 && (
        <div role="alert">
          <FieldNotes id={fieldId('form-notes')} notes={formNotes} />
        </div>
      )}
    </div>
  );
}
