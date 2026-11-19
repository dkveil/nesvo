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
type Comparison = 'exact' | 'identity' | 'wal-prefix';

function sameFile(a: Stamp, b: Stamp, comparison: Comparison = 'exact') {
  if (!a || !b) return a === b;
  if (a.dev !== b.dev || a.ino !== b.ino) return false;
  if (comparison === 'wal-prefix') return a.size <= b.size;
  if (a.size !== b.size) return false;
  return (
    comparison === 'identity' ||
    (a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs)
  );
}

const readFlags =
  constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);

async function readWalHeader(path: string, stamp: Stamp) {
  if (!stamp?.size) return null;
  const file = await open(path, readFlags);
  try {
    if (!sameFile(stamp, await file.stat({ bigint: true }), 'wal-prefix'))
      throw sourceChanged();
    const bytes = Buffer.alloc(32);
    if ((await file.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length)
      throw sourceChanged();
    return bytes;
  } finally {
    await file.close();
  }
}

async function readSource(
  path: string,
  stamp: NonNullable<Stamp>,
  signal: AbortSignal,
  comparison: Comparison,
  output?: FileHandle,
) {
  const source = await open(path, readFlags);
  try {
    if (!sameFile(stamp, await source.stat({ bigint: true }), comparison))
      throw sourceChanged();
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(Number(stamp.size), 4 * 1024 * 1024));
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
    if (!sameFile(stamp, await source.stat({ bigint: true }), comparison))
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
  const initialWal = await sourceFile(wal);
  if (!dbStamp) throw sourceChanged();
  const journal = path + '-journal';
  if ((await sourceFile(journal))?.size) throw sourceChanged();
  const snapshotLimit = 8n * 1024n ** 3n;
  const checkSize = (wal: Stamp) => {
    if (dbStamp.size + (wal?.size ?? 0n) <= snapshotLimit) return;
    throw new ImportSourceError(
      'unavailable',
      'The source exceeds the private snapshot size limit.',
    );
  };
  checkSize(initialWal);

  const directory = await mkdtemp(join(dataDirectory, '.import-'));
  const copy = join(directory, 'snapshot.sqlite');
  try {
    const initialHeader = await readWalHeader(wal, initialWal);
    const copyFile = async (
      source: string,
      stamp: NonNullable<Stamp>,
      target: string,
      comparison: Comparison,
    ) => {
      const output = await open(target, 'wx', 0o600);
      try {
        return await readSource(source, stamp, signal, comparison, output);
      } finally {
        await output.close();
      }
    };
    const dbHash = await copyFile(path, dbStamp, copy, 'identity');
    const walStamp = await sourceFile(wal);
    const walHeader = await readWalHeader(wal, walStamp);
    if (
      !sameFile(initialWal, walStamp, 'wal-prefix') ||
      (initialHeader ? !walHeader?.equals(initialHeader) : walHeader !== null)
    )
      throw sourceChanged();
    checkSize(walStamp);
    const walHash = walStamp?.size
      ? await copyFile(wal, walStamp, copy + '-wal', 'wal-prefix')
      : null;
    const verifyStamp = await sourceFile(path);
    if (!verifyStamp || !sameFile(dbStamp, verifyStamp, 'identity'))
      throw sourceChanged();
    if ((await readSource(path, verifyStamp, signal, 'exact')) !== dbHash)
      throw sourceChanged();
    if (walStamp?.size) {
      if ((await readSource(wal, walStamp, signal, 'wal-prefix')) !== walHash)
        throw sourceChanged();
    } else if (!sameFile(walStamp, await sourceFile(wal))) {
      throw sourceChanged();
    }
    if (!sameFile(verifyStamp, await sourceFile(path))) throw sourceChanged();
    const finalWal = await sourceFile(wal);
    if (!sameFile(walStamp, finalWal, 'wal-prefix')) throw sourceChanged();
    if (walHeader && !(await readWalHeader(wal, finalWal))?.equals(walHeader))
      throw sourceChanged();
    if ((await sourceFile(journal))?.size) throw sourceChanged();
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
