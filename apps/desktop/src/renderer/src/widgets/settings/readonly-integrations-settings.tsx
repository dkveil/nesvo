import { useEffect, useState } from 'react';
import type {
  ReadonlyIntegrationReply,
  ReadonlyMcpObservation,
  Session,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { SidePanel, SidePanelHeader } from '@/shared/ui/side-panel';
import { StatusMessage } from '@/shared/ui/status-message';
import { ClaudePlanHookDialog } from './claude-plan-hook-dialog';

type Listing = Extract<ReadonlyIntegrationReply, { action: 'read' }>;
const serverPattern = /^[A-Za-z0-9_-]{1,100}$/;

export function ReadonlyIntegrationsSettings({
  hostId,
  ready,
  sessions,
}: {
  hostId: string;
  ready: boolean;
  sessions: Pick<
    Session,
    | 'id'
    | 'title'
    | 'provider'
    | 'archivedAt'
    | 'parentId'
    | 'workflowRunId'
    | 'scheduledJobId'
  >[];
}) {
  const candidates = sessions
    .filter(
      session =>
        !session.archivedAt &&
        !session.parentId &&
        !session.workflowRunId &&
        !session.scheduledJobId,
    )
    .slice(0, 80);
  const [data, setData] = useState<Listing>();
  const [open, setOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [server, setServer] = useState('');
  const [tool, setTool] = useState('');
  const [observation, setObservation] = useState<ReadonlyMcpObservation>();
  const [revoke, setRevoke] = useState<Listing['grants'][number]>();
  const [revokeHook, setRevokeHook] = useState<Listing['hooks'][number]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const read = async () => {
    const reply = await window.nesvo.readonlyIntegrationGrants(
      { action: 'read' },
      hostId,
    );
    if (reply.action === 'read') setData(reply);
  };
  useEffect(() => {
    if (!ready) return;
    let active = true;
    void window.nesvo
      .readonlyIntegrationGrants({ action: 'read' }, hostId)
      .then(
        reply => {
          if (active && reply.action === 'read') setData(reply);
        },
        reason => {
          if (active) setError(errorDetail(reason));
        },
      );
    return () => {
      active = false;
    };
  }, [hostId, ready]);
  const review = async () => {
    setBusy(true);
    setError('');
    try {
      const reply = await window.nesvo.readonlyIntegrationGrants(
        observation
          ? {
              action: 'approve-mcp',
              actionId: crypto.randomUUID(),
              sessionId: observation.sessionId,
              server: observation.server,
              revision: observation.revision,
              selection:
                tool === '*' ? { kind: 'server' } : { kind: 'tool', tool },
            }
          : { action: 'inspect-mcp', sessionId, server: server.trim() },
        hostId,
      );
      if (reply.action === 'inspect-mcp') {
        setObservation(reply.observation);
        setTool('');
      }
      if (reply.action === 'approve-mcp') {
        await read();
        setOpen(false);
      }
    } catch (reason) {
      setError(errorDetail(reason));
      if (observation) setObservation(undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="relative">
      <SettingsSection
        title="Read-only integrations"
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
                open={open}
                onOpenChange={value => {
                  if (busy) return;
                  setOpen(value);
                  setError('');
                  setObservation(undefined);
                  setSessionId(candidates[0]?.id ?? '');
                  setServer('');
                }}
              >
                <DialogTrigger asChild>
                  <Button
                    variant="secondary"
                    size="xs"
                    disabled={!candidates.length}
                  >
                    Add MCP grant
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>
                      {observation
                        ? 'Review MCP tools'
                        : 'Add read-only MCP grant'}
                    </DialogTitle>
                    <DialogDescription>
                      {observation?.endpoint ??
                        'Choose a Claude Code or Codex session and a configured MCP server.'}
                    </DialogDescription>
                  </DialogHeader>
                  {observation ? (
                    <>
                      <StatusMessage tone="warning">
                        A granted tool can have side effects. Provider tool
                        hints are advisory.
                      </StatusMessage>
                      <div className="max-h-52 overflow-y-auto">
                        {observation.tools.map(entry => (
                          <SettingsRow
                            key={entry.name}
                            title={entry.name}
                            description={
                              entry.readOnlyHint
                                ? 'Provider marks read-only'
                                : 'No read-only hint'
                            }
                          />
                        ))}
                      </div>
                      <Field id="readonly-mcp-tool" label="Grant scope">
                        <Select value={tool} onValueChange={setTool}>
                          <SelectTrigger id="readonly-mcp-tool">
                            <SelectValue placeholder="Choose a tool or reviewed set" />
                          </SelectTrigger>
                          <SelectContent>
                            {observation.tools.map(entry => (
                              <SelectItem key={entry.name} value={entry.name}>
                                {entry.name}
                              </SelectItem>
                            ))}
                            <SelectItem value="*">
                              All reviewed tools
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                    </>
                  ) : (
                    <>
                      <Field id="readonly-mcp-session" label="Session">
                        <Select value={sessionId} onValueChange={setSessionId}>
                          <SelectTrigger id="readonly-mcp-session">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {candidates.map(session => (
                              <SelectItem key={session.id} value={session.id}>
                                {session.title}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field
                        id="readonly-mcp-server"
                        label="Configured server name"
                      >
                        <Input
                          id="readonly-mcp-server"
                          value={server}
                          onChange={event => setServer(event.target.value)}
                        />
                      </Field>
                    </>
                  )}
                  {error && <StatusMessage tone="error">{error}</StatusMessage>}
                  <DialogFooter>
                    <DialogCancel disabled={busy} />
                    <Button
                      size="lg"
                      disabled={
                        busy ||
                        (observation
                          ? !tool
                          : !sessionId || !serverPattern.test(server.trim()))
                      }
                      onClick={() => void review()}
                    >
                      {observation ? 'Approve scope' : 'Review tools'}
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
            description="Connect a computer that supports read-only integration grants."
          />
        ) : !data ? (
          <StatusMessage tone={error ? 'error' : 'loading'}>
            {error || 'Loading grants…'}
          </StatusMessage>
        ) : (
          <>
            <SettingsRow
              title="Claude Code Plan hooks"
              description={data.claudeHookReason}
            >
              <ClaudePlanHookDialog
                hostId={hostId}
                sessions={candidates.filter(
                  session => session.provider === 'Claude Code',
                )}
                onSaved={read}
              />
            </SettingsRow>
            {data.hooks.map(hook => {
              const session = sessions.find(item => item.id === hook.sessionId);
              return (
                <SettingsRow
                  key={hook.id}
                  title={hook.name}
                  description={`${session?.title ?? 'Saved session'} · SessionStart${hook.matcher ? ` (${hook.matcher})` : ''}`}
                >
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      setError('');
                      void window.nesvo
                        .readonlyIntegrationGrants(
                          {
                            action: 'set-hook-enabled',
                            grantId: hook.id,
                            enabled: !hook.enabled,
                            actionId: crypto.randomUUID(),
                          },
                          hostId,
                        )
                        .then(read)
                        .catch(reason => setError(errorDetail(reason)));
                    }}
                  >
                    {hook.enabled ? 'Disable' : 'Enable in Plan'}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setRevokeHook(hook)}
                  >
                    Revoke
                  </Button>
                </SettingsRow>
              );
            })}
            <SettingsRow
              title="Codex Read-only hooks"
              description={data.codexHookReason}
            />
            <SettingsRow
              title="Claude Code Plan MCP grants"
              description={data.claudeMcpReason}
            />
            {!candidates.length && (
              <SettingsRow
                title="MCP grants"
                description="Open a standalone Claude Code or Codex session on this computer to grant a tool."
              />
            )}
            {data.grants.map(grant => (
              <SettingsRow
                key={grant.id}
                title={
                  grant.server +
                  ' · ' +
                  (grant.selection.kind === 'tool'
                    ? grant.selection.tool
                    : 'Reviewed tools')
                }
                description={
                  sessions.find(session => session.id === grant.sessionId)
                    ?.title ?? 'Saved session'
                }
              >
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setRevoke(grant)}
                >
                  Revoke
                </Button>
              </SettingsRow>
            ))}
          </>
        )}
      </SettingsSection>
      {showHistory && (
        <SidePanel
          kind="details"
          resizeLabel="Resize integration history"
          focusOnOpen
          onEscape={() => setShowHistory(false)}
          className="min-[1200px]:absolute min-[1200px]:inset-y-0 min-[1200px]:right-0"
        >
          <SidePanelHeader
            title="Read-only integration history"
            closeLabel="Close integration history"
            onClose={() => setShowHistory(false)}
            titleBar={false}
          />
          <PanelBody className="min-h-40">
            {data?.history.length ? (
              data.history.map(entry => (
                <SettingsRow
                  key={entry.id}
                  title={
                    {
                      approve: 'Grant approved',
                      revoke: 'Grant revoked',
                      invoke: 'Tool allowed',
                      'approve-hook': 'Hook approved',
                      'revoke-hook': 'Hook revoked',
                      'launch-hook': 'Hook included in launch',
                      'hold-hook': 'Hook withheld',
                      'enable-hook': 'Hook enabled',
                      'disable-hook': 'Hook disabled',
                    }[entry.action]
                  }
                  description={`${entry.hook ?? entry.tool ?? 'Server scope'} · ${new Date(entry.at).toLocaleString()}`}
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
        onOpenChange={value => {
          if (!value) setRevoke(undefined);
        }}
        title="Revoke MCP grant?"
        description="Matching future calls return to one-time approval."
        confirmLabel="Revoke"
        onConfirm={async () => {
          if (!revoke) return true;
          try {
            await window.nesvo.readonlyIntegrationGrants(
              {
                action: 'revoke',
                actionId: crypto.randomUUID(),
                grantId: revoke.id,
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
      <ConfirmDialog
        open={!!revokeHook}
        onOpenChange={value => {
          if (!value) setRevokeHook(undefined);
        }}
        title="Revoke SessionStart hook?"
        description="Future Plan launches will omit this command."
        confirmLabel="Revoke"
        onConfirm={async () => {
          if (!revokeHook) return true;
          try {
            await window.nesvo.readonlyIntegrationGrants(
              {
                action: 'revoke-hook',
                actionId: crypto.randomUUID(),
                grantId: revokeHook.id,
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
