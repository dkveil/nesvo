import { Lock } from 'lucide-react';
import type { Provider } from '@/entities/session';
import { cn } from '@/shared/lib/cn';
import { HostPicker } from '@/features/new-thread/host-picker';
import { LocationPicker } from '@/features/new-thread/location-picker';
import { ModelPicker } from '@/features/new-thread/model-picker';
import { Badge } from '@/shared/ui/badge';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import { Switch } from '@/shared/ui/switch';
import { Textarea } from '@/shared/ui/textarea';
import { errorMessages, messagesId } from './field-messages';
import { ReviewTaskFields } from './review-task-fields';
import { ScheduleFields } from './schedule-fields';
import { TrackedCheckoutField } from './tracked-checkout-field';
import type { AutomationEditorState } from './use-automation-editor';

type SectionProps = { editor: AutomationEditorState };

const accessDetail: Record<Provider, string> = {
  'Claude Code': 'Claude Code can use Read, Glob and Grep only.',
  Codex: 'Codex runs in its read-only sandbox.',
};

export function AutomationNameField({ editor }: SectionProps) {
  const { values, visible, pending, change, touch } = editor;
  return (
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
        aria-describedby={messagesId('automation-name', visible('name'))}
        disabled={pending}
        onChange={event => change({ name: event.target.value })}
        onBlur={() => touch('name')}
      />
    </Field>
  );
}

export function AutomationTaskFields({ editor }: SectionProps) {
  const {
    values,
    visible,
    pending,
    editing,
    change,
    touch,
    supportsReviews,
    reviewProfiles,
    trackedRepositories,
  } = editor;
  return (
    <>
      {supportsReviews && !values.workflow && (
        <ReviewTaskFields
          values={values}
          profiles={reviewProfiles}
          error={visible('review')}
          disabled={pending || editing}
          onChange={change}
        />
      )}
      {values.reviewMode && (
        <TrackedCheckoutField
          repositories={trackedRepositories.repositories}
          directory={values.directory}
          disabled={pending}
          onChange={directory => change({ directory })}
        />
      )}
      {values.reviewMode ? null : values.workflow ? (
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
    </>
  );
}

export function AutomationLocationField({ editor }: SectionProps) {
  const {
    values,
    computers,
    computer,
    pending,
    editing,
    change,
    locationHints,
    locationOpen,
    setLocationOpen,
    manageComputers,
  } = editor;
  return (
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
          onManageComputers={manageComputers}
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
  );
}

export function AutomationModelField({ editor }: SectionProps) {
  const {
    values,
    visible,
    pending,
    change,
    model,
    effort,
    providerStates,
    catalogNotice,
    refreshProvider,
  } = editor;
  if (values.reviewMode) return null;
  return (
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
        aria-describedby={messagesId('automation-model', visible('model'))}
      >
        <ModelPicker
          provider={values.provider}
          model={model}
          effort={effort}
          statuses={providerStates}
          disabled={pending}
          onChange={(provider, nextModel, nextEffort) =>
            change({ provider, model: nextModel, effort: nextEffort })
          }
          onRefreshProvider={refreshProvider}
        />
        <Badge appearance="outline">
          <Lock aria-hidden="true" />
          Read-only
        </Badge>
      </div>
    </Field>
  );
}

export function AutomationScheduleField({ editor }: SectionProps) {
  const { values, visible, pending, change, touch } = editor;
  return (
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
  );
}

export function AutomationTriggerFields({ editor }: SectionProps) {
  const { values, visible, pending, change, touch, supportsCheck } = editor;
  return (
    <section className="space-y-3" aria-label="Change trigger">
      <Field
        id="automation-check"
        label="Run only when this changes"
        hint="Runs a check command before each scheduled run and starts only when its output changed."
        layout="switch"
      >
        <Switch
          id="automation-check"
          aria-describedby="automation-check-hint"
          checked={values.checkEnabled}
          disabled={pending || (!supportsCheck && !values.checkEnabled)}
          onCheckedChange={checkEnabled => change({ checkEnabled })}
        />
      </Field>
      {values.checkEnabled && (
        <>
          <Field
            id="automation-check-command"
            label="Check command"
            hint="The program and its arguments as a JSON array. Runs in the selected folder."
            messages={errorMessages(visible('checkCommand'))}
          >
            <Input
              size="md"
              id="automation-check-command"
              data-field="checkCommand"
              placeholder='["git", "rev-parse", "HEAD"]'
              value={values.checkCommand}
              spellCheck={false}
              aria-invalid={!!visible('checkCommand')}
              aria-describedby={cn(
                'automation-check-command-hint',
                messagesId('automation-check-command', visible('checkCommand')),
              )}
              disabled={pending}
              onChange={event => change({ checkCommand: event.target.value })}
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
              size="md"
              id="automation-daily-cap"
              data-field="dailyRunCap"
              inputMode="numeric"
              value={values.dailyRunCap}
              aria-invalid={!!visible('dailyRunCap')}
              aria-describedby={cn(
                'automation-daily-cap-hint',
                messagesId('automation-daily-cap', visible('dailyRunCap')),
              )}
              disabled={pending}
              onChange={event => change({ dailyRunCap: event.target.value })}
              onBlur={() => touch('dailyRunCap')}
              className="w-24"
            />
          </Field>
          <Field
            id="automation-ask-first"
            label="Ask before starting"
            layout="switch"
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
  );
}

export function AutomationLimitFields({ editor }: SectionProps) {
  const { values, visible, pending, change, touch } = editor;
  return (
    <>
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
          onChange={event => change({ timeoutMinutes: event.target.value })}
          onBlur={() => touch('timeoutMinutes')}
          className="w-24"
        />
      </Field>
      <Field id="automation-editor-active" label="Active" layout="switch">
        <Switch
          id="automation-editor-active"
          checked={values.active}
          disabled={pending}
          onCheckedChange={active => change({ active })}
        />
      </Field>
    </>
  );
}
