import type { DatabaseSync } from 'node:sqlite';
import { opendirSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  metadataRevision,
  saveVersionedMetadata,
} from '../workflows/assistant-change-store';
import {
  ConfigurationRefusal,
  revisionedSlot,
} from '../workflows/configuration-changes';
import { SessionError } from '../sessions/session-error';
import { FolderError, resolveFolder } from './folder';

const DEFAULT_FOLDER_KEY = 'default_session_folder';

export class DefaultSessionFolder {
  constructor(private readonly database: DatabaseSync) {}

  get(): string | null {
    const row = this.database
      .prepare('SELECT value FROM metadata WHERE key = ?')
      .get(DEFAULT_FOLDER_KEY);
    return typeof row?.value === 'string' && row.value ? row.value : null;
  }

  async set(
    directory: string | null,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (!directory) {
      saveVersionedMetadata(this.database, DEFAULT_FOLDER_KEY, '');
      return null;
    }
    let folder: string;
    try {
      folder = await resolveFolder(directory, signal, { readable: true });
    } catch (error) {
      if (error instanceof FolderError)
        throw new SessionError(
          error.code === 'invalid-directory'
            ? 'invalid-directory'
            : 'unavailable',
          error.code === 'invalid-directory'
            ? 'The folder does not exist or cannot be read on this computer. Enter its absolute path.'
            : error.message,
        );
      throw error;
    }
    saveVersionedMetadata(this.database, DEFAULT_FOLDER_KEY, folder);
    return folder;
  }

  configuration() {
    return revisionedSlot(
      DEFAULT_FOLDER_KEY,
      () => ({
        value: { kind: 'folder', value: this.get() },
        revision: metadataRevision(this.database, DEFAULT_FOLDER_KEY),
      }),
      value => {
        if (value.kind !== 'folder')
          throw new ConfigurationRefusal(
            'invalid-request',
            'Choose a default session folder.',
          );
        saveVersionedMetadata(
          this.database,
          DEFAULT_FOLDER_KEY,
          value.value ?? '',
        );
      },
      () => 'review',
      value => {
        if (value.kind !== 'folder' || value.value === null) return value;
        try {
          if (!isAbsolute(value.value))
            throw new Error('A folder must be absolute.');
          const directory = realpathSync(value.value);
          opendirSync(directory).closeSync();
          return { ...value, value: directory };
        } catch {
          throw new ConfigurationRefusal(
            'invalid-request',
            'Choose a readable absolute folder on this computer.',
          );
        }
      },
    );
  }
}
