import { Cloud, Monitor, SquareDashed } from 'lucide-react';
import type { Computer } from '@nesvo/contracts';
import { sessionProviders, type ScheduledJob } from '@/entities/scheduled-job';
import {
  directoryLabel,
  effortLabel,
  modelLabel,
  ProviderGlyph,
} from '@/entities/session';
import { ProjectChip } from '@/shared/ui/project-chip';

export function ComputerChip({ computer }: { computer: Computer | undefined }) {
  const Icon = computer?.kind === 'ssh' ? Cloud : Monitor;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{computer?.name ?? 'Local'}</span>
    </span>
  );
}

export function FolderChip({ directory }: { directory: string }) {
  const path = directory.trim();
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1"
      title={path || 'Isolated folder'}
    >
      {path ? (
        <ProjectChip label={directoryLabel(path)} />
      ) : (
        <SquareDashed className="size-3 shrink-0" aria-hidden="true" />
      )}
      <span className="truncate">
        {path ? directoryLabel(path) : 'Isolated folder'}
      </span>
    </span>
  );
}

export function ModelChip({
  job,
}: {
  job: Pick<ScheduledJob, 'provider' | 'model' | 'effort'>;
}) {
  const provider = sessionProviders[job.provider];
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1"
      title={`${provider} · ${modelLabel(job.model)}${job.effort ? ` · ${effortLabel(job.effort)}` : ''}`}
    >
      <ProviderGlyph provider={provider} />
      <span className="truncate">{modelLabel(job.model)}</span>
      {job.effort && (
        <span className="shrink-0">{effortLabel(job.effort)}</span>
      )}
    </span>
  );
}
