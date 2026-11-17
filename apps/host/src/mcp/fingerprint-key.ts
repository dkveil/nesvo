import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY_BYTES = 32;

export const readFingerprintKey = (dataDirectory: string): Buffer => {
  const path = join(dataDirectory, 'mcp-fingerprint.key');
  try {
    const key = readFileSync(path);
    if (key.length === KEY_BYTES) return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(path, key, { mode: 0o600 });
  return key;
};
