import type { ComponentProps } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
import { cn } from 'cn';

type InlineNoticeProps = ComponentProps<'p'> & {
  tone?: 'info' | 'error';
};

export function InlineNotice({
  tone = 'info',
  className,
  children,
  ...props
}: InlineNoticeProps) {
  const Icon = tone === 'error' ? TriangleAlert : Info;
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]',
        tone === 'error' && 'bg-accent',
        className,
      )}
      {...props}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          'mt-0.5 size-3.5 shrink-0',
          tone === 'error' && 'text-warning-foreground',
        )}
      />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
