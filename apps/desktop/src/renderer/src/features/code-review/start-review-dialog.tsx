import { useState } from 'react';
import type {
  DesktopApi,
  DesktopReviewDraft,
  PullRequestReference,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { Input } from '@/shared/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { StatusMessage } from '@/shared/ui/status-message';
import { useCodeReviewSettings } from './use-code-review-settings';

type StartReviewApi = Pick<
  DesktopApi,
  'readCodeReviewSettings' | 'startPullRequestReview'
>;

type StartReviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: StartReviewApi;
  hostId: string;
  references: PullRequestReference[];
  defaultDirectory: string;
  onStarted: (drafts: DesktopReviewDraft[]) => void;
  onOpenSettings?: () => void;
};

type Failure = { reference: PullRequestReference; message: string };

export function StartReviewDialog({
  open,
  onOpenChange,
  api,
  hostId,
  references,
  defaultDirectory,
  onStarted,
  onOpenSettings,
}: StartReviewDialogProps) {
  const settings = useCodeReviewSettings(api, hostId, open);
  const profiles = settings.settings?.profiles ?? [];
  const [profileId, setProfileId] = useState('');
  const [directory, setDirectory] = useState(defaultDirectory);
  const [pending, setPending] = useState(false);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [requestIds, setRequestIds] = useState<Record<string, string>>({});
  const selectedProfile =
    profiles.find(profile => profile.id === profileId) ?? profiles[0];
  const single = references.length === 1;
  const keyOf = (reference: PullRequestReference) =>
    `${reference.repository}#${reference.number}:${selectedProfile?.id ?? ''}:${directory.trim()}`;
  const start = async () => {
    if (!selectedProfile || !directory.trim() || pending) return;
    setPending(true);
    setFailures([]);
    const ids = { ...requestIds };
    for (const reference of references)
      ids[keyOf(reference)] ??= crypto.randomUUID();
    setRequestIds(ids);
    const results = await Promise.allSettled(
      references.map(reference =>
        api.startPullRequestReview({
          requestId: ids[keyOf(reference)]!,
          reference,
          directory: directory.trim(),
          profileId: selectedProfile.id,
        }),
      ),
    );
    setPending(false);
    const started = results.flatMap(result =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const failed = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [
            {
              reference: references[index]!,
              message: errorDetail(result.reason),
            },
          ]
        : [],
    );
    if (started.length) onStarted(started);
    setFailures(failed);
    if (!failed.length) {
      setRequestIds({});
      onOpenChange(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!pending} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {single
              ? `Review #${references[0]?.number} with an agent`
              : `Review ${references.length} pull requests with an agent`}
          </DialogTitle>
          <DialogDescription>
            Each review runs as a read-only session on a checkout of the pull
            request head. The agent writes a draft review; nothing is posted
            until you publish it.
          </DialogDescription>
        </DialogHeader>
        {settings.status === 'error' ? (
          <StatusMessage tone="error">{settings.error}</StatusMessage>
        ) : settings.status === 'loading' && !settings.settings ? (
          <StatusMessage tone="loading">
            Loading reviewer profiles…
          </StatusMessage>
        ) : profiles.length === 0 ? (
          <InlineNotice>
            Create a reviewer profile in Settings › Code review to choose the
            provider, model and review rules.
          </InlineNotice>
        ) : (
          <div className="grid gap-3">
            <Field id="start-review-profile" label="Reviewer profile">
              <Select
                value={selectedProfile?.id ?? ''}
                onValueChange={setProfileId}
                disabled={pending}
              >
                <SelectTrigger
                  id="start-review-profile"
                  size="md"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {profiles.map(profile => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name} · {profile.provider}
                      {profile.model === 'default' ? '' : ` ${profile.model}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              id="start-review-directory"
              label="Repository checkout"
              hint="A local clone of the repository on this computer. Each review gets its own worktree."
            >
              <Input
                id="start-review-directory"
                size="md"
                value={directory}
                maxLength={4096}
                spellCheck={false}
                disabled={pending}
                placeholder="Absolute path on this computer"
                onChange={event => setDirectory(event.target.value)}
              />
            </Field>
          </div>
        )}
        {failures.length > 0 && (
          <ul className="space-y-1">
            {failures.map(failure => (
              <li
                key={`${failure.reference.repository}#${failure.reference.number}`}
              >
                <StatusMessage tone="error">
                  #{failure.reference.number}: {failure.message}
                </StatusMessage>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <DialogCancel
            disabled={pending}
            onClick={() => onOpenChange(false)}
          />
          {profiles.length === 0 && onOpenSettings ? (
            <Button
              size="lg"
              onClick={() => {
                onOpenChange(false);
                onOpenSettings();
              }}
            >
              Open Code review settings
            </Button>
          ) : (
            <Button
              size="lg"
              disabled={pending || !selectedProfile || !directory.trim()}
              aria-busy={pending || undefined}
              onClick={() => void start()}
            >
              {pending
                ? 'Starting…'
                : single
                  ? 'Start review'
                  : `Start ${references.length} reviews`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
