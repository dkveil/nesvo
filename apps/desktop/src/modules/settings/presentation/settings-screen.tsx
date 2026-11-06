import { useState } from 'react';

import { useStore } from '@nanostores/react';

import { Button } from '../../../shared/components/button';
import { Panel } from '../../../shared/components/panel';
import { TextField } from '../../../shared/components/text-field';
import { $hostConfig } from '../../connection/core/connection-store';
import { RemoteHostForm } from '../../connection/presentation/remote-host-form';
import { parsePort } from '../core/validate-port';

export type SettingsScreenProps = {
  onSavePort: (port: number) => Promise<void>;
  onSaveHostBinary: (path: string | null) => Promise<void>;
  onStopLocalHost: () => Promise<void>;
  onPairRemote: (pairing: string) => Promise<void>;
  onUseLocal: () => Promise<void>;
  onForgetRemote: () => Promise<void>;
};

export const SettingsScreen = ({
  onSavePort,
  onSaveHostBinary,
  onStopLocalHost,
  onPairRemote,
  onUseLocal,
  onForgetRemote,
}: SettingsScreenProps) => {
  const config = useStore($hostConfig);
  const [portInput, setPortInput] = useState(String(config?.port ?? config?.defaultPort ?? ''));
  const [binaryInput, setBinaryInput] = useState(config?.hostBinary ?? '');
  const [error, setError] = useState<string | null>(null);
  const port = parsePort(portInput);
  const isRemote = config?.mode === 'remote';

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(String(failure));
    }
  };

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <Panel className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">Local host</h2>
        <p className="text-muted">
          {isRemote
            ? 'A remote host is in use. Switch back to start or reuse the local host.'
            : 'Started or reused automatically when the app opens.'}
        </p>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Port (default {config?.defaultPort})</span>
          <TextField
            inputMode="numeric"
            value={portInput}
            onChange={event => setPortInput(event.target.value)}
            aria-label="Host port"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Host binary (empty to auto-detect)</span>
          <TextField
            value={binaryInput}
            onChange={event => setBinaryInput(event.target.value)}
            placeholder="nesvo-host"
            aria-label="Host binary path"
          />
        </label>
        {error ? <p className="text-danger">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={port === null}
            onClick={() =>
              run(async () => {
                if (port === null) return;
                await onSavePort(port);
                await onSaveHostBinary(binaryInput.trim() || null);
              })
            }
          >
            Save and reconnect
          </Button>
          <Button variant="danger" onClick={() => run(onStopLocalHost)}>
            Stop local host
          </Button>
        </div>
      </Panel>
      <Panel className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">Remote host</h2>
        <p className="text-muted">
          {isRemote ? `Connected to ${config?.hostUrl}` : 'Pair with a host on another machine.'}
        </p>
        <RemoteHostForm onPair={onPairRemote} />
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={!isRemote} onClick={() => run(onUseLocal)}>
            Use local host
          </Button>
          <Button
            variant="danger"
            disabled={!config?.hasRemotePairing}
            onClick={() => run(onForgetRemote)}
          >
            Forget remote pairing
          </Button>
        </div>
      </Panel>
    </div>
  );
};
