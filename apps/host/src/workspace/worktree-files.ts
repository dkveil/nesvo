import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';

const maxIncludeFiles = 64;
const maxIncludeBytes = 8 * 1024 * 1024;

function safeParts(path: string): string[] {
  const parts = path.split('/');
  if (
    parts.some(
      part =>
        !part ||
        /^(?:\.|\.\.|\.git)$/i.test(part) ||
        /[\\:\0]/.test(part) ||
        (process.platform === 'win32' &&
          (/[. ]$/.test(part) ||
            /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(
              part,
            ))),
    )
  )
    throw new Error('Unsafe worktree path.');
  return parts;
}

function parentDirectory(root: string, parts: string[], create: boolean) {
  if (realpathSync.native(root) !== root)
    throw new Error('Worktree root changed.');
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part);
    if (create && !lstatSync(directory, { throwIfNoEntry: false }))
      mkdirSync(directory, { mode: 0o700 });
    if (
      !lstatSync(directory).isDirectory() ||
      realpathSync.native(directory) !== directory
    )
      throw new Error('Unsafe worktree directory.');
  }
  return directory;
}

export function readWorktreeFile(root: string, path: string, limit: number) {
  return readRegularFile(root, safeParts(path), limit);
}

export function readGitPointer(root: string) {
  return readRegularFile(root, ['.git'], 4096).toString('utf8').trimEnd();
}

function readRegularFile(root: string, parts: string[], limit: number) {
  const file = join(parentDirectory(root, parts, false), parts.at(-1)!);
  const entry = lstatSync(file);
  if (
    !entry.isFile() ||
    entry.size > limit ||
    realpathSync.native(file) !== file
  )
    throw new Error('Worktree file is unavailable or exceeds the size limit.');
  const descriptor = openSync(
    file,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino ||
      realpathSync.native(file) !== file
    )
      throw new Error('Worktree file changed.');
    const contents = Buffer.allocUnsafe(entry.size + 1);
    let bytes = 0;
    while (bytes < contents.length) {
      const read = readSync(
        descriptor,
        contents,
        bytes,
        contents.length - bytes,
        null,
      );
      if (!read) break;
      bytes += read;
    }
    if (bytes !== entry.size || fstatSync(descriptor).mtimeMs !== entry.mtimeMs)
      throw new Error('Worktree file changed.');
    return contents.subarray(0, bytes);
  } finally {
    closeSync(descriptor);
  }
}

export function copyWorktreeIncludes(
  source: string,
  target: string,
  paths: string[],
  limits = { maxFiles: maxIncludeFiles, maxBytes: maxIncludeBytes },
) {
  let copied = 0;
  let bytes = 0;
  for (const path of paths) {
    if (copied >= limits.maxFiles) break;
    try {
      const parts = safeParts(path);
      const contents = readWorktreeFile(source, path, limits.maxBytes - bytes);
      bytes += contents.length;
      const parent = parentDirectory(target, parts, true);
      const destination = `${parent}${sep}${parts.at(-1)!}`;
      const fd = openSync(destination, 'wx', 0o600);
      try {
        try {
          writeFileSync(fd, contents);
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        unlinkSync(destination);
        throw error;
      }
      copied++;
    } catch {
      continue;
    }
  }
  return { copied, skipped: paths.length - copied, bytes };
}
