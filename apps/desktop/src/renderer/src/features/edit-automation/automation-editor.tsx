import { useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import type { Computer, SaveScheduledJobInput } from '@nesvo/contracts';
import type { ScheduledJob } from '@/entities/scheduled-job';
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
import { Button } from '@/shared/ui/button';
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
import { FieldError } from './field-error';
import { ScheduleFields } from './schedule-fields';

type SaveInput = Omit<SaveScheduledJobInput, 'expectedRevision'>;

type Props = {
  initial: AutomationValues;
  job: ScheduledJob | null;
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
  'timeoutMinutes',
];

const accessDetail: Record<Provider, string> = {
  'Claude Code': 'Claude Code can use Read, Glob and Grep only.',
  Codex: 'Codex runs in its read-only sandbox.',
};

export function AutomationEditor({
  initial,
  job,
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
  const editing = !!job;
  const computer = computers.find(item => item.id === values.hostId);
  const connected = computer?.status === 'connected';
  const providerStates = statuses(values.hostId);
  const providerState = providerStates[values.provider];
  const models = providerState.status?.models ?? [];
  const model =
    models.length === 0 || models.some(option => option.id === values.model)
      ? values.model
      : (models[0]?.id ?? '');
  const effort =
    values.provider === 'Codex'
      ? resolveEffort(modelEfforts(providerState, model), values.effort)
      : '';
  const resolved = { ...values, model, effort };
  const errors = validateAutomation(resolved);
  const visible = (field: AutomationField) =>
    attempted ||
    touched.includes(field) ||
    (field === 'prompt' && errors.prompt === SKILL_PROMPT_MESSAGE)
      ? errors[field]
      : undefined;
  const blockedReason = !computer
    ? 'Choose a computer that supports automations.'
    : !connected
      ? `${computer.name} is offline. Connect it to save this automation.`
      : '';
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
      <SheetContent className="w-full gap-0 bg-card p-0 sm:max-w-md">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="text-sm">
            {editing ? 'Edit automation' : 'New automation'}
          </SheetTitle>
          <SheetDescription className="text-xs">
            Runs a read-only prompt on a schedule. Each run is a session with
            its result in the Inbox.
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
            <div className="space-y-5 px-5 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="automation-name" className="text-xs">
                  Name
                </Label>
                <Input
                  id="automation-name"
                  data-field="name"
                  autoFocus
                  value={values.name}
                  maxLength={120}
                  placeholder="Morning summary"
                  aria-invalid={!!visible('name')}
                  aria-describedby={
                    visible('name') ? 'automation-name-error' : undefined
                  }
                  disabled={pending}
                  onChange={event => change({ name: event.target.value })}
                  onBlur={() => touch('name')}
                  className="h-8 text-[13px]"
                />
                <FieldError
                  id="automation-name-error"
                  message={visible('name')}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="automation-prompt" className="text-xs">
                  Prompt
                </Label>
                <Textarea
                  id="automation-prompt"
                  data-field="prompt"
                  value={values.prompt}
                  maxLength={9000}
                  placeholder="Summarize what changed since yesterday."
                  aria-invalid={!!visible('prompt')}
                  aria-describedby={
                    visible('prompt') ? 'automation-prompt-error' : undefined
                  }
                  disabled={pending}
                  onChange={event => change({ prompt: event.target.value })}
                  onBlur={() => touch('prompt')}
                  className="min-h-24 text-[13px] leading-5"
                />
                <FieldError
                  id="automation-prompt-error"
                  message={visible('prompt')}
                />
              </div>
              <div className="space-y-1.5">
                <span className="text-xs font-medium">Computer and folder</span>
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                  <HostPicker
                    computers={computers}
                    hostId={values.hostId}
                    disabled={pending || editing}
                    onChange={hostId => change({ hostId })}
                    onManageComputers={onManageComputers}
                  />
                  <LocationPicker
                    directory={values.directory}
                    computerName={computer?.name ?? 'this computer'}
                    disabled={pending}
                    open={locationOpen && !pending}
                    onOpenChange={setLocationOpen}
                    onChange={directory => change({ directory })}
                  />
                </div>
                {values.hostId === 'local' && (
                  <p className="text-2xs leading-4 text-muted-foreground">
                    Runs only while Nesvo is open.
                  </p>
                )}
                {editing && (
                  <p className="text-2xs leading-4 text-muted-foreground">
                    An automation stays on the computer it was created on.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <span className="text-xs font-medium">Model and access</span>
                <div
                  className="flex min-w-0 flex-wrap items-center gap-2"
                  data-field="model"
                  tabIndex={-1}
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
                  <span
                    className="inline-flex items-center gap-1 rounded-sm border px-1.5 text-2xs leading-5 font-medium"
                    title={accessDetail[values.provider]}
                  >
                    <Lock className="size-2.5" aria-hidden="true" />
                    Read-only
                  </span>
                </div>
                <p className="text-2xs leading-4 text-muted-foreground">
                  {accessDetail[values.provider]}
                </p>
                <FieldError
                  id="automation-model-error"
                  message={visible('model')}
                />
              </div>
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
              <div className="space-y-1.5">
                <Label htmlFor="automation-timeout" className="text-xs">
                  Time limit (minutes)
                </Label>
                <Input
                  id="automation-timeout"
                  data-field="timeoutMinutes"
                  inputMode="numeric"
                  value={values.timeoutMinutes}
                  aria-invalid={!!visible('timeoutMinutes')}
                  aria-describedby={
                    visible('timeoutMinutes')
                      ? 'automation-timeout-error'
                      : undefined
                  }
                  disabled={pending}
                  onChange={event =>
                    change({ timeoutMinutes: event.target.value })
                  }
                  onBlur={() => touch('timeoutMinutes')}
                  className="h-8 w-24 text-[13px]"
                />
                <FieldError
                  id="automation-timeout-error"
                  message={visible('timeoutMinutes')}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="automation-editor-active" className="text-xs">
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
          <SheetFooter className="gap-2 border-t px-5 py-3">
            {stale && (
              <div role="alert" className="space-y-2 text-xs">
                <p className="text-destructive">
                  This automation changed on {computer?.name ?? 'its computer'}.
                  Reload to edit the latest version.
                </p>
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
              <p
                role="alert"
                className="text-xs text-destructive [overflow-wrap:anywhere]"
              >
                {error || blockedReason}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={
                  pending ||
                  !!blockedReason ||
                  stale ||
                  errors.prompt === SKILL_PROMPT_MESSAGE
                }
              >
                {pending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
