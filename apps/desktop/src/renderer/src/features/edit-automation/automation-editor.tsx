import { useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import type { Computer, SaveScheduledJobInput } from '@nesvo/contracts';
import type { ScheduledJob } from '@/entities/scheduled-job';
import { cn } from '@/shared/lib/cn';
import {
  errorDetail,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import { HostPicker } from '@/features/new-thread/host-picker';
import { LocationPicker } from '@/features/new-thread/location-picker';
import { ModelPicker } from '@/features/new-thread/model-picker';
import {
  modelEfforts,
  resolveEffort,
} from '@/features/new-thread/reasoning-effort';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { ScrollArea } from '@/shared/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/shared/ui/sheet';
import { StatusMessage } from '@/shared/ui/status-message';
import { Switch } from '@/shared/ui/switch';
import { Textarea } from '@/shared/ui/textarea';
import {
  automationValues,
  SKILL_PROMPT_MESSAGE,
  toSaveInput,
  validateAutomation,
  type AutomationField,
  type AutomationValues,
} from './automation-form';
import { errorMessages, messagesId } from './field-messages';
import { ScheduleFields } from './schedule-fields';

type SaveInput = Omit<SaveScheduledJobInput, 'expectedRevision'>;

type Props = {
  initial: AutomationValues;
  job: ScheduledJob | null;
  editing: boolean;
  computers: Computer[];
  statuses: (hostId: string) => ProviderStates;
  onRefreshProvider: (provider: Provider, hostId: string) => void;
  onManageComputers: () => void;
  onSave: (
    hostId: string,
    input: SaveInput,
    expectedRevision: number | null,
  ) => Promise<ScheduledJob>;
  onRecover: (hostId: string, id: string) => Promise<ScheduledJob | undefined>;
  onSaved: (job: ScheduledJob) => void;
  onClose: () => void;
};

const fieldOrder: AutomationField[] = [
  'name',
  'prompt',
  'model',
  'minutes',
  'time',
  'timeZone',
  'checkCommand',
  'dailyRunCap',
  'timeoutMinutes',
];

const accessDetail: Record<Provider, string> = {
  'Claude Code': 'Claude Code can use Read, Glob and Grep only.',
  Codex: 'Codex runs in its read-only sandbox.',
};

export function AutomationEditor({
  initial,
  job,
  editing,
  computers,
  statuses,
  onRefreshProvider,
  onManageComputers,
  onSave,
  onRecover,
  onSaved,
  onClose,
}: Props) {
  const [values, setValues] = useState(initial);
  const [baseRevision, setBaseRevision] = useState(job?.revision ?? null);
  const [touched, setTouched] = useState<AutomationField[]>([]);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const computer = computers.find(item => item.id === values.hostId);
  const connected = computer?.status === 'connected';
  const supportsCheck = !!computer?.capabilities.includes(
    'scheduled-job-change-triggers',
  );
  const providerStates = statuses(values.hostId);
  const providerState = providerStates[values.provider];
  const models = providerState.status?.models ?? [];
  const modelListed = models.some(option => option.id === values.model);
  const model =
    editing || models.length === 0 || modelListed
      ? values.model
      : (models[0]?.id ?? '');
  const catalogReady = !!providerState.status && modelListed;
  const effort =
    values.provider !== 'Codex'
      ? ''
      : catalogReady
        ? resolveEffort(modelEfforts(providerState, model), values.effort)
        : values.effort;
  const catalogNotice =
    !providerState.status || providerState.loading
      ? `${values.provider} has not reported its models on ${computer?.name ?? 'this computer'} yet. The chosen model and effort are kept.`
      : models.length > 0 && !modelListed
        ? `${values.provider} no longer reports this model. Choose another one or runs may fail.`
        : '';
  const resolved = { ...values, model, effort };
  const errors = validateAutomation(resolved);
  const visible = (field: AutomationField) =>
    attempted ||
    touched.includes(field) ||
    (field === 'prompt' && errors.prompt === SKILL_PROMPT_MESSAGE)
      ? errors[field]
      : undefined;
  const blockedReason =
    editing && !job
      ? 'This automation was deleted on its computer.'
      : !computer
        ? 'Choose a computer that supports automations.'
        : !connected
          ? `${computer.name} is offline. Connect it to save this automation.`
          : values.checkEnabled && !supportsCheck
            ? 'Update this computer’s Nesvo host to use automation change checks.'
            : '';
  const locationHints = [
    values.hostId === 'local' ? 'Runs only while Nesvo is open.' : '',
    values.workflow
      ? 'A workflow automation stays in the project of its workflow.'
      : editing
        ? 'An automation stays on the computer it was created on.'
        : '',
  ].filter(Boolean);
  const touch = (field: AutomationField) =>
    setTouched(previous =>
      previous.includes(field) ? previous : [...previous, field],
    );
  const change = (patch: Partial<AutomationValues>) =>
    setValues(previous => ({ ...previous, ...patch }));
  const reload = () => {
    if (!job) return;
    setValues(automationValues(job));
    setBaseRevision(job.revision);
    setStale(false);
    setError('');
  };
  const save = async () => {
    if (pending || blockedReason) return;
    setAttempted(true);
    const invalid = fieldOrder.find(field => errors[field]);
    if (invalid) {
      form.current
        ?.querySelector<HTMLElement>(`[data-field="${invalid}"]`)
        ?.focus();
      return;
    }
    const input = toSaveInput(resolved, effort);
    if (typeof input === 'string') {
      setError(input);
      return;
    }
    setPending(true);
    setError('');
    setStale(false);
    try {
      onSaved(await onSave(values.hostId, input, baseRevision));
    } catch (failure) {
      const detail = errorDetail(failure);
      if (/changed elsewhere/i.test(detail)) {
        setStale(true);
        return;
      }
      if (!editing && /already exists/i.test(detail)) {
        const recovered = await onRecover(values.hostId, values.id).catch(
          () => undefined,
        );
        if (recovered) {
          onSaved(recovered);
          return;
        }
      }
      setError(`Could not save the automation. ${detail}`);
    } finally {
      setPending(false);
    }
  };
  return (
    <Sheet
      open
      onOpenChange={open => {
        if (!open && !pending) onClose();
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {editing ? 'Edit automation' : 'New automation'}
          </SheetTitle>
          <SheetDescription>
            {values.workflow
              ? 'Runs a workflow on a schedule. Each run is a workflow run with its result in the Inbox.'
              : 'Runs a read-only prompt on a schedule. Each run is a session with its result in the Inbox.'}
          </SheetDescription>
        </SheetHeader>
        <form
          ref={form}
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={event => {
            event.preventDefault();
            void save();
          }}
        >
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 px-5 py-4">
              <Field
                id="automation-name"
                label="Name"
                messages={errorMessages(visible('name'))}
              >
                <Input
                  size="md"
                  id="automation-name"
                  data-field="name"
                  autoFocus
                  value={values.name}
                  maxLength={120}
                  placeholder="Morning summary"
                  aria-invalid={!!visible('name')}
                  aria-describedby={messagesId(
                    'automation-name',
                    visible('name'),
                  )}
                  disabled={pending}
                  onChange={event => change({ name: event.target.value })}
                  onBlur={() => touch('name')}
                />
              </Field>
              {values.workflow ? (
                <Field id="automation-workflow" label="Workflow" as="span">
                  <p
                    data-field="workflow"
                    className="text-ui text-muted-foreground [overflow-wrap:anywhere]"
                  >
                    {values.workflow.name} · {values.workflow.specPath}
                  </p>
                </Field>
              ) : (
                <Field
                  id="automation-prompt"
                  label="Prompt"
                  messages={errorMessages(visible('prompt'))}
                >
                  <Textarea
                    size="md"
                    id="automation-prompt"
                    data-field="prompt"
                    value={values.prompt}
                    maxLength={9000}
                    placeholder="Summarize what changed since yesterday."
                    aria-invalid={!!visible('prompt')}
                    aria-describedby={messagesId(
                      'automation-prompt',
                      visible('prompt'),
                    )}
                    disabled={pending}
                    onChange={event => change({ prompt: event.target.value })}
                    onBlur={() => touch('prompt')}
                    className="min-h-24"
                  />
                </Field>
              )}
              <Field
                id="automation-location"
                label="Computer and folder"
                as="span"
                hint={
                  locationHints.length > 0 &&
                  locationHints.map(hint => (
                    <span key={hint} className="block">
                      {hint}
                    </span>
                  ))
                }
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                  <HostPicker
                    computers={computers}
                    hostId={values.hostId}
                    disabled={pending || editing || !!values.workflow}
                    onChange={hostId => change({ hostId })}
                    onManageComputers={onManageComputers}
                  />
                  <LocationPicker
                    directory={values.directory}
                    computerName={computer?.name ?? 'this computer'}
                    disabled={pending || !!values.workflow}
                    open={locationOpen && !pending}
                    onOpenChange={setLocationOpen}
                    onChange={directory => change({ directory })}
                  />
                </div>
              </Field>
              <Field
                id="automation-model"
                label="Model and access"
                as="span"
                hint={accessDetail[values.provider]}
                messages={[
                  ...errorMessages(visible('model')),
                  ...(catalogNotice
                    ? [{ severity: 'warning' as const, message: catalogNotice }]
                    : []),
                ]}
              >
                <div
                  className="flex min-w-0 flex-wrap items-center gap-2"
                  data-field="model"
                  tabIndex={-1}
                  aria-describedby={messagesId(
                    'automation-model',
                    visible('model'),
                  )}
                >
                  <ModelPicker
                    provider={values.provider}
                    model={model}
                    effort={effort}
                    statuses={providerStates}
                    disabled={pending}
                    onChange={(provider, nextModel, nextEffort) =>
                      change({
                        provider,
                        model: nextModel,
                        effort: nextEffort,
                      })
                    }
                    onRefreshProvider={provider =>
                      onRefreshProvider(provider, values.hostId)
                    }
                  />
                  <Badge appearance="outline">
                    <Lock aria-hidden="true" />
                    Read-only
                  </Badge>
                </div>
              </Field>
              <ScheduleFields
                values={values}
                errors={{
                  time: visible('time'),
                  minutes: visible('minutes'),
                  timeZone: visible('timeZone'),
                }}
                disabled={pending}
                onChange={change}
                onBlur={touch}
              />
              <section className="space-y-3" aria-label="Change trigger">
                <Field
                  id="automation-check"
                  label="Run only when this changes"
                  layout="inline"
                >
                  <Switch
                    id="automation-check"
                    checked={values.checkEnabled}
                    disabled={
                      pending || (!supportsCheck && !values.checkEnabled)
                    }
                    onCheckedChange={checkEnabled => change({ checkEnabled })}
                  />
                </Field>
                {values.checkEnabled && (
                  <>
                    <Field
                      id="automation-check-command"
                      label="Check command"
                      hint='Enter the executable and arguments as a JSON array, such as ["git", "rev-parse", "HEAD"]. Runs in the selected folder with the host account.'
                      messages={errorMessages(visible('checkCommand'))}
                    >
                      <Textarea
                        id="automation-check-command"
                        data-field="checkCommand"
                        value={values.checkCommand}
                        spellCheck={false}
                        aria-invalid={!!visible('checkCommand')}
                        aria-describedby={cn(
                          'automation-check-command-hint',
                          messagesId(
                            'automation-check-command',
                            visible('checkCommand'),
                          ),
                        )}
                        disabled={pending}
                        onChange={event =>
                          change({ checkCommand: event.target.value })
                        }
                        onBlur={() => touch('checkCommand')}
                        className="font-mono"
                      />
                    </Field>
                    <Field
                      id="automation-daily-cap"
                      label="Daily run cap"
                      hint="Resets at midnight UTC."
                      messages={errorMessages(visible('dailyRunCap'))}
                    >
                      <Input
                        id="automation-daily-cap"
                        data-field="dailyRunCap"
                        inputMode="numeric"
                        value={values.dailyRunCap}
                        aria-invalid={!!visible('dailyRunCap')}
                        aria-describedby={cn(
                          'automation-daily-cap-hint',
                          messagesId(
                            'automation-daily-cap',
                            visible('dailyRunCap'),
                          ),
                        )}
                        disabled={pending}
                        onChange={event =>
                          change({ dailyRunCap: event.target.value })
                        }
                        onBlur={() => touch('dailyRunCap')}
                        className="w-24"
                      />
                    </Field>
                    <Field
                      id="automation-ask-first"
                      label="Ask before starting"
                      layout="inline"
                    >
                      <Switch
                        id="automation-ask-first"
                        checked={values.askFirst}
                        disabled={pending}
                        onCheckedChange={askFirst => change({ askFirst })}
                      />
                    </Field>
                  </>
                )}
              </section>
              <Field
                id="automation-timeout"
                label="Time limit (minutes)"
                messages={errorMessages(visible('timeoutMinutes'))}
              >
                <Input
                  size="md"
                  id="automation-timeout"
                  data-field="timeoutMinutes"
                  inputMode="numeric"
                  value={values.timeoutMinutes}
                  aria-invalid={!!visible('timeoutMinutes')}
                  aria-describedby={messagesId(
                    'automation-timeout',
                    visible('timeoutMinutes'),
                  )}
                  disabled={pending}
                  onChange={event =>
                    change({ timeoutMinutes: event.target.value })
                  }
                  onBlur={() => touch('timeoutMinutes')}
                  className="w-24"
                />
              </Field>
              <div className="flex items-center justify-between gap-3">
                <Label
                  htmlFor="automation-editor-active"
                  className="text-2xs text-muted-foreground"
                >
                  Active
                </Label>
                <Switch
                  id="automation-editor-active"
                  checked={values.active}
                  disabled={pending}
                  onCheckedChange={active => change({ active })}
                />
              </div>
            </div>
          </ScrollArea>
          <SheetFooter className="flex-wrap">
            {stale && (
              <div className="flex w-full items-center justify-between gap-2">
                <StatusMessage tone="error">
                  This automation changed on {computer?.name ?? 'its computer'}.
                  Reload to edit the latest version.
                </StatusMessage>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={reload}
                >
                  Reload
                </Button>
              </div>
            )}
            {(error || blockedReason) && (
              <StatusMessage tone="error" className="w-full">
                {error || blockedReason}
              </StatusMessage>
            )}
            <Button
              type="button"
              variant="ghost"
              size="md"
              disabled={pending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="md"
              disabled={
                pending ||
                !!blockedReason ||
                stale ||
                errors.prompt === SKILL_PROMPT_MESSAGE
              }
            >
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
