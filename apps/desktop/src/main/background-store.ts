import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BACKGROUND_FILE = 'background.json';

export const readKeepRunningInBackground = (directory: string): boolean => {
  try {
    const stored: unknown = JSON.parse(
      readFileSync(join(directory, BACKGROUND_FILE), 'utf8'),
    );
    return (
      !!stored &&
      typeof stored === 'object' &&
      'keepRunning' in stored &&
      stored.keepRunning === true
    );
  } catch {
    return false;
  }
};

export const saveKeepRunningInBackground = (
  directory: string,
  keepRunning: boolean,
) => {
  const target = join(directory, BACKGROUND_FILE);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, JSON.stringify({ keepRunning }));
  renameSync(temporary, target);
};
