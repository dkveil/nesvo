import { useEffect, useState } from 'react';
import {
  worktreeProviderDefinitionSchema,
  type WorktreeProviderReply,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';
import { PanelBody } from '@/shared/ui/panel';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { SidePanel, SidePanelHeader } from '@/shared/ui/side-panel';
import { StatusMessage } from '@/shared/ui/status-message';
import { Textarea } from '@/shared/ui/textarea';

type Listing = Extract<WorktreeProviderReply, { action: 'read' }>;
type Inspection = Extract<WorktreeProviderReply, { action: 'inspect' }>;
const initialDefinition = JSON.stringify(
  {
    version: 1,
    kind: 'builtin',
    name: 'Built-in Git',
    scope: { kind: 'computer' },
  },
  null,
  2,
);

export function WorktreeProviderSettings({
  hostId,
  ready,
}: {
  hostId: string;
  ready: boolean;
}) {
  const [listing, setListing] = useState<Listing>();
  const [review, setReview] = useState<Inspection>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(false);
  const [source, setSource] = useState(initialDefinition);
  const [error, setError] = useState('');
  const [revoke, setRevoke] = useState<Listing['providers'][number]>();
  const read = async () => {
    const result = await window.nesvo.customWorktreeProviders(
      { action: 'read' },
      hostId,
    );
    if (result.action === 'read') setListing(result);
  };
  useEffect(() => {
    if (!ready) return;
    let active = true;
    void window.nesvo.customWorktreeProviders({ action: 'read' }, hostId).then(
      result => {
        if (active && result.action === 'read') setListing(result);
      },
      reason => {
        if (active) setError(errorDetail(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [hostId, ready]);
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const parsed = worktreeProviderDefinitionSchema.safeParse(
        JSON.parse(source),
      );
      if (!parsed.success) {
        setError(
          parsed.error.issues
            .map(issue => issue.path.join('.') + ' · ' + issue.message)
            .join('\n'),
        );
        return;
      }
      const reply = await window.nesvo.customWorktreeProviders(
        review
          ? {
              action: 'approve',
              actionId: crypto.randomUUID(),
              definition: parsed.data,
              fingerprint: review.fingerprint,
            }
          : { action: 'inspect', definition: parsed.data },
        hostId,
      );
      if (reply.action === 'inspect') setReview(reply);
      if (reply.action === 'approve') {
        await read();
        setOpen(false);
      }
    } catch (reason) {
      setError(errorDetail(reason));
      setReview(undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="relative">
      <SettingsSection
        title="Worktree providers"
        action={
          ready &&
          listing && (
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setHistory(true)}
              >
                History
              </Button>
              <Dialog
                open={open}
                onOpenChange={next => {
                  if (busy) return;
                  setOpen(next);
                  setError('');
                  setReview(undefined);
                  setSource(initialDefinition);
                }}
              >
                <DialogTrigger asChild>
                  <Button variant="secondary" size="xs">
                    Add provider
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-xl">
                  <DialogHeader>
                    <DialogTitle>
                      {review
                        ? 'Review worktree provider'
                        : 'Add worktree provider'}
                    </DialogTitle>
                    <DialogDescription>
                      {review
                        ? review.scope
                        : 'A computer default can be overridden by a remote pattern or an exact repository.'}
                    </DialogDescription>
                  </DialogHeader>
                  {review ? (
                    <CodeBlock
                      code={JSON.stringify(
                        {
                          roots: review.roots,
                          commands: review.commands,
                          fingerprint: review.fingerprint,
                        },
                        null,
                        2,
                      )}
                      wrap
                    />
                  ) : (
                    <Field
                      id="worktree-provider-definition"
                      label="Provider definition"
                      hint="An external provider supplies absolute executables and argv for create, remove and list."
                    >
                      <Textarea
                        id="worktree-provider-definition"
                        rows={12}
                        className="resize-none font-mono"
                        value={source}
                        onChange={event => setSource(event.target.value)}
                      />
                    </Field>
                  )}
                  {error && <StatusMessage tone="error">{error}</StatusMessage>}
                  <DialogFooter>
                    <DialogCancel disabled={busy} />
                    {review && (
                      <Button
                        size="lg"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setReview(undefined)}
                      >
                        Back
                      </Button>
                    )}
                    <Button
                      size="lg"
                      disabled={busy}
                      onClick={() => void submit()}
                    >
                      {review ? 'Approve provider' : 'Review provider'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          )
        }
      >
        {!ready ? (
          <SettingsRow
            title="Unavailable"
            description="Connect a computer that supports custom worktree providers."
          />
        ) : !listing ? (
          <StatusMessage tone={error ? 'error' : 'loading'}>
            {error || 'Loading worktree providers…'}
          </StatusMessage>
        ) : (
          <>
            {!listing.providers.some(
              provider => provider.scope.kind === 'computer',
            ) && (
              <SettingsRow
                title="Built-in Git"
                description="Computer default"
              />
            )}
            {listing.providers.map(provider => (
              <SettingsRow
                key={provider.providerId}
                title={provider.name}
                description={
                  provider.scope.kind === 'repository'
                    ? provider.scope.directory
                    : provider.scope.kind === 'pattern'
                      ? provider.scope.pattern
                      : 'Computer default'
                }
              >
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setRevoke(provider)}
                >
                  Revoke
                </Button>
              </SettingsRow>
            ))}
          </>
        )}
      </SettingsSection>
      {history && (
        <SidePanel
          kind="details"
          resizeLabel="Resize worktree provider history"
          focusOnOpen
          onEscape={() => setHistory(false)}
          className="min-[1200px]:absolute min-[1200px]:inset-y-0 min-[1200px]:right-0"
        >
          <SidePanelHeader
            title="Worktree provider history"
            closeLabel="Close worktree provider history"
            onClose={() => setHistory(false)}
            titleBar={false}
          />
          <PanelBody className="min-h-40">
            {listing?.history.length ? (
              listing.history.map(receipt => (
                <SettingsRow
                  key={receipt.actionId}
                  title={
                    receipt.operation[0]!.toUpperCase() +
                    receipt.operation.slice(1)
                  }
                  description={`${receipt.state} · ${new Date(receipt.at).toLocaleString()}${receipt.detail ? ' · ' + receipt.detail : ''}`}
                />
              ))
            ) : (
              <SettingsRow title="No decisions yet" />
            )}
          </PanelBody>
        </SidePanel>
      )}
      <ConfirmDialog
        open={!!revoke}
        onOpenChange={show => {
          if (!show) setRevoke(undefined);
        }}
        title="Revoke worktree provider?"
        description={
          revoke
            ? `New commands using ${revoke.name} will be refused until its definition is reviewed again.`
            : ''
        }
        confirmLabel="Revoke"
        onConfirm={async () => {
          if (!revoke) return true;
          setError('');
          try {
            await window.nesvo.customWorktreeProviders(
              {
                action: 'revoke',
                actionId: crypto.randomUUID(),
                providerId: revoke.providerId,
              },
              hostId,
            );
            await read();
            return true;
          } catch (reason) {
            setError(errorDetail(reason));
            return false;
          }
        }}
      >
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
      </ConfirmDialog>
    </div>
  );
}
