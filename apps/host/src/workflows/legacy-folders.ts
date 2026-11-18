import { hostDiagnostic } from '../log-redaction';
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
  } catch {
    hostDiagnostic(
      'Could not rename a legacy workflow folder. The folder stays in use.',
    );
    return previous;
  }
};
