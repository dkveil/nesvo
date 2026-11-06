import { type ChangeEvent, useState } from 'react';

import { Button } from '../../../shared/components/button';
import { Panel } from '../../../shared/components/panel';
import { TextArea } from '../../../shared/components/text-area';

export type PairScreenProps = {
  onPair: (pairing: string) => Promise<void>;
};

const MAX_PAIRING_FILE_BYTES = 16 * 1024;

export const PairScreen = ({ onPair }: PairScreenProps) => {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_PAIRING_FILE_BYTES) return setError('Pairing file is too large.');
    setText(await file.text());
    setError(null);
  };

  const handleSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onPair(text);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel className="mx-auto mt-16 flex max-w-xl flex-col gap-3">
      <h1 className="text-lg font-semibold">Pair with a host</h1>
      <p className="text-muted">
        Paste the contents of the host&apos;s <code>pairing.json</code> or load the file.
      </p>
      <TextArea
        rows={6}
        value={text}
        onChange={event => setText(event.target.value)}
        placeholder='{"version":1,"url":"ws://127.0.0.1:8791","key":"..."}'
        aria-label="Pairing JSON"
      />
      <input
        type="file"
        accept=".json,application/json"
        onChange={handleFile}
        aria-label="Pairing file"
        className="text-xs text-muted"
      />
      {error ? <p className="text-danger">{error}</p> : null}
      <Button disabled={busy || text.trim() === ''} onClick={handleSubmit}>
        Pair and connect
      </Button>
    </Panel>
  );
};
