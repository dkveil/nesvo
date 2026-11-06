import { useState } from 'react';

import { useStore } from '@nanostores/react';

import { Button } from '../../../shared/components/button';
import { Panel } from '../../../shared/components/panel';
import { TextField } from '../../../shared/components/text-field';
import { $hostConfig } from '../../connection/core/connection-store';
import { parsePort } from '../core/validate-port';

export type SettingsScreenProps = {
  onSavePort: (port: number) => Promise<void>;
  onForgetPairing: () => Promise<void>;
};

export const SettingsScreen = ({ onSavePort, onForgetPairing }: SettingsScreenProps) => {
  const config = useStore($hostConfig);
  const [input, setInput] = useState(String(config?.port ?? config?.defaultPort ?? ''));
  const [error, setError] = useState<string | null>(null);
  const port = parsePort(input);

  const handleSave = async () => {
    if (port === null) return setError('Enter a port between 1 and 65535.');
    setError(null);
    try {
      await onSavePort(port);
    } catch (failure) {
      setError(String(failure));
    }
  };

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4">
      <Panel className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">Host</h2>
        <p className="text-muted">{config?.hostUrl ?? 'No host paired'}</p>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Port (default {config?.defaultPort})</span>
          <TextField
            inputMode="numeric"
            value={input}
            onChange={event => setInput(event.target.value)}
            aria-label="Host port"
          />
        </label>
        {error ? <p className="text-danger">{error}</p> : null}
        <Button disabled={port === null || port === config?.port} onClick={handleSave}>
          Save and reconnect
        </Button>
      </Panel>
      <Panel className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">Pairing</h2>
        <Button variant="danger" disabled={!config?.hasPairing} onClick={onForgetPairing}>
          Forget pairing
        </Button>
      </Panel>
    </div>
  );
};
