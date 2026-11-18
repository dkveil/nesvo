import type { PullRequestFile } from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';

export type FileChangeStatus = PullRequestFile['status'] | 'untracked';

const STATUS_GLYPHS: Record<
  FileChangeStatus,
  { letter: string; tone: string; label: string }
> = {
  added: { letter: 'A', tone: 'text-success-foreground', label: 'Added' },
  removed: { letter: 'D', tone: 'text-error-foreground', label: 'Deleted' },
  modified: { letter: 'M', tone: 'text-warning-foreground', label: 'Modified' },
  renamed: { letter: 'R', tone: 'text-info-foreground', label: 'Renamed' },
  copied: { letter: 'C', tone: 'text-info-foreground', label: 'Copied' },
  changed: { letter: 'M', tone: 'text-warning-foreground', label: 'Changed' },
  unchanged: { letter: '·', tone: 'text-muted-foreground', label: 'Unchanged' },
  untracked: {
    letter: 'U',
    tone: 'text-success-foreground',
    label: 'Untracked',
  },
};

type StatusLetterProps = { status: FileChangeStatus; className?: string };

export function StatusLetter({ status, className }: StatusLetterProps) {
  const glyph = STATUS_GLYPHS[status];
  return (
    <span
      title={glyph.label}
      aria-label={glyph.label}
      className={cn(
        'w-2.5 shrink-0 text-center font-mono text-2xs font-semibold',
        glyph.tone,
        className,
      )}
    >
      {glyph.letter}
    </span>
  );
}
