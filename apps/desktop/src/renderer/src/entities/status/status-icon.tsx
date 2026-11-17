import type { ComponentProps } from 'react';
import {
  Circle,
  CircleCheck,
  CircleDot,
  CircleX,
  Info,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { cn } from 'cn';
import { statusTones, toneText, type StatusKind, type Tone } from './tone';

const statusIcons: Record<StatusKind, LucideIcon> = {
  success: CircleCheck,
  error: CircleX,
  warning: TriangleAlert,
  info: Info,
  pending: CircleDot,
  running: LoaderCircle,
  idle: Circle,
};

type StatusIconProps = Omit<ComponentProps<'svg'>, 'children'> & {
  status: StatusKind;
  label?: string;
  tone?: Tone;
};

export function StatusIcon({
  status,
  label,
  tone = statusTones[status],
  className,
  ...props
}: StatusIconProps) {
  const Icon = statusIcons[status];
  return (
    <Icon
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        'size-3 shrink-0',
        toneText[tone],
        status === 'running' && 'animate-spin',
        className,
      )}
      {...props}
    >
      {label && <title>{label}</title>}
    </Icon>
  );
}
