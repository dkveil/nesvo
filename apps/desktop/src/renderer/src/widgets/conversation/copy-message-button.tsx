import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { IconButton } from '@/shared/ui/icon-button';

const COPIED_RESET_MS = 1500;

type Props = { body: string };

export function CopyMessageButton({ body }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard
      .writeText(body)
      .then(() => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(
          () => setCopied(false),
          COPIED_RESET_MS,
        );
      })
      .catch(() => undefined);
  };
  return (
    <IconButton label="Copy message" size={24} onClick={copy}>
      {copied ? <Check className="text-success-foreground" /> : <Copy />}
    </IconButton>
  );
}
