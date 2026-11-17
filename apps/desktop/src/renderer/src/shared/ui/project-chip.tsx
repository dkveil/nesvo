import type { ComponentProps, CSSProperties } from 'react';
import { cn } from '@/shared/lib/cn';

const PROJECT_CHIP_COLORS = 6;

export type ProjectChipProps = ComponentProps<'span'> & {
  label: string;
};

const chipColor = (label: string) => {
  let hash = 0;
  for (const character of label)
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return `var(--project-chip-${(Math.abs(hash) % PROJECT_CHIP_COLORS) + 1})`;
};

export function ProjectChip({
  label,
  className,
  style,
  ...props
}: ProjectChipProps) {
  return (
    <span
      aria-hidden="true"
      data-slot="project-chip"
      style={{ '--chip': chipColor(label), ...style } as CSSProperties}
      className={cn(
        'inline-block size-2 shrink-0 rounded-[3px] bg-(--chip) shadow-[inset_0_0_0_1px_rgb(255_255_255/22%)]',
        className,
      )}
      {...props}
    />
  );
}
