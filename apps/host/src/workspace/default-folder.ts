import type { DatabaseSync } from 'node:sqlite';
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
      this.database
        .prepare('DELETE FROM metadata WHERE key = ?')
        .run(DEFAULT_FOLDER_KEY);
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
    this.database
      .prepare(
        'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(DEFAULT_FOLDER_KEY, folder);
    return folder;
  }
}
