import { MiddleTruncatedText } from '@/shared/ui/middle-truncated-text';
import { useEffect, useState } from 'react';
import {
  externalInboxLimits,
  type Computer,
  type DesktopApi,
  type ExternalInboxDevice,
  type InboxCliInstallation,
} from '@nesvo/contracts';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  computer: Computer | undefined;
  api: Pick<
    DesktopApi,
    | 'listExternalInboxDevices'
    | 'readInboxCliInstallation'
    | 'enrollExternalInboxDevice'
    | 'revokeExternalInboxDevice'
  >;
};

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
  const [cli, setCli] = useState<InboxCliInstallation | null>();
  const available =
    computer?.status === 'connected' &&
    computer.capabilities.includes('external-inbox');
  const hostId = computer?.id;
  const instanceId = computer?.instanceId;
  const {
    listExternalInboxDevices,
    readInboxCliInstallation,
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
  useEffect(() => {
    let active = true;
    void readInboxCliInstallation().then(
      result => {
        if (active) setCli(result);
      },
      () => {
        if (active) setCli(null);
      },
    );
    return () => {
      active = false;
    };
  }, [readInboxCliInstallation]);

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
    ELECTRON_RUN_AS_NODE: '1',
    NESVO_INBOX_COMPUTER: instanceId ?? 'local',
    ...(computer?.ssh ? { NESVO_INBOX_SSH: JSON.stringify(computer.ssh) } : {}),
  };
  const claude = JSON.stringify(
    {
      mcpServers: {
        nesvo: {
          command: cli?.runtimePath,
          args: [cli?.entryPath, 'mcp'],
          env: environment,
        },
      },
    },
    null,
    2,
  );
  const codex = [
    '[mcp_servers.nesvo]',
    `command = ${JSON.stringify(cli?.runtimePath)}`,
    `args = [${JSON.stringify(cli?.entryPath)}, "mcp"]`,
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
        <form
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
          onSubmit={event => {
            event.preventDefault();
            void enroll();
          }}
        >
          <Field
            id="inbox-device-name"
            label="Device name"
            layout="inline"
            className="min-w-44 flex-1"
          >
            <Input
              id="inbox-device-name"
              placeholder="e.g. Release runner"
              value={name}
              onChange={event => setName(event.target.value)}
              maxLength={externalInboxLimits.source}
              disabled={!available || busy}
            />
          </Field>
          <Button
            type="submit"
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
        {available && enrollment && (
          <SettingsRow
            title={<StatusMessage tone="success">Token created</StatusMessage>}
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
                variant="ghost"
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
        {cli ? (
          <div className="space-y-2 px-3 py-2">
            <Field
              id="bundled-inbox-cli"
              label="Bundled CLI"
              as="span"
              layout="inline"
            >
              <MiddleTruncatedText
                path
                className="py-1.5 font-mono text-xs"
                value={cli.entryPath}
              />
            </Field>
            <CodeBlock
              variant="flat"
              label="Add to PATH"
              maxHeightClassName={null}
              code={cli.addToPathCommand}
            />
            <p className="text-2xs leading-4 text-muted-foreground">
              Run this in your terminal to use <code>nesvo</code> in that shell.
            </p>
          </div>
        ) : (
          <div className="px-3 py-2">
            <StatusMessage tone={cli === null ? 'error' : 'loading'}>
              {cli === null
                ? 'The bundled CLI is unavailable.'
                : 'Finding the bundled CLI…'}
            </StatusMessage>
          </div>
        )}
      </SettingsSection>
      {cli && (
        <SettingsSection title="Connect an MCP client">
          <div className="space-y-2 px-3 py-2">
            <p className="text-2xs leading-4 text-muted-foreground">
              Add the snippet to your client configuration. Supply the token
              through <code>NESVO_INBOX_TOKEN</code> or an owner-only file
              selected by <code>NESVO_INBOX_CONFIG</code>.
            </p>
            <CodeBlock
              variant="flat"
              label="Claude Code · JSON"
              maxHeightClassName={null}
              code={claude}
            />
            <CodeBlock
              variant="flat"
              label="Codex · TOML"
              maxHeightClassName={null}
              code={codex}
            />
          </div>
        </SettingsSection>
      )}
    </>
  );
}
