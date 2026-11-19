import { useEffect, useState } from 'react';
import {
  repositoryPatternSchema,
  type RepositoryTrustRule,
  type RepositoryTrustSettings as TrustSettings,
  type RepositoryTrustSettingsInput,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
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
import { Input } from '@/shared/ui/input';
import { PanelBody } from '@/shared/ui/panel';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { SidePanel, SidePanelHeader } from '@/shared/ui/side-panel';
import { StatusMessage } from '@/shared/ui/status-message';

const ruleName = (rule: RepositoryTrustRule) =>
  rule.kind === 'pattern' ? rule.pattern : (rule.remote ?? rule.gitDirectory);

export function RepositoryTrustSettings({
  hostId,
  ready,
}: {
  hostId: string;
  ready: boolean;
}) {
  const [data, setData] = useState<TrustSettings>();
  const [error, setError] = useState('');
  const [pattern, setPattern] = useState('');
  const [adding, setAdding] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [remove, setRemove] = useState<RepositoryTrustRule>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ready) return;
    let current = true;
    void window.nesvo.repositoryTrustSettings({ action: 'read' }, hostId).then(
      value => {
        if (current) setData(value);
      },
      reason => {
        if (current) setError(errorDetail(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [hostId, ready]);

  const execute = async (input: RepositoryTrustSettingsInput) => {
    setBusy(true);
    setError('');
    try {
      setData(await window.nesvo.repositoryTrustSettings(input, hostId));
      return true;
    } catch (reason) {
      setError(errorDetail(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const parsed = repositoryPatternSchema.safeParse(pattern.trim());
  const rules = data?.rules.filter(rule => !rule.revokedAt);
  return (
    <div className="relative">
      <SettingsSection
        title="Repository trust"
        action={
          ready &&
          data && (
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setShowHistory(true)}
              >
                History
              </Button>
              <Dialog
                open={adding}
                onOpenChange={value => {
                  if (busy) return;
                  setAdding(value);
                  setPattern('');
                  setError('');
                }}
              >
                <DialogTrigger asChild>
                  <Button variant="secondary" size="xs">
                    Add pattern
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add repository pattern</DialogTitle>
                    <DialogDescription>
                      Match a hostname and path segments. A wildcard matches one
                      segment. Review executable definitions separately.
                    </DialogDescription>
                  </DialogHeader>
                  <Field id="repository-pattern" label="Repository pattern">
                    <Input
                      id="repository-pattern"
                      value={pattern}
                      placeholder="git.example.com/team/*"
                      onChange={event => setPattern(event.target.value)}
                    />
                  </Field>
                  {error && <StatusMessage tone="error">{error}</StatusMessage>}
                  <DialogFooter>
                    <DialogCancel disabled={busy} />
                    <Button
                      size="lg"
                      disabled={busy || !parsed.success}
                      onClick={() => {
                        if (parsed.success)
                          void execute({
                            action: 'add-pattern',
                            actionId: crypto.randomUUID(),
                            pattern: parsed.data,
                          }).then(ok => {
                            if (ok) setAdding(false);
                          });
                      }}
                    >
                      Add pattern
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
            description="Connect a computer that supports repository trust rules."
          />
        ) : !rules ? (
          <StatusMessage tone={error ? 'error' : 'loading'}>
            {error || 'Loading repository trust…'}
          </StatusMessage>
        ) : rules.length === 0 ? (
          <SettingsRow
            title="No active rules"
            description="Review a repository to approve its definitions."
          />
        ) : (
          rules.map(rule => (
            <SettingsRow
              key={rule.id}
              title={ruleName(rule)}
              description={
                rule.kind === 'pattern' ? 'Remote pattern' : 'Exact repository'
              }
            >
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => setRemove(rule)}
              >
                Revoke
              </Button>
            </SettingsRow>
          ))
        )}
      </SettingsSection>
      {showHistory && (
        <SidePanel
          kind="details"
          resizeLabel="Resize repository trust history"
          focusOnOpen
          onEscape={() => setShowHistory(false)}
          className="min-[1200px]:absolute min-[1200px]:inset-y-0 min-[1200px]:right-0"
        >
          <SidePanelHeader
            title="Repository trust history"
            titleBar={false}
            closeLabel="Close repository trust history"
            onClose={() => setShowHistory(false)}
          />
          <PanelBody className="min-h-40 overflow-y-auto">
            {data?.history.length ? (
              data.history.map(entry => (
                <SettingsRow
                  key={entry.id}
                  title={entry.target}
                  description={`${{ 'add-pattern': 'Pattern added', revoke: 'Revoked', approve: 'Reviewed and approved', defer: 'Deferred', migrate: 'Verified checkout trust migrated' }[entry.action]} · ${new Date(entry.at).toLocaleString()}${entry.provider ? ' · ' + entry.provider : ''}`}
                />
              ))
            ) : (
              <SettingsRow title="No decisions yet" />
            )}
          </PanelBody>
        </SidePanel>
      )}
      <ConfirmDialog
        open={!!remove}
        onOpenChange={open => {
          if (!open) setRemove(undefined);
        }}
        title="Revoke repository trust?"
        description={
          remove
            ? `New turns will stop using definitions approved through ${ruleName(remove)}.`
            : ''
        }
        confirmLabel="Revoke"
        onConfirm={() =>
          remove
            ? execute({
                action: 'revoke',
                actionId: crypto.randomUUID(),
                ruleId: remove.id,
              })
            : true
        }
      >
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
      </ConfirmDialog>
    </div>
  );
}
