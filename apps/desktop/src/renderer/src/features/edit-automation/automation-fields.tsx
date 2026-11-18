import { Lock } from 'lucide-react';
import { modeLabel, type Provider } from '@/entities/session';
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
    supportsRituals,
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
      {supportsRituals &&
        !values.reviewMode &&
        !values.writable &&
        (!values.workflow || values.browser) && (
          <Field
            id="automation-browser"
            label="Use browser"
            hint="Use a read-only browser step in a global workflow."
            layout="switch"
          >
            <Switch
              id="automation-browser"
              checked={values.browser}
              disabled={pending}
              onCheckedChange={browser => change({ browser, workflow: null })}
            />
          </Field>
        )}
      {values.browser && (
        <>
          <Field
            id="automation-browser-workflow"
            label="Global workflow name"
            messages={errorMessages(visible('browser'))}
          >
            <Input
              id="automation-browser-workflow"
              data-field="browser"
              size="md"
              value={values.workflow?.name ?? ''}
              disabled={pending}
              onChange={event =>
                change({
                  workflow: {
                    name: event.target.value,
                    specPath: values.workflow?.specPath ?? '',
                  },
                })
              }
            />
          </Field>
          <Field
            id="automation-browser-spec"
            label="Task spec path"
            hint="Path to a task spec in the selected folder."
          >
            <Input
              id="automation-browser-spec"
              size="md"
              value={values.workflow?.specPath ?? ''}
              disabled={pending}
              onChange={event =>
                change({
                  workflow: {
                    name: values.workflow?.name ?? '',
                    specPath: event.target.value,
                  },
                })
              }
            />
          </Field>
        </>
      )}
      {values.reviewMode ? null : values.workflow && !values.browser ? (
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
    visible,
  } = editor;
  return (
    <Field
      id="automation-location"
      label="Computer and folder"
      as="span"
      messages={errorMessages(visible('workspace'))}
      hint={
        locationHints.length > 0 &&
        locationHints.map(hint => (
          <span key={hint} className="block">
            {hint}
          </span>
        ))
      }
    >
      <div
        className="flex min-w-0 flex-wrap items-center gap-1"
        data-field="workspace"
        tabIndex={-1}
      >
        <HostPicker
          computers={computers}
          hostId={values.hostId}
          disabled={
            pending || editing || (!!values.workflow && !values.browser)
          }
          onChange={hostId => change({ hostId })}
          onManageComputers={manageComputers}
        />
        {!values.redCi && (
          <LocationPicker
            directory={values.directory}
            computerName={computer?.name ?? 'this computer'}
            disabled={pending || (!!values.workflow && !values.browser)}
            open={locationOpen && !pending}
            onOpenChange={setLocationOpen}
            onChange={directory => change({ directory })}
          />
        )}
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
    supportsRituals,
  } = editor;
  if (values.reviewMode) return null;
  const writableMode =
    values.provider === 'Codex' ? 'supervised' : 'accept-edits';
  const mode = values.writable ? writableMode : 'read-only';
  return (
    <>
      <Field
        id="automation-model"
        label="Model and access"
        as="span"
        hint={
          values.writable
            ? 'Runs in a separate worktree with the selected provider’s permissions.'
            : accessDetail[values.provider]
        }
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
            {modeLabel(values.provider, mode)}
          </Badge>
        </div>
      </Field>
      {supportsRituals && !values.workflow && !values.browser && (
        <Field
          id="automation-writable"
          label="Edit files in a worktree"
          layout="switch"
        >
          <Switch
            id="automation-writable"
            checked={values.writable}
            disabled={pending || values.redCi}
            onCheckedChange={writable => change({ writable })}
          />
        </Field>
      )}
    </>
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
  const {
    values,
    visible,
    pending,
    change,
    touch,
    supportsCheck,
    supportsRituals,
  } = editor;
  return (
    <section className="space-y-3" aria-label="Change trigger">
      {supportsRituals &&
        !values.reviewMode &&
        !values.workflow &&
        !values.browser && (
          <Field
            id="automation-red-ci"
            label="My pull request checks fail"
            hint="Checks your open pull requests in tracked repositories with a checkout."
            layout="switch"
          >
            <Switch
              id="automation-red-ci"
              checked={values.redCi}
              disabled={pending}
              onCheckedChange={redCi =>
                change(
                  redCi
                    ? { redCi, checkEnabled: false, writable: true }
                    : { redCi },
                )
              }
            />
          </Field>
        )}
      {!values.redCi && (
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
      )}
      {values.checkEnabled && (
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
      )}
      {(values.checkEnabled || values.redCi) && (
        <Field
          id="automation-daily-cap"
          label="Daily run cap"
          hint="Resets at midnight in the automation’s time zone."
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
      )}
      {values.checkEnabled && (
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
