import {
  isProviderSessionMode,
  providerSchema,
  providerSessionModes,
  type WorkflowChildPolicy,
  type WorkflowChildSession,
  type WorkflowItemSource,
} from '@nesvo/contracts';
import type { StepDraft } from '@/entities/workflow-graph';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { Switch } from '@/shared/ui/switch';
import { Textarea } from '@/shared/ui/textarea';
import type { FieldNote } from './field-notes';
import { readInlineItems } from './step-form';

const modeLabels = {
  'read-only': 'Read-only',
  supervised: 'Workspace edits',
  'accept-edits': 'Accept edits',
  auto: 'Auto',
};

const sources = {
  inline: { label: 'Inline list', source: { kind: 'inline', values: [] } },
  file: { label: 'File', source: { kind: 'file', path: '' } },
  output: { label: 'Step output', source: { kind: 'output', reference: '' } },
} satisfies Record<
  WorkflowItemSource['kind'],
  { label: string; source: WorkflowItemSource }
>;

const failures = {
  continue: 'Continue',
  'stop-remaining': 'Stop remaining',
  'fail-run': 'Fail run',
} satisfies Record<WorkflowChildPolicy['on_fail'], string>;

type Props = {
  step: StepDraft;
  fieldId: (field: string) => string;
  notesOf: (field: string) => FieldNote[];
  update: (patch: Partial<StepDraft>) => void;
};

export function ChildFields({ step, fieldId, notesOf, update }: Props) {
  const { session, policy, items } = step;
  if (!session) return null;
  const setSession = (patch: Partial<WorkflowChildSession>) =>
    update({ session: { ...session, ...patch } });
  const setPolicy = (patch: Partial<WorkflowChildPolicy>) => {
    if (policy) update({ policy: { ...policy, ...patch } });
  };
  return (
    <div className="space-y-3">
      <Field
        id={fieldId('child-workflow')}
        label="Child workflow"
        messages={notesOf('session')}
      >
        <Input
          id={fieldId('child-workflow')}
          size="sm"
          value={session.workflow}
          placeholder="worker-gates"
          onChange={event => setSession({ workflow: event.target.value })}
        />
      </Field>
      <Field
        id={fieldId('child-title')}
        label="Session title"
        hint="Use a template such as {{ item.id }}."
      >
        <Input
          id={fieldId('child-title')}
          size="sm"
          value={session.title}
          onChange={event => setSession({ title: event.target.value })}
        />
      </Field>
      <Field id={fieldId('child-provider')} label="Provider">
        <Select
          value={session.provider}
          onValueChange={value => {
            const provider = providerSchema.parse(value);
            setSession({
              provider,
              effort: undefined,
              mode: isProviderSessionMode(provider, session.mode)
                ? session.mode
                : 'read-only',
            });
          }}
        >
          <SelectTrigger size="sm" id={fieldId('child-provider')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {providerSchema.options.map(provider => (
              <SelectItem key={provider} value={provider}>
                {provider}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field id={fieldId('child-mode')} label="Permission mode">
        <Select
          value={session.mode}
          onValueChange={value =>
            setSession({ mode: value as WorkflowChildSession['mode'] })
          }
        >
          <SelectTrigger size="sm" id={fieldId('child-mode')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {providerSessionModes[session.provider].map(mode => (
              <SelectItem key={mode} value={mode}>
                {modeLabels[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field id={fieldId('child-model')} label="Model">
        <Input
          id={fieldId('child-model')}
          size="sm"
          value={session.model}
          onChange={event => setSession({ model: event.target.value })}
        />
      </Field>
      <Field
        id={fieldId('child-effort')}
        label="Effort"
        hint="Leave empty to use the provider default."
      >
        <Input
          id={fieldId('child-effort')}
          size="sm"
          value={session.effort ?? ''}
          onChange={event =>
            setSession({ effort: event.target.value || undefined })
          }
        />
      </Field>
      <Field
        id={fieldId('child-directory')}
        label="Folder"
        hint="Defaults to the parent run folder."
      >
        <Input
          id={fieldId('child-directory')}
          size="sm"
          value={session.directory ?? ''}
          onChange={event =>
            setSession({ directory: event.target.value || undefined })
          }
        />
      </Field>
      <Field
        id={fieldId('child-worktree')}
        label="Create a worktree"
        layout="switch"
      >
        <Switch
          id={fieldId('child-worktree')}
          checked={session.worktree ?? false}
          onCheckedChange={worktree => setSession({ worktree })}
        />
      </Field>
      <Field
        id={fieldId('max_depth')}
        label="Maximum nesting depth"
        messages={notesOf('max_depth')}
      >
        <Input
          id={fieldId('max_depth')}
          size="sm"
          type="number"
          min={1}
          max={8}
          placeholder="2"
          value={step.max_depth ?? ''}
          onChange={event =>
            update({
              max_depth: event.target.value
                ? Number(event.target.value)
                : undefined,
            })
          }
        />
      </Field>
      {items && policy && (
        <>
          <Field id={fieldId('items-kind')} label="Items from">
            <Select
              value={items.kind}
              onValueChange={value =>
                update({
                  items: sources[value as WorkflowItemSource['kind']].source,
                  itemsText: undefined,
                })
              }
            >
              <SelectTrigger size="sm" id={fieldId('items-kind')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {Object.entries(sources).map(([value, source]) => (
                  <SelectItem key={value} value={value}>
                    {source.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            id={fieldId('items')}
            label={
              items.kind === 'inline'
                ? 'JSON items'
                : items.kind === 'file'
                  ? 'File path'
                  : 'Output reference'
            }
            messages={notesOf('items')}
          >
            {items.kind === 'inline' ? (
              <Textarea
                id={fieldId('items')}
                value={step.itemsText ?? JSON.stringify(items.values, null, 2)}
                onChange={event => {
                  const text = event.target.value;
                  const values = readInlineItems(text);
                  update({
                    itemsText: text,
                    ...(values ? { items: { kind: 'inline', values } } : {}),
                  });
                }}
              />
            ) : items.kind === 'file' ? (
              <Input
                id={fieldId('items')}
                size="sm"
                value={items.path}
                placeholder="stages.md"
                onChange={event =>
                  update({ items: { kind: 'file', path: event.target.value } })
                }
              />
            ) : (
              <Input
                id={fieldId('items')}
                size="sm"
                value={items.reference}
                placeholder="steps.prepare.outputs.items"
                onChange={event =>
                  update({
                    items: { kind: 'output', reference: event.target.value },
                  })
                }
              />
            )}
          </Field>
          {(
            [
              ['max_parallel', 'Hard parallel limit', 1, 32],
              ['soft_limit', 'Soft parallel limit', 1, 32],
              ['min_free_ram_mb', 'Minimum free RAM (MiB)', 0, 1_048_576],
              [
                'min_plan_remaining_percent',
                'Minimum provider plan remaining (%)',
                0,
                100,
              ],
              ['max_cpu_load_percent', 'Maximum CPU load (%)', 1, 100],
            ] as const
          ).map(([key, label, min, max]) => (
            <Field
              key={key}
              id={fieldId(key)}
              label={label}
              messages={key === 'max_parallel' ? notesOf('policy') : undefined}
            >
              <Input
                id={fieldId(key)}
                size="sm"
                type="number"
                min={min}
                max={max}
                value={policy[key] ?? ''}
                onChange={event => {
                  const value = event.target.value;
                  if (key === 'soft_limit' || key === 'max_cpu_load_percent')
                    setPolicy({ [key]: value ? Number(value) : undefined });
                  else setPolicy({ [key]: value ? Number(value) : 0 });
                }}
              />
            </Field>
          ))}
          <Field id={fieldId('item-on-fail')} label="On child failure">
            <Select
              value={policy.on_fail}
              onValueChange={on_fail =>
                setPolicy({
                  on_fail: on_fail as WorkflowChildPolicy['on_fail'],
                })
              }
            >
              <SelectTrigger size="sm" id={fieldId('item-on-fail')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {Object.entries(failures).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </>
      )}
    </div>
  );
}
