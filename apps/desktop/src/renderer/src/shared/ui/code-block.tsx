import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from 'cn';
import { IconButton } from '@/shared/ui/icon-button';

const COPIED_FEEDBACK_MS = 1500;

type CodeBlockProps = Omit<ComponentProps<'pre'>, 'children'> & {
  code: string;
  label?: string;
  copyable?: boolean;
  wrap?: boolean;
  maxHeightClassName?: string;
};

export function CodeBlock({
  code,
  label,
  copyable = true,
  wrap = false,
  maxHeightClassName = 'max-h-80',
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
      className="group/code relative min-w-0 overflow-hidden rounded-surface border bg-code-background"
    >
      {label && (
        <div className="flex h-8 items-center justify-between gap-2 border-b pr-1 pl-3">
          <span className="truncate font-mono text-2xs text-muted-foreground">
            {label}
          </span>
          {copyButton}
        </div>
      )}
      <pre
        className={cn(
          'overflow-auto px-3 py-2 font-mono text-xs leading-5 text-foreground',
          wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre',
          maxHeightClassName,
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
