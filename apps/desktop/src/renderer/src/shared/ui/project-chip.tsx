import type { ComponentProps, CSSProperties } from 'react';
import { cn } from 'cn';

const PROJECT_CHIP_COLORS = 6;

export type ProjectChipProps = ComponentProps<'span'> & {
  label: string;
};

function projectInitials(label: string) {
  const words = label.split(/[\s\-_.]+/).filter(Boolean);
  const letters =
    words.length > 1
      ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`
      : label.slice(0, 2);
  return letters.toLocaleUpperCase();
}

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
        'inline-flex h-3.5 min-w-4 shrink-0 items-center justify-center rounded-[3px] bg-(--chip)/16 px-0.5 text-[8px] leading-none font-bold tracking-tight text-(--chip)',
        className,
      )}
      {...props}
    >
      {projectInitials(label)}
    </span>
  );
}
