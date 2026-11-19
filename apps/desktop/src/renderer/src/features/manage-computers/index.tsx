import { PathInput } from '@/shared/ui/path-input';
import { MiddleTruncatedText } from '@/shared/ui/middle-truncated-text';
import { useEffect, useState, type FormEvent } from 'react';
import {
  sshComputerInputSchema,
  workLaptopRestriction,
  type Computer,
  type DesktopApi,
} from '@nesvo/contracts';
import { Monitor, Plus, Server } from 'lucide-react';
import { errorDetail } from '@/entities/session';
import {
  DefaultFolderField,
  type DefaultSessionFolders,
} from '@/features/default-session-folder';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Disclosure } from '@/shared/ui/disclosure';
import { Field } from '@/shared/ui/field';
import { WorktreeDefaultRow } from '@/features/new-thread/worktree-default-row';
import {
  readNewSessionDefaults,
  saveNewSessionDefaults,
} from '@/features/new-thread/new-session-defaults';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { Input } from '@/shared/ui/input';
import { KeyValueList, type KeyValueEntry } from '@/shared/ui/key-value-list';
import { SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage, type StatusTone } from '@/shared/ui/status-message';

type Props = {
  computers: Computer[];
  defaultFolders: DefaultSessionFolders;
  api: Pick<
    DesktopApi,
    | 'workLaptopPolicy'
    | 'chooseDirectory'
    | 'addComputer'
    | 'connectComputer'
    | 'disconnectComputer'
    | 'removeComputer'
  >;
  onEditingChange?: (editing: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onboarding?: boolean;
};

const syncFormat = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const statusTones: Record<Computer['status'], StatusTone> = {
  connected: 'success',
  connecting: 'loading',
  syncing: 'loading',
  disconnected: 'info',
  incompatible: 'warning',
  error: 'warning',
};

function connectionEntries({ lastSyncedAt, ssh }: Computer): KeyValueEntry[] {
  const entries: Array<[string, string, string | null | undefined]> = [
    [
      'synced',
      'Last synced',
      lastSyncedAt && syncFormat.format(new Date(lastSyncedAt)),
    ],
    ['entry', 'Host entry', ssh?.entryPath],
    ['node', 'Node executable', ssh?.nodePath],
    ['runtime', 'Runtime directory', ssh?.runtimeDirectory],
  ];
  return entries.flatMap(([key, label, value]) =>
    value
      ? [
          {
            key,
            label,
            value:
              key === 'synced' ? (
                value
              ) : (
                <MiddleTruncatedText path value={value} />
              ),
          },
        ]
      : [],
  );
}

const statusLabels: Record<Computer['status'], string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  syncing: 'Syncing…',
  disconnected: 'Offline',
  incompatible: 'Update required',
  error: 'Connection failed',
};

export function ManageComputers({
  computers,
  defaultFolders,
  api,
  onBusyChange,
  onEditingChange,
  onboarding = false,
}: Props) {
  const [error, setError] = useState('');
  const { workLaptopPolicy } = api;
  const [worktree, setWorktree] = useState(
    () => readNewSessionDefaults().worktree,
  );
  const [restricted, setRestricted] = useState<boolean>();
  useEffect(() => {
    void workLaptopPolicy()
      .then(policy => setRestricted(policy.enabled))
      .catch(failure => setError(errorDetail(failure)));
  }, [workLaptopPolicy]);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    onEditingChange?.(adding);
  }, [adding, onEditingChange]);
  const [removing, setRemoving] = useState<Computer | null>(null);
  const [pending, setPending] = useState('');
  useEffect(() => {
    onBusyChange?.(!!pending);
  }, [pending, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const [fields, setFields] = useState({
    name: '',
    hostname: '',
    username: '',
    port: '22',
    entryPath: '',
    runtimeDirectory: '',
    nodePath: '',
    identityFile: '',
    knownHostsFile: '',
    defaultFolder: '',
  });
  const action = async (id: string, operation: () => Promise<unknown>) => {
    if (pending) return;
    setPending(id);
    setError('');
    try {
      await operation();
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setPending('');
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = sshComputerInputSchema.safeParse({
      name: fields.name,
      hostname: fields.hostname,
      port: Number(fields.port),
      entryPath: fields.entryPath,
      runtimeDirectory: fields.runtimeDirectory,
      ...(fields.nodePath.trim() ? { nodePath: fields.nodePath.trim() } : {}),
      ...(fields.username.trim() ? { username: fields.username.trim() } : {}),
      ...(fields.identityFile.trim()
        ? { identityFile: fields.identityFile.trim() }
        : {}),
      ...(fields.knownHostsFile.trim()
        ? { knownHostsFile: fields.knownHostsFile.trim() }
        : {}),
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map(issue => issue.message).join(' '));
      return;
    }
    const folder = fields.defaultFolder.trim();
    void action('add', async () => {
      const computer = await api.addComputer(parsed.data);
      setAdding(false);
      await api.connectComputer(computer.id);
      if (!folder) return;
      try {
        await defaultFolders.save(computer.id, folder);
      } catch (failure) {
        throw new Error(
          `${computer.name} was added, but its default folder was not saved. ${errorDetail(failure)}`,
        );
      }
    });
  };
  const field = (
    name: keyof typeof fields,
    label: string,
    placeholder = '',
    required = false,
  ) => {
    const Control = [
      'entryPath',
      'runtimeDirectory',
      'defaultFolder',
      'nodePath',
      'identityFile',
      'knownHostsFile',
    ].includes(name)
      ? PathInput
      : Input;
    return (
      <Field id={`computer-${name}`} label={label}>
        <Control
          size="md"
          id={`computer-${name}`}
          value={fields[name]}
          onChange={event =>
            setFields(previous => ({ ...previous, [name]: event.target.value }))
          }
          placeholder={placeholder}
          required={required}
          disabled={!!pending}
          maxLength={name === 'name' ? 80 : name === 'port' ? 5 : 4096}
          type={name === 'port' ? 'number' : 'text'}
          {...(name === 'port' ? { min: 1, max: 65535 } : {})}
        />
      </Field>
    );
  };
  return (
    <div className="space-y-8">
      <div className="space-y-2" hidden={onboarding && adding}>
        <SettingsSection
          title={onboarding ? 'Available computers' : 'Computers'}
          action={
            restricted === false &&
            !adding && (
              <Button
                variant={onboarding ? 'outline' : 'ghost'}
                size={onboarding ? 'sm' : 'xs'}
                disabled={!!pending}
                onClick={() => setAdding(true)}
              >
                <Plus className={onboarding ? 'size-4' : undefined} />
                {onboarding ? 'Add a computer' : 'Add computer'}
              </Button>
            )
          }
        >
          {restricted && <InlineNotice>{workLaptopRestriction}</InlineNotice>}
          {computers.map(computer => (
            <section
              key={computer.id}
              aria-label={`Computer: ${computer.name}`}
              className="space-y-2 px-3 py-3"
            >
              <div className="flex min-h-7 items-center gap-2">
                {computer.kind === 'local' ? (
                  <Monitor className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Server className="size-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-ui font-medium">
                    {computer.name}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {computer.status === 'connected' &&
                  computer.kind === 'ssh' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!!pending}
                      onClick={() =>
                        void action(computer.id, () =>
                          api.disconnectComputer(computer.id),
                        )
                      }
                    >
                      Disconnect
                    </Button>
                  ) : computer.status !== 'connected' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        !!pending ||
                        computer.status === 'connecting' ||
                        computer.status === 'syncing'
                      }
                      onClick={() =>
                        void action(computer.id, () =>
                          api.connectComputer(computer.id),
                        )
                      }
                    >
                      {computer.status === 'connecting'
                        ? 'Connecting…'
                        : computer.status === 'syncing'
                          ? 'Syncing…'
                          : computer.kind === 'local'
                            ? 'Retry'
                            : 'Connect'}
                    </Button>
                  ) : null}
                  {computer.kind === 'ssh' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={
                        !!pending ||
                        computer.status === 'connecting' ||
                        computer.status === 'syncing'
                      }
                      aria-haspopup="dialog"
                      onClick={() => setRemoving(computer)}
                      aria-label={`Remove computer: ${computer.name}`}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
              <div className="space-y-1 pl-6">
                {' '}
                <StatusMessage
                  className="text-xs"
                  tone={statusTones[computer.status]}
                >
                  {statusLabels[computer.status]}
                  {computer.kind === 'local' ? ' · This computer' : ''}
                </StatusMessage>
                {computer.ssh && (
                  <p className="truncate text-xs text-muted-foreground">
                    {computer.ssh.username ? `${computer.ssh.username}@` : ''}
                    {computer.ssh.hostname}:{computer.ssh.port}
                  </p>
                )}
              </div>
              {computer.status === 'connected' && (
                <Disclosure
                  title="Default session folder"
                  className="ml-5"
                  defaultOpen={onboarding}
                >
                  <DefaultFolderField
                    key={`${computer.id}:${defaultFolders.folders[computer.id] ?? ''}`}
                    id={`computer-default-folder-${computer.id}`}
                    label="Folder"
                    computerName={computer.name}
                    value={defaultFolders.folders[computer.id] ?? null}
                    supported={defaultFolders.supported(computer.id)}
                    onSave={directory =>
                      defaultFolders.save(computer.id, directory)
                    }
                    chooseDirectory={
                      computer.kind === 'local'
                        ? api.chooseDirectory
                        : undefined
                    }
                  />
                </Disclosure>
              )}
              {onboarding &&
                computer.kind === 'local' &&
                computer.status === 'connected' && (
                  <WorktreeDefaultRow
                    id="onboarding-default-worktree"
                    className="ml-6"
                    checked={worktree}
                    onChange={checked => {
                      saveNewSessionDefaults({
                        ...readNewSessionDefaults(),
                        worktree: checked,
                      });
                      setWorktree(checked);
                    }}
                  />
                )}
              {(computer.error || computer.lastSyncedAt || computer.ssh) && (
                <Disclosure
                  triggerTone="default"
                  title={
                    computer.error
                      ? 'Connection diagnostics'
                      : 'Connection details'
                  }
                  triggerLabel={`${computer.error ? 'Connection diagnostics' : 'Connection details'} for ${computer.name}`}
                  className="ml-5"
                  contentClassName="space-y-2 pt-1 pb-0 leading-5"
                >
                  {computer.error && (
                    <StatusMessage tone="error">{computer.error}</StatusMessage>
                  )}
                  <KeyValueList entries={connectionEntries(computer)} />
                  {computer.ssh && (
                    <p>
                      SSH uses your existing identity and verified known_hosts.
                      Verify new or changed server identities in your terminal
                      before connecting.
                    </p>
                  )}
                  <p>
                    Disconnecting does not stop remote work. Offline snapshots
                    may be out of date; no commands are queued.
                  </p>
                </Disclosure>
              )}
            </section>
          ))}
        </SettingsSection>
        {!adding && (
          <p className="px-3 text-xs leading-5 text-muted-foreground">
            Sessions, files and provider accounts stay on their computer.
          </p>
        )}
      </div>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={open => {
          if (!open) setRemoving(null);
        }}
        title={`Remove ${removing?.name ?? 'computer'}?`}
        description="Nesvo forgets this computer and its offline snapshot. Work on the computer keeps running and its sessions stay there; add it again to reconnect."
        confirmLabel="Remove computer"
        pendingLabel="Removing…"
        onConfirm={() =>
          removing && action(removing.id, () => api.removeComputer(removing.id))
        }
      />
      {adding && (
        <SettingsSection title="Add SSH computer">
          <form className="space-y-3 p-3" onSubmit={submit}>
            <div className="grid gap-3 sm:grid-cols-2">
              {field('name', 'Computer name', 'My VPS', true)}
              {field('hostname', 'SSH hostname', 'server.example.com', true)}
              {field('username', 'SSH user', 'Use SSH configuration')}
              {field('port', 'Port', '22', true)}
              {field(
                'entryPath',
                'Host entry path',
                '/home/user/nesvo/apps/host/dist/main.js',
                true,
              )}
              {field(
                'runtimeDirectory',
                'Runtime directory',
                '/home/user/.nesvo-runtime',
                true,
              )}
            </div>
            {field(
              'defaultFolder',
              'Default session folder',
              'Optional, for example /home/user/development',
            )}
            <Disclosure
              title="Advanced SSH options"
              triggerTone={onboarding ? 'muted' : 'default'}
              className="-mx-2"
              contentClassName="grid gap-3 px-2 pt-2 text-foreground sm:grid-cols-3"
            >
              {field(
                'nodePath',
                'Node executable',
                'Optional, for example /usr/bin/node',
              )}
              {field('identityFile', 'Identity file', 'Use SSH configuration')}
              {field(
                'knownHostsFile',
                'Known hosts file',
                'Use SSH configuration',
              )}
            </Disclosure>
            <p className="text-xs leading-5 text-muted-foreground">
              {pending
                ? 'Wait for the connection attempt to finish to edit this form.'
                : 'Enter the host entry and runtime paths on a Linux server with Node installed.'}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="md"
                disabled={!!pending}
                onClick={() => setAdding(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="md" disabled={!!pending}>
                {pending === 'add' ? 'Connecting…' : 'Add and connect'}
              </Button>
            </div>
          </form>
        </SettingsSection>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </div>
  );
}
