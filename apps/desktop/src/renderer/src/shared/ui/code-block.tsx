import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { IconButton } from '@/shared/ui/icon-button';

const COPIED_FEEDBACK_MS = 1500;

type CodeBlockProps = Omit<ComponentProps<'pre'>, 'children'> & {
  code: string;
  label?: string;
  copyable?: boolean;
  wrap?: boolean;
  maxHeightClassName?: string | null;
  variant?: 'panel' | 'flat';
};

export function CodeBlock({
  code,
  label,
  copyable = true,
  wrap = false,
  maxHeightClassName = 'max-h-80',
  variant = 'panel',
  className,
  ...props
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(
        () => setCopied(false),
        COPIED_FEEDBACK_MS,
      );
    });
  };
  const copyButton = copyable && (
    <IconButton
      label={copied ? 'Copied' : 'Copy code'}
      size={24}
      onClick={copy}
      className={cn(!label && 'absolute top-1.5 right-1.5')}
    >
      {copied ? <Check className="text-success-foreground" /> : <Copy />}
    </IconButton>
  );
  return (
    <div
      data-slot="code-block"
      className={cn(
        'group/code relative min-w-0 overflow-hidden bg-code-background',
        variant === 'panel' ? 'rounded-surface border' : 'rounded-control',
      )}
    >
      {label && (
        <div
          className={cn(
            'flex h-8 items-center justify-between gap-2 pr-1 pl-3',
            variant === 'panel' && 'border-b',
          )}
        >
          <span
            className={cn(
              'truncate text-2xs text-muted-foreground',
              variant === 'panel' ? 'font-mono' : 'font-medium',
            )}
          >
            {label}
          </span>
          {copyButton}
        </div>
      )}
      <pre
        className={cn(
          'overflow-x-auto px-3 py-2 font-mono text-xs leading-5 text-foreground',
          wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre',
          maxHeightClassName ?? 'overflow-y-hidden pb-3',
          className,
        )}
        {...props}
      >
        <code>{code}</code>
      </pre>
      {!label && copyButton}
    </div>
  );
}
