import { useMemo, useState } from 'react';
import { FilePenLine } from 'lucide-react';
import { parsePatchFiles } from '@pierre/diffs';
import type { ConfigurationChange } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { DiffFileView } from '@/features/diff-viewer/diff-file-view';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Disclosure } from '@/shared/ui/disclosure';
import { ListRow } from '@/shared/ui/list-row';
import { StatusMessage } from '@/shared/ui/status-message';
import type { HostedConfigurationChange } from './use-configuration-changes';

type Action = 'accept' | 'dismiss' | 'undo';
const statuses: Record<ConfigurationChange['status'], string> = {
  pending: 'Needs review',
  applied: 'Applied',
  dismissed: 'Dismissed',
  conflicted: 'Needs a fresh proposal',
  undone: 'Undone',
  'inspection-required': 'Needs inspection',
};
const settingNames: Record<string, string> = {
  'inbox-routing': 'Default Inbox route',
  'color-scheme': 'Color scheme',
  'workflow-learning': 'Workflow learning',
  folder: 'Default session folder',
  notifications: 'Notifications',
};
const ignoreSelection = () => undefined;

export function ConfigurationChangeRow({
  change,
  computer,
  online,
  onOpenSession,
}: {
  change: HostedConfigurationChange;
  computer: string;
  online: boolean;
  onOpenSession?: (sessionId: string) => void;
}) {
  const [working, setWorking] = useState<Action | null>(null);
  const [confirm, setConfirm] = useState<{
    action: Action;
    reason: string;
    revoked: boolean;
  } | null>(null);
  const [error, setError] = useState('');
  const { target, source } = change;
  const name =
    target.area === 'inbox-rules'
      ? target.name
      : (settingNames[target.key] ?? target.key);
  const scope =
    target.area === 'inbox-rules'
      ? target.scope.kind === 'project'
        ? 'Project Inbox rule'
        : 'Global Inbox rule'
      : '';
  const origin =
    source.kind === 'device'
      ? source.name
      : source.kind === 'assistant'
        ? 'Inbox assistant'
        : 'Owner';
  const diff = useMemo(() => {
    if (change.diff.truncated) return null;
    try {
      return parsePatchFiles(change.diff.text + '\n')[0]?.files[0] ?? null;
    } catch {
      return null;
    }
  }, [change.diff]);

  const act = async (action: Action, confirmed = false, reReview = false) => {
    setWorking(action);
    setError('');
    try {
      const input = {
        id: change.id,
        revision: change.revision,
        actionId: crypto.randomUUID(),
        confirmAuthority: confirmed,
      };
      const result =
        action === 'undo'
          ? await window.nesvo.configuration.undo(input, change.hostId)
          : await window.nesvo.configuration.decide(
              { ...input, decision: action, reviewRevocation: reReview },
              change.hostId,
            );
      if (
        !result.ok &&
        result.code === 'review-required' &&
        !confirmed &&
        !reReview
      ) {
        setConfirm({
          action,
          reason: result.message,
          revoked:
            source.kind === 'device' && result.message.includes('device grant'),
        });
      } else if (!result.ok) {
        setError(result.message);
      }
    } catch (issue) {
      setError(errorDetail(issue));
    } finally {
      setWorking(null);
    }
  };

  return (
    <article
      className="min-w-0 px-2 py-1.5"
      aria-label={`Configuration change ${name}`}
    >
      <ListRow
        density="two-line"
        leading={<FilePenLine />}
        title={name}
        meta={statuses[change.status]}
        description={[computer, scope, origin, change.operation]
          .filter(Boolean)
          .join(' · ')}
        trailing={
          source.kind === 'assistant' &&
          onOpenSession && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenSession(source.sessionId)}
            >
              Open session
            </Button>
          )
        }
      />
      <Disclosure title="Review diff" triggerLabel={`Review diff for ${name}`}>
        <div className="min-w-0 space-y-2 pb-2 pl-2">
          {diff ? (
            <DiffFileView
              diff={diff}
              patch={change.diff.text}
              wrap
              commentable={false}
              draft={null}
              renderDraft={ignoreSelection}
              onDraftRange={ignoreSelection}
            />
          ) : (
            <CodeBlock
              code={change.diff.text}
              wrap
              copyable={false}
              maxHeightClassName="max-h-60"
            />
          )}
          {change.diff.truncated && (
            <StatusMessage tone="warning">
              Preview exceeded the display limit.
            </StatusMessage>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {change.status === 'pending' && (
              <>
                <Button
                  size="sm"
                  disabled={!online || !!working || change.diff.truncated}
                  onClick={() => {
                    if (change.classification === 'authority')
                      setConfirm({
                        action: 'accept',
                        reason: `Confirm the change in authority for ${name} on ${computer}.`,
                        revoked: false,
                      });
                    else void act('accept');
                  }}
                >
                  Accept
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!online || !!working}
                  onClick={() => void act('dismiss')}
                >
                  Dismiss
                </Button>
              </>
            )}
            {change.status === 'applied' && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!online || !!working}
                onClick={() => void act('undo')}
              >
                Undo
              </Button>
            )}
          </div>
        </div>
      </Disclosure>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {!online && <StatusMessage>Offline snapshot</StatusMessage>}
      {confirm && (
        <ConfirmDialog
          open
          onOpenChange={open => {
            if (!open) setConfirm(null);
          }}
          title={
            confirm.revoked
              ? 'Review revoked device proposal'
              : 'Confirm configuration change'
          }
          description={confirm.reason}
          tone="default"
          confirmLabel={
            confirm.action === 'undo' ? 'Confirm Undo' : 'Confirm and accept'
          }
          onConfirm={() => act(confirm.action, true, confirm.revoked)}
        />
      )}
    </article>
  );
}
