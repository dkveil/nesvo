import { useContext, useMemo, useState } from 'react';
import { FilePenLine } from 'lucide-react';
import { parsePatchFiles } from '@pierre/diffs';
import {
  configurationValueSchema,
  type ConfigurationChange,
  type ConfigurationValue,
  type DesktopSession,
} from '@nesvo/contracts';
import { errorDetail, modeLabel } from '@/entities/session';
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
import { AuthoritySettingsContext } from './authority-review';
import { FullAccessDialog } from '@/features/session-mode/full-access-dialog';
import { ApprovalActions } from '@/features/session-mode/approval-actions';

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
    revision: number;
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
  const [authoritySession, setAuthoritySession] =
    useState<DesktopSession | null>(null);
  const [authorityWarning, setAuthorityWarning] = useState('');
  const [reviewRevocation, setReviewRevocation] = useState(false);
  const openAuthoritySettings = useContext(AuthoritySettingsContext);
  const { target, source } = change;
  const setupReview = target.area === 'setup-review';
  const withheldSetup = setupReview && !change.setupVerified;
  const recipeDraft =
    target.area === 'setup-profile-file' && target.key === 'recipe';
  const effect = change.ownerEffect;
  const permission = change.sessionMode;
  const canReview =
    change.status === 'pending' || change.status === 'conflicted';
  const name =
    change.label ??
    ('scope' in target
      ? target.name
      : 'key' in target
        ? (settingNames[target.key] ?? target.key)
        : target.id);
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
        ? recipeDraft
          ? 'Setup assistant'
          : 'Inbox assistant'
        : source.kind === 'system'
          ? change.target.area === 'setup-review'
            ? 'Setup profile'
            : 'Profile file changed'
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
      if (current.kind !== 'draft') return;
      if (!current.draft) {
        const refreshed = await window.nesvo.configuration.decide(
          {
            id: change.id,
            revision: change.revision,
            decision: 'edit',
            actionId: crypto.randomUUID(),
            draft: null,
          },
          change.hostId,
        );
        if (!refreshed.ok) setError(refreshed.message);
        return;
      }
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

  const reviewLink = () => ({
    id: change.id,
    revision: change.revision,
    actionId: crypto.randomUUID(),
    reviewRevocation,
  });
  const reviewAuthority = async () => {
    if (!effect) return;
    setWorking('accept');
    setError('');
    setAuthorityWarning('');
    setReviewRevocation(false);
    try {
      if (
        effect.kind === 'full-access' ||
        effect.kind === 'claude-allow-rule'
      ) {
        const session = await window.nesvo.getSession(
          { sessionId: effect.sessionId },
          change.hostId,
        );
        if (
          effect.kind === 'claude-allow-rule' &&
          (session.runId !== effect.runId ||
            !session.pendingApprovals.some(
              approval =>
                approval.id === effect.requestId &&
                approval.fingerprint === effect.fingerprint,
            ))
        )
          throw new Error(
            'The pending Claude operation changed. Prepare a fresh proposal.',
          );
        setAuthoritySession(session);
        return;
      }
      const link = {
        hostId: change.hostId,
        review: { ...reviewLink(), reviewRevocation: false },
      };
      if (effect.kind === 'phone-access') {
        openAuthoritySettings?.({ ...link, ...effect });
        return;
      }
      const loaded = await window.nesvo.configuration.draft(
        { id: change.id, revision: change.revision },
        change.hostId,
      );
      if (!loaded.ok) throw new Error(loaded.message);
      const value =
        loaded.kind === 'draft' && loaded.draft?.kind === 'authority'
          ? loaded.draft.value
          : null;
      if (
        !value ||
        typeof value === 'string' ||
        !('name' in value) ||
        value.kind !== effect.kind
      )
        throw new Error('The proposal changed. Review its latest version.');
      openAuthoritySettings?.({ ...link, kind: effect.kind, name: value.name });
    } catch (issue) {
      setError(errorDetail(issue));
    } finally {
      setWorking(null);
    }
  };
  const pendingRule =
    effect?.kind === 'claude-allow-rule'
      ? authoritySession?.pendingApprovals.find(
          approval => approval.id === effect.requestId,
        )
      : undefined;
  const completeReview = async (
    operation: Parameters<
      typeof window.nesvo.configuration.completeReview
    >[0]['operation'],
  ) => {
    setWorking('accept');
    setAuthorityWarning('');
    try {
      const result = await window.nesvo.configuration.completeReview(
        { review: reviewLink(), operation },
        change.hostId,
      );
      if (!result.recorded)
        setError(
          'The action completed. Inspect the unsettled receipt in Change history.',
        );
      setAuthoritySession(null);
    } catch (issue) {
      if (errorDetail(issue).includes('device grant changed')) {
        setAuthorityWarning(
          'The proposing device grant changed. Confirm that you still want to review this action.',
        );
      }
      throw issue;
    } finally {
      setWorking(null);
    }
  };

  const act = async (action: Action, confirmed = false, reReview = false) => {
    setWorking(action);
    setError('');
    try {
      const input = {
        id: change.id,
        revision: change.revision,
        actionId: crypto.randomUUID(),
        confirmAuthority: confirmed,
        confirmSessionMode:
          confirmed && action !== 'dismiss' && permission
            ? {
                sessionId: permission.sessionId,
                modeRevision:
                  action === 'undo' &&
                  change.resultingVersion?.type === 'revision'
                    ? change.resultingVersion.revision
                    : permission.modeRevision,
                from: action === 'undo' ? permission.to : permission.from,
                to: action === 'undo' ? permission.from : permission.to,
              }
            : undefined,
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
        !reReview &&
        (!confirmed || result.message.includes('device grant'))
      ) {
        setConfirm({
          action,
          revision: input.revision,
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
          change.outcome?.description,
        ]
          .filter(Boolean)
          .join(' · ')}
        trailing={
          onOpenSession &&
          (source.kind === 'assistant' || permission) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const id =
                  permission?.sessionId ??
                  (source.kind === 'assistant' ? source.sessionId : null);
                if (id) onOpenSession(id);
              }}
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
          {change.status === 'conflicted' && (
            <StatusMessage tone="warning">
              The target changed after this preview. Review an updated diff.
            </StatusMessage>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {canReview &&
              !setupReview &&
              (change.operation !== 'delete' ||
                change.status === 'conflicted') && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!online || !!working}
                  onClick={() => void openEditor()}
                >
                  {change.operation === 'delete'
                    ? 'Refresh delete preview'
                    : change.status === 'conflicted'
                      ? 'Prepare fresh draft'
                      : 'Edit proposal'}
                </Button>
              )}
            {change.status === 'pending' && !withheldSetup && (
              <Button
                size="sm"
                disabled={!online || !!working || change.diff.truncated}
                onClick={() => {
                  if (effect) void reviewAuthority();
                  else if (recipeDraft || change.classification === 'authority')
                    setConfirm({
                      action: 'accept',
                      revision: change.revision,
                      reason: recipeDraft
                        ? 'Save this definition as a pending recipe in the active profile.'
                        : setupReview
                          ? 'Approve this exact definition on the selected computer.'
                          : target.area === 'budgets'
                            ? `${name} on ${computer} will refuse new turns after the budget is reached.`
                            : `Confirm the change in authority for ${name} on ${computer}.`,
                      revoked: false,
                    });
                  else void act('accept');
                }}
              >
                {effect
                  ? 'Open confirmation'
                  : permission
                    ? 'Review permission change'
                    : 'Accept'}
              </Button>
            )}
            {canReview && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!online || !!working}
                onClick={() => void act('dismiss')}
              >
                Dismiss
              </Button>
            )}
            {withheldSetup && canReview && (
              <StatusMessage tone="warning">
                Runtime verification is unavailable on this computer.
              </StatusMessage>
            )}
            {change.status === 'applied' &&
              !effect &&
              permission?.from !== 'full-access' && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!online || !!working}
                  onClick={() => {
                    if (permission)
                      setConfirm({
                        action: 'undo',
                        revision: change.revision,
                        reason: '',
                        revoked: false,
                      });
                    else void act('undo');
                  }}
                >
                  Undo
                </Button>
              )}
          </div>
        </div>
      </Disclosure>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {!online && <StatusMessage>Offline snapshot</StatusMessage>}
      {authoritySession && effect?.kind === 'full-access' && (
        <FullAccessDialog
          directory={authoritySession.directory}
          provider={authoritySession.provider}
          reReview={
            authorityWarning
              ? {
                  description: authorityWarning,
                  onConfirm: () => setReviewRevocation(true),
                }
              : undefined
          }
          onClose={() => setAuthoritySession(null)}
          onConfirm={() =>
            completeReview({
              kind: effect.kind,
              directory: authoritySession.directory,
              sessionId: effect.sessionId,
            })
          }
        />
      )}
      {authoritySession &&
        effect?.kind === 'claude-allow-rule' &&
        pendingRule && (
          <Dialog
            open
            onOpenChange={open => {
              if (!open && !working) setAuthoritySession(null);
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Review Claude allow rule</DialogTitle>
                <DialogDescription>
                  Saving this rule also approves the pending operation in{' '}
                  {authoritySession.title}.
                </DialogDescription>
              </DialogHeader>
              <p className="text-ui">{pendingRule.title}</p>
              <ApprovalActions
                approval={pendingRule}
                hostId={change.hostId}
                sessionId={effect.sessionId}
                runId={effect.runId}
                initialScope={effect.scope}
                onCancel={() => setAuthoritySession(null)}
                enabled={!working}
                onDecide={input => {
                  if (
                    input.decision !== 'accept' ||
                    input.allowScope !== effect.scope ||
                    input.allowPattern === undefined
                  )
                    return;
                  void completeReview({
                    kind: effect.kind,
                    input: {
                      decision: 'accept',
                      sessionId: effect.sessionId,
                      runId: effect.runId,
                      requestId: effect.requestId,
                      fingerprint: effect.fingerprint,
                      allowScope: effect.scope,
                      allowPattern: input.allowPattern,
                    },
                  }).catch(issue => setError(errorDetail(issue)));
                }}
              />
              {authorityWarning && !reviewRevocation ? (
                <StatusMessage tone="warning">
                  {authorityWarning}{' '}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setReviewRevocation(true)}
                  >
                    Review again
                  </Button>
                </StatusMessage>
              ) : (
                error && <StatusMessage tone="error">{error}</StatusMessage>
              )}
            </DialogContent>
          </Dialog>
        )}
      {confirm && confirm.revision === change.revision && (
        <ConfirmDialog
          open
          onOpenChange={open => {
            if (!open) setConfirm(null);
          }}
          title={
            confirm.revoked
              ? 'Review revoked device proposal'
              : recipeDraft
                ? 'Save profile recipe'
                : permission
                  ? 'Confirm session permission change'
                  : 'Confirm configuration change'
          }
          description={
            permission
              ? [
                  confirm.revoked ? confirm.reason : '',
                  `${name} on ${computer} will change from ${modeLabel(permission.provider, confirm.action === 'undo' ? permission.to : permission.from)} to ${modeLabel(permission.provider, confirm.action === 'undo' ? permission.from : permission.to)}.`,
                  'The new mode applies to the next turn.',
                ]
                  .filter(Boolean)
                  .join(' ')
              : confirm.reason
          }
          tone="default"
          confirmLabel={
            confirm.action === 'undo'
              ? 'Confirm Undo'
              : recipeDraft
                ? 'Save recipe'
                : permission
                  ? 'Change permission mode'
                  : 'Confirm and accept'
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
