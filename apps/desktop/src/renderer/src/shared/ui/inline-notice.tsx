import type { ComponentProps } from 'react';
import { StatusMessage } from '@/shared/ui/status-message';

type InlineNoticeProps = ComponentProps<'p'> & {
  tone?: 'info' | 'error' | 'warning' | 'success' | 'loading';
};

export function InlineNotice({ tone = 'info', ...props }: InlineNoticeProps) {
  return <StatusMessage variant="notice" tone={tone} {...props} />;
}
