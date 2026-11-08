import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Socket } from 'node:net';

export const requestFrameLimit = 1024 * 1024;
export const responseFrameLimit = 64 * 1024 * 1024;

export async function privateDirectory(directory: string, create = false) {
  if (process.platform !== 'linux')
    throw new Error('Independent hosts currently require Linux.');
  const path = resolve(directory);
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  )
    throw new Error(
      'NESVO_RUNTIME_DIR must be an owned private directory (0700) without symlinks.',
    );
  return path;
}

export async function privateSocketPath(directory: string, create = false) {
  const socket = join(await privateDirectory(directory, create), 'host.sock');
  if (Buffer.byteLength(socket) > 100)
    throw new Error('NESVO_RUNTIME_DIR is too long for a private socket.');
  return socket;
}

export function readFrames(
  socket: NodeJS.ReadableStream,
  limit: number,
  receive: (value: unknown) => void,
  invalid: () => void,
) {
  let pending = Buffer.alloc(Math.min(limit, 4096));
  let size = 0;
  let failed = false;
  const data = (chunk: Buffer | string) => {
    if (failed) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline === -1 ? bytes.length : newline;
      if (size + end - offset > limit) {
        failed = true;
        invalid();
        return;
      }
      const required = size + end - offset;
      if (required > pending.length) {
        const larger = Buffer.allocUnsafe(
          Math.min(limit, Math.max(required, pending.length * 2)),
        );
        pending.copy(larger, 0, 0, size);
        pending = larger;
      }
      bytes.copy(pending, size, offset, end);
      size += end - offset;
      if (newline === -1) break;
      const line = pending.subarray(0, size);
      size = 0;
      offset = newline + 1;
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(line),
        );
      } catch {
        failed = true;
        invalid();
        return;
      }
      receive(value);
    }
  };
  const end = () => {
    if (!failed && size > 0) {
      failed = true;
      invalid();
    }
  };
  socket.on('data', data);
  socket.on('end', end);
  return () => {
    socket.off('data', data);
    socket.off('end', end);
  };
}

export function sendFrame(socket: Socket, value: unknown) {
  if (socket.destroyed || !socket.writable) return;
  const line = JSON.stringify(value) + '\n';
  if (socket.writableLength + Buffer.byteLength(line) > responseFrameLimit) {
    socket.destroy();
    return;
  }
  socket.write(line);
}
