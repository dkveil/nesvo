import {
  Lock,
  Pencil,
  ShieldAlert,
  Sparkles,
  type LucideProps,
} from 'lucide-react';
import type { SessionMode } from '@nesvo/contracts';

export type ModeIconProps = LucideProps & {
  mode: SessionMode;
};

export function ModeIcon({ mode, ...props }: ModeIconProps) {
  if (mode === 'full-access') return <ShieldAlert {...props} />;
  if (mode === 'auto') return <Sparkles {...props} />;
  if (mode === 'read-only') return <Lock {...props} />;
  return <Pencil {...props} />;
}
