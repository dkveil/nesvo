import type { Provider } from '@nesvo/contracts';
import { formatRelativeTime } from '@/shared/lib/relative-time';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { StatusMessage } from '@/shared/ui/status-message';

type NoticeProps = {
  provider: Provider;
  attachedAt: string;
  terminal: string | null;
  pending: boolean;
  disabled: boolean;
  onReturn: () => void;
};

export function TerminalHandoffNotice({
  provider,
  attachedAt,
  terminal,
  pending,
  disabled,
  onReturn,
}: NoticeProps) {
  const now = useNow(60_000);
  return (
    <div
      data-slot="terminal-handoff"
      className="mx-auto flex max-w-(--composer-max-width) flex-wrap items-start justify-between gap-3 rounded-surface border bg-card px-3.5 py-3"
    >
      <div className="min-w-0 flex-1 basis-72 space-y-0.5">
        <p className="text-ui font-medium">
          Open in {terminal ?? 'a terminal'}
          <span className="font-normal text-muted-foreground">
            {' · '}
            <time dateTime={attachedAt}>
              {formatRelativeTime(attachedAt, now)}
            </time>
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          Nesvo will not start turns here while you work in the terminal. Turns
          made there are not shown in this history; {provider} resumes from the
          latest state of the conversation on the next turn.
        </p>
      </div>
      <Button
        size="sm"
        disabled={pending || disabled}
        aria-busy={pending || undefined}
        onClick={onReturn}
      >
        {pending ? 'Returning…' : 'Return to Nesvo'}
      </Button>
    </div>
  );
}

type CommandDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  computerName: string;
  command: string;
  error: string;
  onConfirm: () => Promise<boolean>;
};

export function TerminalCommandDialog({
  open,
  onOpenChange,
  computerName,
  command,
  error,
  onConfirm,
}: CommandDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Open in terminal"
      description={`Run this command in a terminal on ${computerName}. Nesvo stops starting turns in this session until you return.`}
      confirmLabel="Copy and hand off"
      pendingLabel="Handing off…"
      tone="default"
      onConfirm={onConfirm}
    >
      <CodeBlock code={command} label="Shell" wrap />
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
    </ConfirmDialog>
  );
}
