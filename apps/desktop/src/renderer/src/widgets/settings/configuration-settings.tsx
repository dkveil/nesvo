import { useEffect, useState } from 'react';
import {
  configurationAreaSchema,
  configurationFileAreaSchema,
  configurationStatusSchema,
  type Computer,
  type ConfigurationArea,
  type ConfigurationChange,
  type ConfigurationDevice,
  type ConfigurationGrant,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { ConfigurationChangeRow } from '@/features/configuration/change-row';
import type { HostedConfigurationChange } from '@/features/configuration/use-configuration-changes';
import { Button } from '@/shared/ui/button';
import { Checkbox } from '@/shared/ui/checkbox';
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
} from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import { ListRow } from '@/shared/ui/list-row';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';

const areas: Record<ConfigurationArea, string> = {
  settings: 'Settings',
  defaults: 'Defaults',
  appearance: 'Appearance',
  'inbox-rules': 'Inbox rules',
  workflows: 'Workflows',
  steps: 'Workflow steps',
  lessons: 'Lessons',
  'gate-rules': 'Gate rules',
  'session-groups': 'Session groups',
  budgets: 'Budgets',
  automations: 'Automations',
  authority: 'Permissions',
};
const isOnline = (computer?: Computer) =>
  computer?.status === 'connected' &&
  computer.capabilities.includes('configuration');
const title = (value: string) =>
  value[0]?.toUpperCase() + value.slice(1).replaceAll('-', ' ');

function Options({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(option => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ConfigurationHistorySettings({
  computer,
  openSession,
}: {
  computer?: Computer;
  openSession: (sessionId: string) => void;
}) {
  const online = isOnline(computer);
  const hostId = computer?.id;
  const [area, setArea] = useState('all');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState<{
    area: string;
    status: string;
    records: HostedConfigurationChange[];
    next: number | null;
  } | null>(null);
  const [error, setError] = useState('');
  const base = page?.area === area && page.status === status ? page : null;
  useEffect(() => {
    if (!hostId || !online) return;
    let active = true;
    const input = {
      area: area === 'all' ? undefined : (area as ConfigurationArea),
      status:
        status === 'all'
          ? undefined
          : (status as ConfigurationChange['status']),
    };
    const load = () =>
      void window.nesvo.configuration
        .history(input, hostId)
        .then(result => {
          if (!active) return;
          if (!result.ok) setError(result.message);
          else if (result.kind === 'history') {
            setError('');
            setPage({
              area,
              status,
              records: result.page.changes.map(change => ({
                ...change,
                hostId,
              })),
              next: result.page.next,
            });
          }
        })
        .catch(issue => {
          if (active) setError(errorDetail(issue));
        });
    load();
    const unsubscribe = window.nesvo.subscribe(event => {
      if (event.type !== 'configuration-changed' || event.hostId !== hostId)
        return;
      const change = event.change;
      setPage(previous => {
        if (!previous || previous.area !== area || previous.status !== status)
          return previous;
        const older = previous.records.find(record => record.id === change.id);
        if (older && older.revision >= change.revision) return previous;
        const records = previous.records.filter(
          record => record.id !== change.id,
        );
        if (
          (!input.area || change.target.area === input.area) &&
          (!input.status || change.status === input.status)
        )
          records.unshift({ ...change, hostId });
        return { ...previous, records };
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [hostId, online, area, status]);

  const more = async () => {
    if (!hostId || !base?.next) return;
    const cursor = base.next;
    try {
      const result = await window.nesvo.configuration.history(
        {
          area: area === 'all' ? undefined : (area as ConfigurationArea),
          status:
            status === 'all'
              ? undefined
              : (status as ConfigurationChange['status']),
          after: cursor,
        },
        hostId,
      );
      if (!result.ok) setError(result.message);
      if (result.ok && result.kind === 'history') {
        const next = result.page;
        setPage(previous => {
          if (
            previous?.next !== cursor ||
            previous.area !== area ||
            previous.status !== status
          )
            return previous;
          const ids = new Set(previous.records.map(change => change.id));
          return {
            ...previous,
            next: next.next,
            records: [
              ...previous.records,
              ...next.changes
                .filter(change => !ids.has(change.id))
                .map(change => ({ ...change, hostId })),
            ],
          };
        });
      }
    } catch (issue) {
      setError(errorDetail(issue));
    }
  };

  return (
    <SettingsSection title="Configuration changes">
      <div className="flex flex-wrap gap-2 py-2">
        <Options
          label="Configuration area"
          value={area}
          onChange={setArea}
          options={[
            { value: 'all', label: 'All areas' },
            ...configurationAreaSchema.options.map(value => ({
              value,
              label: areas[value],
            })),
          ]}
        />
        <Options
          label="Configuration status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'All states' },
            ...configurationStatusSchema.options.map(value => ({
              value,
              label: title(value),
            })),
          ]}
        />
      </div>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {!online && (
        <StatusMessage>
          Connect to this computer to refresh its history.
        </StatusMessage>
      )}
      {online && base?.records.length === 0 && (
        <StatusMessage>No changes in this view.</StatusMessage>
      )}
      {base?.records.map(change => (
        <ConfigurationChangeRow
          key={change.id}
          change={change}
          computer={computer?.name ?? ''}
          online={!!online}
          onOpenSession={openSession}
        />
      ))}
      {online && base?.next && (
        <Button variant="ghost" onClick={() => void more()}>
          Load more
        </Button>
      )}
    </SettingsSection>
  );
}

export function ConfigurationDevicesSettings({
  computer,
}: {
  computer?: Computer;
}) {
  const [devices, setDevices] = useState<ConfigurationDevice[]>([]);
  const [adding, setAdding] = useState(false);
  const [revoke, setRevoke] = useState<ConfigurationDevice | null>(null);
  const [name, setName] = useState('');
  const [grants, setGrants] = useState<ConfigurationGrant[]>([]);
  const [token, setToken] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const hostId = computer?.id;
  const online = isOnline(computer);
  const available = configurationAreaSchema.options.filter(
    area => area !== 'appearance' || computer?.kind === 'local',
  );
  useEffect(() => {
    if (!hostId || !online) return;
    let current = true;
    void window.nesvo.configuration.devices(hostId).then(
      value => {
        if (current) setDevices(value);
      },
      issue => {
        if (current) setError(errorDetail(issue));
      },
    );
    return () => {
      current = false;
    };
  }, [hostId, online]);

  const update = (
    area: ConfigurationArea,
    fn: (grant: ConfigurationGrant) => ConfigurationGrant,
  ) =>
    setGrants(previous =>
      previous.map(grant => (grant.area === area ? fn(grant) : grant)),
    );
  const enroll = async () => {
    if (!hostId) return;
    setWorking(true);
    setError('');
    try {
      const result = await window.nesvo.configuration.enroll(
        { name, grants },
        hostId,
      );
      if ('token' in result) {
        setToken(result.token);
        setDevices(previous => [...previous, result.device]);
      } else if (!result.ok) setError(result.message);
    } catch (issue) {
      setError(errorDetail(issue));
    } finally {
      setWorking(false);
    }
  };
  const close = () => {
    setAdding(false);
    setToken('');
    setName('');
    setGrants([]);
    setError('');
  };
  return (
    <SettingsSection
      title="Configuration devices"
      action={
        <Button size="sm" disabled={!online} onClick={() => setAdding(true)}>
          Enroll device
        </Button>
      }
    >
      {!online && (
        <StatusMessage>Connect to manage configuration devices.</StatusMessage>
      )}
      {devices.map(device => (
        <ListRow
          key={device.id}
          density="two-line"
          title={device.name}
          description={device.grants
            .map(grant => `${areas[grant.area]} · ${grant.verbs.join(', ')}`)
            .join(' · ')}
          trailing={
            <Button
              size="sm"
              variant="ghost"
              disabled={!online}
              onClick={() => setRevoke(device)}
            >
              Revoke
            </Button>
          }
        />
      ))}
      {!adding && error && <StatusMessage tone="error">{error}</StatusMessage>}
      {adding && (
        <Dialog
          open
          onOpenChange={open => {
            if (!open && !working) close();
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {token ? 'Device token' : 'Enroll configuration device'}
              </DialogTitle>
              <DialogDescription>
                {token
                  ? 'Copy this token to your protected device credentials. It is shown once.'
                  : `Choose access for this device on ${computer?.name ?? 'this computer'}.`}
              </DialogDescription>
            </DialogHeader>
            {token ? (
              <CodeBlock code={token} wrap />
            ) : (
              <form
                id="config-device-form"
                onSubmit={event => {
                  event.preventDefault();
                  void enroll();
                }}
                className="max-h-[55vh] space-y-2 overflow-y-auto"
              >
                <Field id="config-device-name" label="Device name">
                  <Input
                    id="config-device-name"
                    value={name}
                    maxLength={64}
                    onChange={event => setName(event.target.value)}
                  />
                </Field>
                {available.map(area => {
                  const grant = grants.find(item => item.area === area);
                  return (
                    <div
                      key={area}
                      className="space-y-1.5 rounded-control px-1 py-1"
                    >
                      <label className="flex items-center gap-2 text-ui">
                        <Checkbox
                          checked={!!grant}
                          onCheckedChange={checked => {
                            setGrants(previous =>
                              checked
                                ? [
                                    ...previous,
                                    {
                                      area,
                                      global: true,
                                      projects: [],
                                      verbs: ['read'],
                                    },
                                  ]
                                : previous.filter(item => item.area !== area),
                            );
                          }}
                        />
                        {areas[area]}
                      </label>
                      {grant && (
                        <div className="flex flex-wrap items-center gap-3 pl-5 text-xs">
                          {(['read', 'propose', 'apply'] as const).map(verb => (
                            <label
                              key={verb}
                              className="flex items-center gap-1.5"
                            >
                              <Checkbox
                                checked={grant.verbs.includes(verb)}
                                onCheckedChange={checked =>
                                  update(area, current => ({
                                    ...current,
                                    verbs: checked
                                      ? [...current.verbs, verb]
                                      : current.verbs.filter(
                                          item => item !== verb,
                                        ),
                                  }))
                                }
                              />
                              {title(verb)}
                            </label>
                          ))}
                          {configurationFileAreaSchema.safeParse(area)
                            .success && (
                            <label className="flex items-center gap-1.5">
                              <Checkbox
                                checked={grant.global}
                                onCheckedChange={checked =>
                                  update(area, current => ({
                                    ...current,
                                    global: checked === true,
                                  }))
                                }
                              />
                              Global
                            </label>
                          )}
                        </div>
                      )}
                      {grant &&
                        configurationFileAreaSchema.safeParse(area).success && (
                          <Field
                            id={'config-project-root-' + area}
                            label="Project root"
                            hint="Optional absolute path on this computer."
                          >
                            <Input
                              id="config-project-root"
                              value={grant.projects[0] ?? ''}
                              onChange={event => {
                                const path = event.target.value;
                                update(area, current => ({
                                  ...current,
                                  projects: path ? [path] : [],
                                }));
                              }}
                            />
                          </Field>
                        )}
                    </div>
                  );
                })}
                <StatusMessage>
                  Direct apply covers name-only group changes, appearance and
                  designated presentation settings.
                </StatusMessage>
                {error && <StatusMessage tone="error">{error}</StatusMessage>}
              </form>
            )}
            <DialogFooter>
              {token ? (
                <Button size="lg" onClick={close}>
                  Done
                </Button>
              ) : (
                <>
                  <DialogCancel disabled={working} onClick={close}>
                    Cancel
                  </DialogCancel>
                  <Button
                    size="lg"
                    form="config-device-form"
                    type="submit"
                    disabled={
                      !name.trim() ||
                      !grants.length ||
                      working ||
                      grants.some(
                        grant =>
                          !grant.verbs.length ||
                          (!grant.global && !grant.projects.length),
                      )
                    }
                  >
                    Enroll device
                  </Button>
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {revoke && (
        <ConfirmDialog
          open
          onOpenChange={open => {
            if (!open) setRevoke(null);
          }}
          title={`Revoke ${revoke.name}?`}
          description="The token will stop working. Pending proposals will require another review."
          confirmLabel="Revoke device"
          onConfirm={async () => {
            if (!hostId) return;
            try {
              setDevices(
                await window.nesvo.configuration.revoke(revoke.id, hostId),
              );
            } catch (issue) {
              setError(errorDetail(issue));
              return false;
            }
          }}
        />
      )}
    </SettingsSection>
  );
}
