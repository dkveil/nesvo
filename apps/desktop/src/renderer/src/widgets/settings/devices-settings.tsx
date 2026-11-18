import { useEffect, useState } from 'react';
import {
  externalInboxLimits,
  type Computer,
  type DesktopApi,
  type ExternalInboxDevice,
} from '@nesvo/contracts';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { Input } from '@/shared/ui/input';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  computer: Computer | undefined;
  api: Pick<
    DesktopApi,
    | 'listExternalInboxDevices'
    | 'enrollExternalInboxDevice'
    | 'revokeExternalInboxDevice'
  >;
};

const entry = '/absolute/path/to/nesvo/apps/host/dist/cli.js';

export function DevicesSettings({ computer, api }: Props) {
  const [devices, setDevices] = useState<ExternalInboxDevice[]>([]);
  const [name, setName] = useState('');
  const [enrollment, setEnrollment] = useState<{
    deviceId: string;
    token: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const available =
    computer?.status === 'connected' &&
    computer.capabilities.includes('external-inbox');
  const hostId = computer?.id;
  const instanceId = computer?.instanceId;
  const {
    listExternalInboxDevices,
    enrollExternalInboxDevice,
    revokeExternalInboxDevice,
  } = api;
  useEffect(() => {
    if (!available) return;
    let active = true;
    void listExternalInboxDevices(hostId).then(
      result => {
        if (active) setDevices(result);
      },
      () => {
        if (active) setError('Could not load Inbox devices.');
      },
    );
    return () => {
      active = false;
    };
  }, [available, hostId, listExternalInboxDevices]);

  async function enroll() {
    setBusy(true);
    setCopied(false);
    setError('');
    try {
      const { device, token } = await enrollExternalInboxDevice(
        { name },
        hostId,
      );
      setDevices(current => [...current, device]);
      setEnrollment({ deviceId: device.id, token });
      setName('');
    } catch {
      setError('Could not create the Inbox device.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(deviceId: string) {
    setBusy(true);
    setError('');
    try {
      setDevices(await revokeExternalInboxDevice({ deviceId }, hostId));
      if (enrollment?.deviceId === deviceId) setEnrollment(undefined);
    } catch {
      setError('Could not revoke the Inbox device.');
    } finally {
      setBusy(false);
    }
  }

  const environment = {
    NESVO_INBOX_COMPUTER: instanceId ?? 'local',
    ...(computer?.ssh ? { NESVO_INBOX_SSH: JSON.stringify(computer.ssh) } : {}),
  };
  const claude = JSON.stringify(
    {
      mcpServers: {
        nesvo: { command: 'node', args: [entry, 'mcp'], env: environment },
      },
    },
    null,
    2,
  );
  const codex = [
    '[mcp_servers.nesvo]',
    'command = "node"',
    `args = [${JSON.stringify(entry)}, "mcp"]`,
    'env_vars = ["NESVO_INBOX_TOKEN", "NESVO_INBOX_CONFIG"]',
    '',
    '[mcp_servers.nesvo.env]',
    ...Object.entries(environment).map(
      ([key, value]) => `${key} = ${JSON.stringify(value)}`,
    ),
  ].join('\n');
  return (
    <>
      <SettingsSection title="External Inbox devices">
        <SettingsRow
          title="Device token"
          description="Each token can post, read and withdraw its own Inbox items."
        >
          <form
            className="flex flex-wrap justify-end gap-1.5"
            onSubmit={event => {
              event.preventDefault();
              void enroll();
            }}
          >
            <Input
              aria-label="Device name"
              placeholder="Device name"
              value={name}
              onChange={event => setName(event.target.value)}
              maxLength={externalInboxLimits.source}
              disabled={!available || busy}
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={
                !available ||
                busy ||
                !name.trim() ||
                devices.length >= externalInboxLimits.devices
              }
            >
              Create token
            </Button>
          </form>
        </SettingsRow>
        {available && enrollment && (
          <SettingsRow
            title="Token created"
            description="Copy it now and store it as a secret. The host can only verify it after this."
          >
            <Button
              variant="secondary"
              onClick={() =>
                void navigator.clipboard.writeText(enrollment.token).then(
                  () => setCopied(true),
                  () => setError('Could not copy the token.'),
                )
              }
            >
              {copied ? 'Copied' : 'Copy token'}
            </Button>
            <Button variant="ghost" onClick={() => setEnrollment(undefined)}>
              Done
            </Button>
          </SettingsRow>
        )}
        {available &&
          devices.map(device => (
            <SettingsRow key={device.id} title={device.name}>
              <Button
                variant="outline"
                disabled={busy}
                aria-label={`Revoke ${device.name}`}
                onClick={() => void revoke(device.id)}
              >
                Revoke
              </Button>
            </SettingsRow>
          ))}
        {!available && (
          <div className="px-3 py-2">
            <StatusMessage>
              Connect a computer that supports the external Inbox to manage its
              devices.
            </StatusMessage>
          </div>
        )}
        {error && (
          <div className="px-3 py-2">
            <StatusMessage tone="error">{error}</StatusMessage>
          </div>
        )}
      </SettingsSection>
      <SettingsSection title="Install the Nesvo CLI">
        <div className="space-y-2 px-3 py-3">
          <p className="text-xs leading-5 text-muted-foreground">
            Run these commands from the Nesvo repository with Bun and Node
            installed.
          </p>
          <CodeBlock
            label="Repository setup"
            code={
              'bun install --frozen-lockfile\nbun run --cwd apps/host build\nnode apps/host/dist/cli.js --help'
            }
          />
          <p className="text-xs leading-5 text-muted-foreground">
            Supply the token through <code>NESVO_INBOX_TOKEN</code> or an
            owner-only file selected by <code>NESVO_INBOX_CONFIG</code>.
          </p>
        </div>
      </SettingsSection>
      <SettingsSection title="Connect an MCP client">
        <div className="space-y-2 px-3 py-3">
          <p className="text-xs leading-5 text-muted-foreground">
            Replace the example path with the built CLI’s absolute path and add
            the snippet to your client configuration.
          </p>
          <CodeBlock label="Claude Code · JSON" code={claude} />
          <CodeBlock label="Codex · TOML" code={codex} />
        </div>
      </SettingsSection>
    </>
  );
}
