import { useState, type FormEvent } from 'react';
import {
  sshComputerInputSchema,
  type Computer,
  type DesktopApi,
} from '@nesvo/contracts';
import { Monitor, Plus, Server } from 'lucide-react';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';

type Props = {
  computers: Computer[];
  api: Pick<
    DesktopApi,
    'addComputer' | 'connectComputer' | 'disconnectComputer' | 'removeComputer'
  >;
  onOpenChange: (open: boolean) => void;
};

const statusLabels: Record<Computer['status'], string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  syncing: 'Syncing…',
  disconnected: 'Offline',
  error: 'Connection failed',
};

export function ManageComputers({ computers, api, onOpenChange }: Props) {
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState('');
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
    void action('add', async () => {
      const computer = await api.addComputer(parsed.data);
      setAdding(false);
      await api.connectComputer(computer.id);
    });
  };
  const field = (
    name: keyof typeof fields,
    label: string,
    placeholder = '',
    required = false,
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={`computer-${name}`}>{label}</Label>
      <Input
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
    </div>
  );
  return (
    <Dialog
      open
      onOpenChange={value => {
        if (!pending) onOpenChange(value);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto bg-code-background sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Computers</DialogTitle>
          <DialogDescription>
            Sessions, files and provider accounts stay on their computer.
          </DialogDescription>
        </DialogHeader>
        <div className="divide-y">
          {computers.map(computer => (
            <section
              key={computer.id}
              aria-label={`Computer: ${computer.name}`}
              className="space-y-2 py-3"
            >
              <div className="flex items-start gap-3">
                {computer.kind === 'local' ? (
                  <Monitor className="mt-1 size-4 text-muted-foreground" />
                ) : (
                  <Server className="mt-1 size-4 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {computer.name}
                  </p>
                  <p
                    role="status"
                    className="mt-0.5 text-xs text-muted-foreground"
                  >
                    {statusLabels[computer.status]}
                    {computer.kind === 'local' ? ' · This computer' : ''}
                  </p>
                  {computer.ssh && (
                    <p
                      className="mt-1 truncate text-xs text-muted-foreground"
                      title={`${computer.ssh.username ? `${computer.ssh.username}@` : ''}${computer.ssh.hostname}:${computer.ssh.port}`}
                    >
                      {computer.ssh.hostname}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  {computer.status === 'connected' &&
                  computer.kind === 'ssh' ? (
                    <Button
                      size="xs"
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
                      size="xs"
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
                      Connect
                    </Button>
                  ) : null}
                  {computer.kind === 'ssh' && (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={
                        !!pending ||
                        computer.status === 'connecting' ||
                        computer.status === 'syncing'
                      }
                      onClick={() =>
                        void action(computer.id, () =>
                          api.removeComputer(computer.id),
                        )
                      }
                      aria-label={`Remove computer: ${computer.name}`}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
              {(computer.error || computer.lastSyncedAt || computer.ssh) && (
                <details className="pl-7 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">
                    Connection details
                  </summary>
                  <div className="mt-2 space-y-2 leading-5 [overflow-wrap:anywhere]">
                    {computer.error && (
                      <p role="alert" className="text-destructive">
                        {computer.error}
                      </p>
                    )}
                    {computer.lastSyncedAt && (
                      <p>
                        Last synced:{' '}
                        {new Intl.DateTimeFormat('en', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }).format(new Date(computer.lastSyncedAt))}
                      </p>
                    )}
                    {computer.ssh && (
                      <>
                        <p>Host entry: {computer.ssh.entryPath}</p>
                        {computer.ssh.nodePath && (
                          <p>Node executable: {computer.ssh.nodePath}</p>
                        )}
                        <p>
                          Runtime directory: {computer.ssh.runtimeDirectory}
                        </p>
                        <p>
                          SSH uses your existing identity and verified
                          known_hosts. Verify new or changed server identities
                          in your terminal before connecting.
                        </p>
                      </>
                    )}
                    <p>
                      Disconnecting does not stop remote work. Offline snapshots
                      may be out of date; no commands are queued.
                    </p>
                  </div>
                </details>
              )}
            </section>
          ))}
        </div>
        {adding ? (
          <form className="space-y-4 border-t pt-4" onSubmit={submit}>
            <h3 className="text-sm font-medium">Add SSH computer</h3>
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
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Advanced SSH options
              </summary>
              <div className="mt-3 space-y-4">
                {field(
                  'identityFile',
                  'Identity file',
                  'Use SSH configuration',
                )}
                {field(
                  'knownHostsFile',
                  'Known hosts file',
                  'Use SSH configuration',
                )}
              </div>
            </details>
            <p className="text-xs leading-5 text-muted-foreground">
              Requires an installed, running Linux host and Node, from the path
              above or the remote PATH. Credentials and local files are not
              uploaded.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!!pending}
                onClick={() => setAdding(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!!pending}>
                {pending === 'add' ? 'Connecting…' : 'Add and connect'}
              </Button>
            </div>
          </form>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="justify-self-start"
            disabled={!!pending}
            onClick={() => setAdding(true)}
          >
            <Plus className="size-3.5" />
            Add computer
          </Button>
        )}
        {error && (
          <p
            role="alert"
            className="text-xs leading-5 text-destructive [overflow-wrap:anywhere]"
          >
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
