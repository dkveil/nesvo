import { useEffect, useState } from 'react';
import {
  providerUsagePolicySchema,
  type Provider,
  type ProviderProfile,
  type ProviderUsageGateInput,
  type ProviderUsageGateSettings,
  type ProviderUsagePolicy,
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

export function ProviderUsageGateSettings({
  hostId,
  ready,
  profiles,
}: {
  hostId: string;
  ready: boolean;
  profiles: ProviderProfile[];
}) {
  const [settings, setSettings] = useState<ProviderUsageGateSettings>();
  const [history, setHistory] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [provider, setProvider] = useState<Provider>('Claude Code');
  const [profileId, setProfileId] = useState('default');
  const [policy, setPolicy] = useState<ProviderUsagePolicy['policy']>('warn');
  const [missing, setMissing] =
    useState<ProviderUsagePolicy['onUnavailable']>('warn');
  const [threshold, setThreshold] = useState('90');
  const [windows, setWindows] = useState('');
  useEffect(() => {
    if (!ready) return;
    let active = true;
    void window.nesvo.providerUsageGates({ action: 'read' }, hostId).then(
      value => {
        if (active) setSettings(value);
      },
      reason => {
        if (active) setError(errorDetail(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [hostId, ready]);

  const execute = async (input: ProviderUsageGateInput) => {
    setBusy(true);
    setError('');
    try {
      setSettings(await window.nesvo.providerUsageGates(input, hostId));
      return true;
    } catch (reason) {
      setError(errorDetail(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const parsed = providerUsagePolicySchema.safeParse({
    provider,
    profileId: profileId === 'default' ? null : profileId,
    policy,
    threshold: threshold.trim() ? Number(threshold) : NaN,
    windows: windows
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    onUnavailable: missing,
  });
  const label = (id?: string | null) =>
    profiles.find(profile => profile.id === id)?.label ?? 'Default account';
  const holds = settings?.holds.filter(
    hold => hold.status === 'held' || hold.status === 'ready',
  );
  return (
    <div className="relative">
      <SettingsSection
        title="Provider usage gates"
        action={
          ready &&
          settings && (
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
                onOpenChange={value => {
                  if (!busy) {
                    setOpen(value);
                    setError('');
                  }
                }}
              >
                <DialogTrigger asChild>
                  <Button variant="secondary" size="xs">
                    Add usage rule
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add provider usage rule</DialogTitle>
                    <DialogDescription>
                      Apply a warning or hold using the account’s reported usage
                      windows.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid grid-cols-2 gap-3">
                    <Field id="usage-provider" label="Provider">
                      <Select
                        value={provider}
                        onValueChange={value => {
                          setProvider(value as Provider);
                          setProfileId('default');
                        }}
                      >
                        <SelectTrigger id="usage-provider">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Claude Code">
                            Claude Code
                          </SelectItem>
                          <SelectItem value="Codex">Codex</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field id="usage-profile" label="Account">
                      <Select value={profileId} onValueChange={setProfileId}>
                        <SelectTrigger id="usage-profile">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">
                            Default account
                          </SelectItem>
                          {profiles
                            .filter(profile => profile.provider === provider)
                            .map(profile => (
                              <SelectItem key={profile.id} value={profile.id}>
                                {profile.label}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field id="usage-threshold" label="Threshold (%)">
                      <Input
                        id="usage-threshold"
                        type="number"
                        min={0}
                        max={100}
                        value={threshold}
                        onChange={event => setThreshold(event.target.value)}
                      />
                    </Field>
                    <Field id="usage-action" label="At threshold">
                      <Select
                        value={policy}
                        onValueChange={value =>
                          setPolicy(value as ProviderUsagePolicy['policy'])
                        }
                      >
                        <SelectTrigger id="usage-action">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="warn">Warn</SelectItem>
                          <SelectItem value="hold">Hold</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <Field
                    id="usage-unavailable"
                    label="When usage is unavailable"
                  >
                    <Select
                      value={missing}
                      onValueChange={value =>
                        setMissing(
                          value as ProviderUsagePolicy['onUnavailable'],
                        )
                      }
                    >
                      <SelectTrigger id="usage-unavailable">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="warn">Warn and allow</SelectItem>
                        <SelectItem value="hold">Hold</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field
                    id="usage-windows"
                    label="Window IDs (optional)"
                    hint="Separate IDs with commas. A blank field checks all applicable windows."
                  >
                    <Input
                      id="usage-windows"
                      value={windows}
                      onChange={event => setWindows(event.target.value)}
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
                            action: 'save',
                            actionId: crypto.randomUUID(),
                            policy: parsed.data,
                          }).then(ok => {
                            if (ok) setOpen(false);
                          });
                      }}
                    >
                      Save rule
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
            description="Connect a computer that supports usage gates."
          />
        ) : !settings ? (
          <StatusMessage tone={error ? 'error' : 'loading'}>
            {error || 'Loading usage rules…'}
          </StatusMessage>
        ) : (
          <>
            {!settings.policies.length && (
              <SettingsRow title="No configured usage thresholds" />
            )}
            {settings.policies.map(rule => (
              <SettingsRow
                key={rule.provider + ':' + (rule.profileId ?? '')}
                title={rule.provider + ' · ' + label(rule.profileId)}
                description={`${rule.policy === 'hold' ? 'Hold' : 'Warn'} at ${rule.threshold}% used`}
              >
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void execute({
                      action: 'remove',
                      actionId: crypto.randomUUID(),
                      target: {
                        provider: rule.provider,
                        profileId: rule.profileId,
                      },
                    })
                  }
                >
                  Remove rule
                </Button>
              </SettingsRow>
            ))}
            {holds?.map(hold => (
              <SettingsRow
                key={hold.id}
                title={hold.title}
                description={
                  hold.status === 'ready'
                    ? 'Ready for an explicit retry.'
                    : [
                        hold.evidence.reason,
                        hold.evidence.sampledAt &&
                          'Checked ' +
                            new Date(
                              hold.evidence.sampledAt,
                            ).toLocaleTimeString(),
                        hold.evidence.resetsAt &&
                          'Reset ' +
                            new Date(hold.evidence.resetsAt).toLocaleString(),
                      ]
                        .filter(Boolean)
                        .join(' · ')
                }
              >
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void execute({
                      action: 'check',
                      actionId: crypto.randomUUID(),
                      holdId: hold.id,
                    })
                  }
                >
                  Check again
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void execute({
                      action: 'cancel',
                      actionId: crypto.randomUUID(),
                      holdId: hold.id,
                    })
                  }
                >
                  Cancel
                </Button>
              </SettingsRow>
            ))}
            {error && !open && (
              <StatusMessage tone="error">{error}</StatusMessage>
            )}
          </>
        )}
      </SettingsSection>
      {history && (
        <SidePanel
          kind="details"
          resizeLabel="Resize usage history"
          focusOnOpen
          onEscape={() => setHistory(false)}
          className="min-[1200px]:absolute min-[1200px]:inset-y-0 min-[1200px]:right-0"
        >
          <SidePanelHeader
            title="Usage gate history"
            closeLabel="Close usage history"
            onClose={() => setHistory(false)}
            titleBar={false}
          />
          <PanelBody className="min-h-40">
            {settings?.history.length ? (
              settings.history.map(entry => (
                <SettingsRow
                  key={entry.id}
                  title={
                    entry.target.provider +
                    ' · ' +
                    label(entry.target.profileId)
                  }
                  description={`${entry.action} · ${new Date(entry.at).toLocaleString()}`}
                />
              ))
            ) : (
              <SettingsRow title="No decisions yet" />
            )}
          </PanelBody>
        </SidePanel>
      )}
    </div>
  );
}
