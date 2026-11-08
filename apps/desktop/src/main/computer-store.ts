import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  reviewSchema,
  sessionSchema,
  sshComputerInputSchema,
} from '@nesvo/contracts';

const savedComputerSchema = z.strictObject({
  id: z.uuid(),
  input: sshComputerInputSchema,
  instanceId: z.uuid().nullable(),
});
export const computerConfigurationSchema = z
  .strictObject({
    version: z.literal(1),
    computers: z.array(savedComputerSchema).max(8),
  })
  .refine(
    value =>
      new Set(value.computers.map(computer => computer.id)).size ===
      value.computers.length,
  );
export type SavedComputer = z.infer<typeof savedComputerSchema>;
const cachedComputerSchema = z.strictObject({
  id: z.uuid(),
  instanceId: z.uuid(),
  lastSyncedAt: z.iso.datetime(),
  sessions: z.array(sessionSchema),
  reviews: z.array(reviewSchema),
});
export const computerCacheSchema = z.strictObject({
  version: z.literal(1),
  computers: z.array(cachedComputerSchema).max(8),
});
export type CachedComputer = z.infer<typeof cachedComputerSchema>;

export class ComputerStore {
  private writing = Promise.resolve();
  constructor(private readonly directory: string) {}

  async read(name: 'computers.json' | 'computer-cache.json', limit: number) {
    const path = join(this.directory, name);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > limit)
        throw new Error('Saved computer data exceeded its limit.');
      const contents = await readFile(path);
      if (contents.length > limit)
        throw new Error('Saved computer data exceeded its limit.');
      return JSON.parse(contents.toString('utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  write(
    name: 'computers.json' | 'computer-cache.json',
    value: unknown,
    limit: number,
  ) {
    const contents = JSON.stringify(value);
    if (Buffer.byteLength(contents) > limit)
      return Promise.reject(
        new Error(
          'Offline history exceeds its storage limit. Older saved history remains available.',
        ),
      );
    const pending = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.directory, { recursive: true });
        const destination = join(this.directory, name);
        const temporary = destination + '.' + randomUUID() + '.tmp';
        try {
          await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
          await rename(temporary, destination);
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
      });
    this.writing = pending;
    return pending;
  }
}
