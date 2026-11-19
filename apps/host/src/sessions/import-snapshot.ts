import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class ImportSourceError extends Error {
  constructor(
    readonly status: 'retry' | 'unsupported' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

export const sourceChanged = () =>
  new ImportSourceError(
    'retry',
    'The source changed while it was being read. Refresh to try again.',
  );

export async function sourceFile(path: string) {
  try {
    const stat = await lstat(path, { bigint: true });
    if (!stat.isFile())
      throw new ImportSourceError(
        'unavailable',
        'The source is not a regular file.',
      );
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

type Stamp = Awaited<ReturnType<typeof sourceFile>>;
function sameFile(a: Stamp, b: Stamp) {
  if (!a || !b) return a === b;
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

async function readSource(
  path: string,
  stamp: NonNullable<Stamp>,
  signal: AbortSignal,
  output?: FileHandle,
) {
  const source = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!sameFile(stamp, await source.stat({ bigint: true })))
      throw sourceChanged();
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    const size = Number(stamp.size);
    for (let offset = 0; offset < size;) {
      signal.throwIfAborted();
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      );
      if (!bytesRead) throw sourceChanged();
      hash.update(buffer.subarray(0, bytesRead));
      if (output) {
        for (let written = 0; written < bytesRead;) {
          const { bytesWritten } = await output.write(
            buffer,
            written,
            bytesRead - written,
            offset + written,
          );
          if (!bytesWritten)
            throw new ImportSourceError(
              'unavailable',
              'Could not write a private source snapshot.',
            );
          written += bytesWritten;
        }
      }
      offset += bytesRead;
    }
    if (!sameFile(stamp, await source.stat({ bigint: true })))
      throw sourceChanged();
    return hash.digest('hex');
  } finally {
    await source.close();
  }
}

export async function withImportSnapshot<T>(
  path: string,
  dataDirectory: string,
  signal: AbortSignal,
  inspect: (db: DatabaseSync) => T,
): Promise<T> {
  const wal = path + '-wal';
  const dbStamp = await sourceFile(path);
  const walStamp = await sourceFile(wal);
  if (!dbStamp) throw sourceChanged();
  if (dbStamp.size + (walStamp?.size ?? 0n) > 8n * 1024n ** 3n)
    throw new ImportSourceError(
      'unavailable',
      'The source exceeds the private snapshot size limit.',
    );

  const directory = await mkdtemp(join(dataDirectory, '.import-'));
  const copy = join(directory, 'snapshot.sqlite');
  try {
    const entries = [
      { path, stamp: dbStamp, target: copy },
      { path: wal, stamp: walStamp, target: copy + '-wal' },
    ];
    const hashes = [];
    for (const entry of entries) {
      if (!entry.stamp) {
        hashes.push(null);
        continue;
      }
      const output = await open(entry.target, 'wx', 0o600);
      try {
        hashes.push(await readSource(entry.path, entry.stamp, signal, output));
      } finally {
        await output.close();
      }
    }
    for (const [index, entry] of entries.entries()) {
      if (
        entry.stamp &&
        (await readSource(entry.path, entry.stamp, signal)) !== hashes[index]
      )
        throw sourceChanged();
    }
    for (const entry of entries) {
      if (!sameFile(entry.stamp, await sourceFile(entry.path)))
        throw sourceChanged();
    }
    signal.throwIfAborted();
    const db = new DatabaseSync(copy, {
      readOnly: true,
      enableDoubleQuotedStringLiterals: false,
    });
    try {
      db.exec('PRAGMA trusted_schema = OFF');
      return inspect(db);
    } finally {
      db.close();
    }
  } catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw sourceChanged();
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}
