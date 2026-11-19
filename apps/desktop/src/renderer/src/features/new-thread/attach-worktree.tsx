import { useState } from 'react';
import type { AttachWorktree, WorktreeProviderReply } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/shared/ui/dialog';
import { SettingsRow, SettingsRows } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';

type Attachments = Extract<WorktreeProviderReply, { action: 'attachments' }>;

export function AttachWorktreePicker({
  hostId,
  directory,
  onAdopt,
  onView,
}: {
  hostId: string;
  directory: string;
  onAdopt: (choice: AttachWorktree) => void;
  onView: (directory: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Attachments>();
  const [error, setError] = useState('');
  const change = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setData(undefined);
    setError('');
    void window.nesvo
      .customWorktreeProviders({ action: 'attachments', directory }, hostId)
      .then(
        result => {
          if (result.action === 'attachments') setData(result);
        },
        reason => setError(errorDetail(reason)),
      );
  };
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          Attach existing worktree
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Attach existing worktree</DialogTitle>
          <DialogDescription>
            Use a folder as it is or adopt the verified checkout. Removing an
            adopted checkout requires confirmation.
          </DialogDescription>
        </DialogHeader>
        {!data ? (
          <StatusMessage tone={error ? 'error' : 'loading'}>
            {error || 'Finding registered worktrees…'}
          </StatusMessage>
        ) : (
          <SettingsRows className="max-h-[50vh] overflow-y-auto">
            {data.externalReason && (
              <StatusMessage tone="warning">
                {data.externalReason}
              </StatusMessage>
            )}
            {!data.rows.length && (
              <SettingsRow title="No verified linked checkouts" />
            )}
            {data.rows.map(({ dirty, ...row }) => (
              <SettingsRow
                key={row.checkout}
                title={row.branch}
                description={`${row.checkout} · ${dirty ? 'Existing changes' : 'Clean checkout'} · ${row.base.slice(0, 8)}`}
              >
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    onView(row.checkout);
                    change(false);
                  }}
                >
                  Use folder
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={!!data.externalReason}
                  onClick={() => {
                    onAdopt(row);
                    change(false);
                  }}
                >
                  {row.providerId ? 'Adopt with provider' : 'Adopt with Git'}
                </Button>
              </SettingsRow>
            ))}
          </SettingsRows>
        )}
      </DialogContent>
    </Dialog>
  );
}
