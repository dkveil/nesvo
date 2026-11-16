import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const adoptLegacyFolder = (
  dataDirectory: string,
  current: string,
  legacy: string,
): string => {
  const target = join(dataDirectory, current);
  const previous = join(dataDirectory, legacy);
  if (existsSync(target) || !existsSync(previous)) return target;
  try {
    renameSync(previous, target);
    return target;
  } catch (error) {
    console.warn(
      `Could not rename ${previous} to ${target}; the legacy folder stays in use. ${String(error)}`,
    );
    return previous;
  }
};
