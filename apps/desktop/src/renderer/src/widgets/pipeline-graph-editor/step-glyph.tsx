import { Bot, Hand, Terminal, Zap, type LucideIcon } from 'lucide-react';
import type { StepType } from '@nesvo/contracts';
import { cn } from 'cn';

const glyphs: Record<StepType, LucideIcon> = {
  command: Terminal,
  agent: Bot,
  human: Hand,
  action: Zap,
};

type Props = { type: StepType; className?: string };

export function StepGlyph({ type, className }: Props) {
  const Icon = glyphs[type];
  return (
    <Icon
      aria-hidden="true"
      className={cn('size-4 shrink-0 text-muted-foreground', className)}
    />
  );
}
