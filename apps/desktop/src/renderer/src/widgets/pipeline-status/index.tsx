import type { RefObject } from 'react';
import { Workflow } from 'lucide-react';
import { cn } from 'cn';
import {
  runStatusLabel,
  runStatusTones,
  toneText,
  type PipelineRun,
} from '@/entities/pipeline';

type Props = {
  run: PipelineRun;
  open: boolean;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
};

export function PipelineStatus({ run, open, buttonRef, onToggle }: Props) {
  const label = runStatusLabel(run.status);
  return (
    <button
      ref={buttonRef}
      type="button"
      data-pipeline-status={run.status}
      aria-label={`Pipeline ${run.pipeline.name}: ${label}`}
      aria-pressed={open}
      aria-controls={open ? 'pipeline-panel' : undefined}
      title={`Pipeline ${run.pipeline.name} · ${label}`}
      onClick={onToggle}
      className={cn(
        'inline-flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors duration-100 outline-none',
        'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:bg-highlight',
        toneText[runStatusTones[run.status]],
      )}
    >
      <Workflow className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="hidden truncate sm:inline">{label}</span>
    </button>
  );
}
