import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/shared/ui/button';

const COPIED_RESET_MS = 1500;

type Props = { body: string };

export function CopyMessageButton({ body }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard.writeText(body).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(
        () => setCopied(false),
        COPIED_RESET_MS,
      );
    });
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="text-muted-foreground"
      aria-label="Copy message"
      title={copied ? 'Copied' : 'Copy message'}
      onClick={copy}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
