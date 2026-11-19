import {
  configurationProfileSchema,
  type ConfigurationProfile,
  type ConfigurationTarget,
  type ConfigurationValue,
} from '@nesvo/contracts';
import type { DatabaseSync } from 'node:sqlite';
import {
  metadataRevision,
  saveVersionedMetadata,
} from './workflows/assistant-change-store';
import {
  ConfigurationRefusal,
  revisionedSlot,
} from './workflows/configuration-changes';

const fields = {
  'color-scheme': 'colorScheme',
  'keep-running': 'keepRunning',
  notifications: 'notifications',
  'new-session': 'newSession',
} as const;
type Key = keyof typeof fields;
const metadataKey = (field: keyof ConfigurationProfile) =>
  `desktop-configuration:${field}`;

export class DesktopConfigurationProfile {
  constructor(private readonly database: DatabaseSync) {}

  read(): ConfigurationProfile {
    const read = this.database.prepare(
      'SELECT value FROM metadata WHERE key = ?',
    );
    return configurationProfileSchema.parse(
      Object.fromEntries(
        Object.values(fields).flatMap(field => {
          const value = read.get(metadataKey(field))?.value;
          return typeof value === 'string' ? [[field, JSON.parse(value)]] : [];
        }),
      ),
    );
  }

  update(action: 'read' | 'seed' | 'save', profile: ConfigurationProfile) {
    for (const field of Object.values(fields)) {
      const value = profile[field];
      if (value === undefined || action === 'read') continue;
      const key = metadataKey(field);
      if (action === 'seed') {
        this.database
          .prepare('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)')
          .run(key, JSON.stringify(value));
      } else {
        saveVersionedMetadata(this.database, key, JSON.stringify(value));
      }
    }
    return this.read();
  }

  slot(target: ConfigurationTarget) {
    if (!('key' in target) || !Object.hasOwn(fields, target.key))
      throw new ConfigurationRefusal(
        'unsupported',
        'This setting is unavailable on the desktop profile.',
      );
    const key = target.key as Key;
    const field = fields[key];
    const setting = metadataKey(field);
    const read = (): ConfigurationValue => {
      const profile = this.read();
      if (key === 'color-scheme' && profile.colorScheme !== undefined)
        return { kind: 'color-scheme', value: profile.colorScheme };
      if (key === 'new-session' && profile.newSession !== undefined)
        return { kind: 'new-session', value: profile.newSession };
      if (key === 'keep-running' && profile.keepRunning !== undefined)
        return { kind: 'enabled', value: profile.keepRunning };
      if (key === 'notifications' && profile.notifications !== undefined)
        return { kind: 'enabled', value: profile.notifications };
      throw new ConfigurationRefusal(
        'unavailable',
        'Open the Local desktop to import this preference.',
      );
    };
    return revisionedSlot(
      setting,
      () => ({
        value: read(),
        revision: metadataRevision(this.database, setting),
      }),
      value => {
        if (
          value.kind === 'markdown' ||
          value.kind === 'route' ||
          value.kind === 'folder'
        )
          throw new ConfigurationRefusal(
            'invalid-request',
            'The value does not match the desktop preference.',
          );
        this.update(
          'save',
          configurationProfileSchema.parse({ [field]: value.value }),
        );
      },
      (before, after) => {
        if (key === 'color-scheme' || key === 'notifications') return 'direct';
        if (key === 'keep-running' && after.kind === 'enabled' && after.value)
          return 'authority';
        if (
          after.kind === 'new-session' &&
          after.value.mode &&
          after.value.mode !== 'read-only' &&
          (before?.kind !== 'new-session' ||
            before.value.mode !== after.value.mode)
        )
          return 'authority';
        return 'review';
      },
      value => {
        if (
          value.kind === 'new-session' &&
          value.value.mode &&
          value.value.provider
        ) {
          const compatible =
            value.value.provider === 'Codex'
              ? ['read-only', 'supervised']
              : ['read-only', 'accept-edits', 'auto'];
          if (!compatible.includes(value.value.mode))
            throw new ConfigurationRefusal(
              'invalid-request',
              'Choose a permission mode supported by the selected provider.',
            );
        }
        return value;
      },
    );
  }
}
