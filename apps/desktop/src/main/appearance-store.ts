import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { colorSchemeSchema, type ColorScheme } from '@nesvo/contracts';

const APPEARANCE_FILE = 'appearance.json';

export const readColorScheme = (directory: string): ColorScheme => {
  try {
    const stored: unknown = JSON.parse(
      readFileSync(join(directory, APPEARANCE_FILE), 'utf8'),
    );
    const parsed = colorSchemeSchema.safeParse(
      stored && typeof stored === 'object' && 'colorScheme' in stored
        ? stored.colorScheme
        : null,
    );
    return parsed.success ? parsed.data : 'system';
  } catch {
    return 'system';
  }
};

export const saveColorScheme = (directory: string, scheme: ColorScheme) => {
  const target = join(directory, APPEARANCE_FILE);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, JSON.stringify({ colorScheme: scheme }));
  renameSync(temporary, target);
};
