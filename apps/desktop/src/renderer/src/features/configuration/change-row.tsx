import { useMemo, useState } from 'react';
import { FilePenLine } from 'lucide-react';
import { parsePatchFiles } from '@pierre/diffs';
import {
  configurationValueSchema,
  type ConfigurationChange,
  type ConfigurationValue,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { DiffFileView } from '@/features/diff-viewer/diff-file-view';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Disclosure } from '@/shared/ui/disclosure';
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
import { Textarea } from '@/shared/ui/textarea';
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
  const [editing, setEditing] = useState<{
    revision: number;
    text: string;
    markdown: boolean;
  } | null>(null);
  const [editPending, setEditPending] = useState(false);
  const { target, source } = change;
  const name =
    'scope' in target ? target.name : (settingNames[target.key] ?? target.key);
  const scope =
    'scope' in target
      ? target.scope.kind === 'project'
        ? `Project ${target.area}`
        : `Global ${target.area}`
      : '';
  const origin =
    source.kind === 'device'
      ? source.name
      : source.kind === 'assistant'
        ? 'Inbox assistant'
        : 'Owner';
  const openEditor = async () => {
    setError('');
    try {
      const current = await window.nesvo.configuration.draft(
        { id: change.id, revision: change.revision },
        change.hostId,
      );
      if (!current.ok) {
        setError(current.message);
        return;
      }
      if (current.kind !== 'draft' || !current.draft) return;
      const markdown = current.draft.kind === 'markdown';
      setEditing({
        revision: change.revision,
        markdown,
        text:
          current.draft.kind === 'markdown'
            ? current.draft.document
            : JSON.stringify(current.draft, null, 2),
      });
    } catch (issue) {
      setError(errorDetail(issue));
    }
  };
  const previewEdit = async () => {
    if (!editing) return;
    setEditPending(true);
    setError('');
    try {
      const draft: ConfigurationValue = editing.markdown
        ? { kind: 'markdown', document: editing.text }
        : configurationValueSchema.parse(JSON.parse(editing.text));
      const result = await window.nesvo.configuration.decide(
        {
          id: change.id,
          revision: editing.revision,
          decision: 'edit',
          actionId: crypto.randomUUID(),
          draft,
        },
        change.hostId,
      );
      if (result.ok) setEditing(null);
      else setError(result.message);
    } catch {
      setError('Check the proposal draft and try again.');
    } finally {
      setEditPending(false);
    }
  };
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
        description={[
          computer,
          scope,
          origin,
          change.operation,
          new Date(change.updatedAt).toLocaleString(),
          change.decidedBy ? `Decided by ${change.decidedBy}` : '',
        ]
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
            {(change.status === 'pending' || change.status === 'conflicted') &&
              change.operation !== 'delete' && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!online || !!working}
                  onClick={() => void openEditor()}
                >
                  {change.status === 'conflicted'
                    ? 'Prepare fresh draft'
                    : 'Edit proposal'}
                </Button>
              )}
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
      {editing && (
        <Dialog
          open
          onOpenChange={open => {
            if (!open && !editPending) setEditing(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit proposal</DialogTitle>
              <DialogDescription>
                {name} · {computer}
              </DialogDescription>
            </DialogHeader>
            <Field
              id={`configuration-draft-${change.id}`}
              label={editing.markdown ? 'Rule definition' : 'Draft value'}
            >
              <Textarea
                id={`configuration-draft-${change.id}`}
                value={editing.text}
                rows={10}
                resize="none"
                onChange={event =>
                  setEditing({ ...editing, text: event.target.value })
                }
              />
            </Field>
            {error && <StatusMessage tone="error">{error}</StatusMessage>}
            <DialogFooter>
              <DialogCancel
                disabled={editPending}
                onClick={() => setEditing(null)}
              >
                Cancel
              </DialogCancel>
              <Button
                size="lg"
                disabled={!editing.text.trim() || editPending}
                onClick={() => void previewEdit()}
              >
                Review updated diff
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </article>
  );
}
