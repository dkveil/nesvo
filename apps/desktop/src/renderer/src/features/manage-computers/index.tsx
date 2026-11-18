import { useEffect, useState, type FormEvent } from 'react';
import {
  sshComputerInputSchema,
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
    'addComputer' | 'connectComputer' | 'disconnectComputer' | 'removeComputer'
  >;
  onBusyChange?: (busy: boolean) => void;
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
    value ? [{ key, label, value }] : [],
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
}: Props) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Computer | null>(null);
  const [pending, setPending] = useState('');
  useEffect(() => {
    onBusyChange?.(!!pending);
  }, [pending, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const [error, setError] = useState('');
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
  ) => (
    <Field id={`computer-${name}`} label={label}>
      <Input
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
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <SettingsSection
          title="Computers"
          action={
            !adding && (
              <Button
                variant="ghost"
                size="xs"
                disabled={!!pending}
                onClick={() => setAdding(true)}
              >
                <Plus />
                Add computer
              </Button>
            )
          }
        >
          {computers.map(computer => (
            <section
              key={computer.id}
              aria-label={`Computer: ${computer.name}`}
              className="space-y-2 px-3 py-3"
            >
              <div className="flex items-start gap-3">
                {computer.kind === 'local' ? (
                  <Monitor className="mt-1 size-4 text-muted-foreground" />
                ) : (
                  <Server className="mt-1 size-4 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="truncate text-ui font-medium">
                    {computer.name}
                  </p>
                  <StatusMessage tone={statusTones[computer.status]}>
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
                <div className="flex shrink-0 gap-1">
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
                      {computer.kind === 'local' ? 'Retry' : 'Connect'}
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
              {computer.status === 'connected' && (
                <DefaultFolderField
                  key={`${computer.id}:${defaultFolders.folders[computer.id] ?? ''}`}
                  id={`computer-default-folder-${computer.id}`}
                  computerName={computer.name}
                  value={defaultFolders.folders[computer.id] ?? null}
                  supported={defaultFolders.supported(computer.id)}
                  onSave={directory =>
                    defaultFolders.save(computer.id, directory)
                  }
                  className="ml-7"
                />
              )}
              {(computer.error || computer.lastSyncedAt || computer.ssh) && (
                <Disclosure
                  title="Connection details"
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
        <p className="px-3 text-xs text-muted-foreground">
          Sessions, files and provider accounts stay on their computer.
        </p>
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
          <form className="space-y-4 p-3" onSubmit={submit}>
            <div className="grid gap-4 sm:grid-cols-2">
              {field('name', 'Computer name', 'My VPS', true)}
              {field('hostname', 'SSH hostname', 'server.example.com', true)}
              {field('username', 'SSH user', 'Use SSH configuration')}
              {field('port', 'Port', '22', true)}
            </div>
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
            {field(
              'nodePath',
              'Node executable',
              'Optional, for example /usr/bin/node',
            )}
            {field(
              'defaultFolder',
              'Default session folder',
              'Optional, for example /home/user/development',
            )}
            <Disclosure
              title="Advanced SSH options"
              className="-mx-2"
              contentClassName="space-y-4 px-2 pt-3 text-foreground"
            >
              {field('identityFile', 'Identity file', 'Use SSH configuration')}
              {field(
                'knownHostsFile',
                'Known hosts file',
                'Use SSH configuration',
              )}
            </Disclosure>
            <p className="text-xs leading-5 text-muted-foreground">
              Requires an installed, running Linux host and Node, from the path
              above or the remote PATH. Credentials and local files are not
              uploaded.
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
