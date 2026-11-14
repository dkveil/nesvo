import { useState } from 'react';
import { describeSchedule, type ScheduledJob } from '@nesvo/contracts';
import {
  CalendarClock,
  MessageSquarePlus,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { cn } from 'cn';
import { errorDetail, modelLabel, ProviderGlyph } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { cardIcon, cardSurface } from '@/shared/ui/card-row-styles';
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
  const switchId = `start-automation-${job.id}`;
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
    <li data-automation={job.id} className="space-y-1 px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <CalendarClock className={cardIcon} aria-hidden="true" />
        <label
          htmlFor={switchId}
          className="min-w-0 flex-1 truncate text-xs font-medium"
          title={job.name}
        >
          {job.name}
        </label>
        <Switch
          id={switchId}
          checked={job.active}
          disabled={disabled || saving}
          aria-describedby={failure ? `${switchId}-failure` : undefined}
          onCheckedChange={() => void toggle()}
        />
      </div>
      <p className="flex min-w-0 items-center gap-1.5 pl-6 text-2xs text-muted-foreground">
        <span className="min-w-0 truncate" title={scheduleText(job)}>
          {scheduleText(job)}
        </span>
        <span aria-hidden="true">·</span>
        <ProviderGlyph provider={provider} className="size-3 shrink-0" />
        <span className="shrink-0 truncate">{modelLabel(job.model)}</span>
        {!job.active && <span className="shrink-0">· Paused</span>}
      </p>
      {failure && (
        <p
          id={`${switchId}-failure`}
          role="alert"
          className="pl-6 text-2xs leading-4 text-error-foreground [overflow-wrap:anywhere]"
        >
          {failure}
        </p>
      )}
    </li>
  );
}

export function StartInspectorForm({
  hostId,
  directory,
  pipelineName,
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
  const named = !!pipelineName;
  const starting = automations.filter(
    job => job.pipeline?.name === pipelineName,
  );
  return (
    <div
      role="group"
      aria-label="Start"
      className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-3"
    >
      <section aria-label="Manual start" className="space-y-1.5">
        <h3 className="text-2xs font-medium text-muted-foreground">Manual</h3>
        <div
          data-start-row="new-thread"
          className={cn(cardSurface, 'flex items-center gap-2 px-2.5 py-2')}
        >
          <MessageSquarePlus className={cardIcon} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">New thread</p>
            <p className="text-2xs text-muted-foreground">
              Choose this pipeline when you start a thread.
            </p>
          </div>
        </div>
      </section>
      <section aria-labelledby="start-automations" className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <h3
            id="start-automations"
            className="text-2xs font-medium text-muted-foreground"
          >
            Automations
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh automations"
            title="Refresh automations"
            disabled={!connected}
            onClick={onRefresh}
          >
            <RefreshCw />
          </Button>
        </div>
        {!connected && (
          <p role="status" className="text-2xs text-muted-foreground">
            {computer?.name ?? 'This computer'} is offline. Connect it to change
            automations.
          </p>
        )}
        {starting.length > 0 ? (
          <ul className={cn(cardSurface, 'divide-y')}>
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
            No automation starts this pipeline.
          </p>
        )}
        {!named && (
          <p className="text-2xs text-muted-foreground">
            Save the pipeline before you schedule it.
          </p>
        )}
        {adding && named ? (
          <ScheduleForm
            directory={directory}
            pipelineName={pipelineName}
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
