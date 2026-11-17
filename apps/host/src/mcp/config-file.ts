import { readFile, stat } from 'node:fs/promises';

export type ConfigFile =
  | { status: 'missing' }
  | { status: 'too-large' }
  | { status: 'unreadable' }
  | { status: 'read'; text: string };

export const readConfigFile = async (
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<ConfigFile> => {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { status: 'unreadable' };
    if (info.size > maxBytes) return { status: 'too-large' };
    const text = await readFile(path, { encoding: 'utf8', signal });
    if (Buffer.byteLength(text) > maxBytes) return { status: 'too-large' };
    return { status: 'read', text };
  } catch (error) {
    if (signal?.aborted) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { status: 'missing' }
      : { status: 'unreadable' };
  }
};
