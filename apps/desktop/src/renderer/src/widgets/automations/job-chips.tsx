import { CalendarClock, Cloud, Monitor, SquareDashed } from 'lucide-react';
import type { Computer } from '@nesvo/contracts';
import {
  scheduleSummary,
  sessionProviders,
  type ScheduledJob,
} from '@/entities/scheduled-job';
import {
  directoryLabel,
  effortLabel,
  modelLabel,
  ProviderGlyph,
} from '@/entities/session';
import { Chip } from '@/shared/ui/chip';
import { ProjectChip } from '@/shared/ui/project-chip';
import { Hint } from '@/shared/ui/tooltip';

export function ComputerChip({ computer }: { computer: Computer | undefined }) {
  const Icon = computer?.kind === 'ssh' ? Cloud : Monitor;
  return (
    <Chip
      size="sm"
      interactive={false}
      icon={<Icon aria-hidden="true" />}
      className="px-0"
    >
      <span>{computer?.name ?? 'Local'}</span>
    </Chip>
  );
}

export function FolderChip({ directory }: { directory: string }) {
  const path = directory.trim();
  return (
    <Hint label={path || 'Isolated folder'}>
      <Chip
        size="sm"
        interactive={false}
        icon={
          path ? (
            <ProjectChip label={directoryLabel(path)} />
          ) : (
            <SquareDashed aria-hidden="true" />
          )
        }
        className="px-0"
      >
        <span>{path ? directoryLabel(path) : 'Isolated folder'}</span>
      </Chip>
    </Hint>
  );
}

export function ModelChip({
  job,
}: {
  job: Pick<ScheduledJob, 'provider' | 'model' | 'effort'>;
}) {
  const provider = sessionProviders[job.provider];
  return (
    <Hint
      label={`${provider} · ${modelLabel(job.model)}${job.effort ? ` · ${effortLabel(job.effort)}` : ''}`}
    >
      <Chip
        size="sm"
        interactive={false}
        icon={<ProviderGlyph provider={provider} />}
        className="px-0"
      >
        <span>{modelLabel(job.model)}</span>
        {job.effort && <span>{effortLabel(job.effort)}</span>}
      </Chip>
    </Hint>
  );
}

export function ScheduleChip({ job }: { job: ScheduledJob }) {
  return (
    <Chip
      size="sm"
      interactive={false}
      icon={<CalendarClock aria-hidden="true" />}
      className="h-auto min-h-6 max-w-full px-0 [&>span]:whitespace-normal"
    >
      <span>{scheduleSummary(job)}</span>
    </Chip>
  );
}
