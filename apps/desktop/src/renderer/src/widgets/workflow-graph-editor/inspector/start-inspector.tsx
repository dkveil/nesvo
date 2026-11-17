import { useId, useState } from 'react';
import { describeSchedule, type ScheduledJob } from '@nesvo/contracts';
import {
  CalendarClock,
  MessageSquarePlus,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { errorDetail, modelLabel, ProviderGlyph } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { IconButton } from '@/shared/ui/icon-button';
import { ListRow } from '@/shared/ui/list-row';
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusMessage } from '@/shared/ui/status-message';
import { Switch } from '@/shared/ui/switch';
import { definitionOf, sessionProviders } from './automation-form';
import type { StartInspectorProps } from './index';
import { ScheduleForm } from './schedule-form';

const scheduleText = (job: ScheduledJob) => {
  try {
    return `${describeSchedule(job.schedule)} · ${job.timeZone}`;
  } catch {
    return job.timeZone;
  }
};

function AutomationRow({
  job,
  disabled,
  onToggle,
}: {
  job: ScheduledJob;
  disabled: boolean;
  onToggle: (job: ScheduledJob) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const switchId = `${useId()}automation`;
  const provider = sessionProviders[job.provider];
  const toggle = async () => {
    setSaving(true);
    setFailure('');
    try {
      await onToggle(job);
    } catch (error) {
      setFailure(errorDetail(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <li data-automation={job.id}>
      <ListRow
        density="two-line"
        leading={<CalendarClock aria-hidden="true" />}
        title={<label htmlFor={switchId}>{job.name}</label>}
        description={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate">{scheduleText(job)}</span>
            <span aria-hidden="true">·</span>
            <ProviderGlyph provider={provider} className="size-3 shrink-0" />
            <span className="shrink-0 truncate">{modelLabel(job.model)}</span>
            {!job.active && <span className="shrink-0">· Paused</span>}
          </span>
        }
        trailing={
          <Switch
            id={switchId}
            checked={job.active}
            disabled={disabled || saving}
            aria-describedby={failure ? `${switchId}-failure` : undefined}
            onCheckedChange={() => void toggle()}
          />
        }
      />
      {failure && (
        <StatusMessage
          id={`${switchId}-failure`}
          tone="error"
          className="px-2 pb-2"
        >
          {failure}
        </StatusMessage>
      )}
    </li>
  );
}

export function StartInspectorForm({
  hostId,
  directory,
  workflowName,
  specs,
  automations,
  computers,
  statuses,
  onSaveAutomation,
  onRefresh,
}: StartInspectorProps) {
  const [adding, setAdding] = useState(false);
  const computer = computers.find(item => item.id === hostId);
  const connected = computer?.status === 'connected';
  const named = !!workflowName;
  const starting = automations.filter(
    job => job.workflow?.name === workflowName,
  );
  return (
    <div
      role="group"
      aria-label="Start"
      className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-3"
    >
      <section aria-label="Manual start" className="space-y-1">
        <SectionLabel className="px-0">Manual</SectionLabel>
        <ListRow
          data-start-row="new-thread"
          density="two-line"
          leading={<MessageSquarePlus aria-hidden="true" />}
          title="New thread"
          description="Choose this workflow when you start a thread."
          className="rounded-surface border bg-card"
        />
      </section>
      <section aria-label="Automations" className="space-y-1.5">
        <SectionLabel
          className="px-0"
          action={
            <IconButton
              size={24}
              label="Refresh automations"
              disabled={!connected}
              onClick={onRefresh}
            >
              <RefreshCw />
            </IconButton>
          }
        >
          Automations
        </SectionLabel>
        {!connected && (
          <StatusMessage>
            {computer?.name ?? 'This computer'} is offline. Connect it to change
            automations.
          </StatusMessage>
        )}
        {starting.length > 0 ? (
          <ul className="divide-y rounded-surface border bg-card">
            {starting.map(job => (
              <AutomationRow
                key={job.id}
                job={job}
                disabled={!connected}
                onToggle={item =>
                  onSaveAutomation(
                    { ...definitionOf(item), active: !item.active },
                    item.revision,
                  )
                }
              />
            ))}
          </ul>
        ) : (
          <p className="text-2xs text-muted-foreground">
            No automation starts this workflow.
          </p>
        )}
        {!named && (
          <p className="text-2xs text-muted-foreground">
            Save the workflow before you schedule it.
          </p>
        )}
        {adding && named ? (
          <ScheduleForm
            directory={directory}
            workflowName={workflowName}
            specs={specs}
            statuses={statuses}
            disabled={!connected}
            onRefreshProvider={onRefresh}
            onCancel={() => setAdding(false)}
            onSave={async input => {
              await onSaveAutomation(input, null);
              setAdding(false);
            }}
          />
        ) : (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={!connected || !named}
            onClick={() => setAdding(true)}
          >
            <Plus />
            Add schedule
          </Button>
        )}
      </section>
    </div>
  );
}
