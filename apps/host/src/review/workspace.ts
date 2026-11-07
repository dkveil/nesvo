import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BigIntStats } from 'node:fs';
import type { ReviewDiff } from '@nesvo/contracts';

type WorkspaceFile = {
  type: 'file' | 'directory';
  hash: string;
  mode: string;
  text: string | null;
};

export type WorkspaceSnapshot = {
  status: 'complete' | 'unavailable';
  detail: string | null;
  fingerprint: string | null;
  root: string | null;
  files: Map<string, WorkspaceFile>;
};

const limits = {
  files: 500,
  directories: 1000,
  entries: 2000,
  depth: 64,
  bytes: 8 * 1024 * 1024,
  fileBytes: 512 * 1024,
  milliseconds: 5000,
  patchCharacters: 200_000,
  patchLines: 5000,
};

const excluded = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.next',
  '.cache',
  '.nesvo',
]);

const exclusions = `Pomijane katalogi na każdym poziomie: ${[...excluded].join(', ')}.`;

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function signature(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}

function textContent(bytes: Buffer): string | null {
  for (const byte of bytes)
    if ((byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127)
      return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function failure(
  detail: string,
  root: string | null = null,
): WorkspaceSnapshot {
  return {
    status: 'unavailable',
    detail: `${detail} ${exclusions}`,
    fingerprint: null,
    root,
    files: new Map(),
  };
}

export async function captureWorkspace(
  directory: string,
  signal?: AbortSignal,
): Promise<WorkspaceSnapshot> {
  const controller = new AbortController();
  let reason = 'Anulowano odczyt katalogu roboczego.';
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => {
    reason = `Odczyt katalogu roboczego przekroczył ${limits.milliseconds / 1000} sekund.`;
    controller.abort();
  }, limits.milliseconds);
  const check = () => {
    if (controller.signal.aborted) throw new Error(reason);
  };
  let root: string | null = null;
  let rejectAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new Error(reason));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  const scan = async (): Promise<WorkspaceSnapshot> => {
    check();
    if (!isAbsolute(directory))
      throw new Error('Katalog roboczy wymaga pełnej ścieżki.');
    root = await realpath(directory);
    check();
    const files = new Map<string, WorkspaceFile>();
    const observed = new Map<string, string>();
    let bytes = 0;
    let fileCount = 0;
    let directories = 0;
    let entries = 0;
    const inspect = async (path: string): Promise<BigIntStats> => {
      check();
      const stat = await lstat(path, { bigint: true });
      check();
      if (stat.isSymbolicLink())
        throw new Error(
          'Katalog zawiera dowiązanie symboliczne. Odczyt dowiązań jest wyłączony.',
        );
      if (!stat.isDirectory() && !stat.isFile())
        throw new Error('Katalog zawiera nieobsługiwany plik specjalny.');
      const canonical = await realpath(path);
      check();
      const expected = resolve(path);
      if (
        (process.platform === 'win32' ? canonical.toLowerCase() : canonical) !==
        (process.platform === 'win32' ? expected.toLowerCase() : expected)
      )
        throw new Error(
          'Ścieżka zmieniła się podczas odczytu lub prowadzi przez dowiązanie symboliczne.',
        );
      const inside = relative(root!, canonical);
      if (
        isAbsolute(inside) ||
        inside === '..' ||
        inside.startsWith(`..${sep}`)
      )
        throw new Error('Ścieżka wychodzi poza katalog roboczy.');
      observed.set(path, signature(stat));
      return stat;
    };
    const visit = async (
      path: string,
      name: string,
      depth: number,
    ): Promise<void> => {
      if (depth > limits.depth)
        throw new Error(
          `Katalog przekracza limit ${limits.depth} poziomów zagnieżdżenia.`,
        );
      const stat = await inspect(path);
      if (!name && !stat.isDirectory())
        throw new Error('Ścieżka robocza nie wskazuje katalogu.');
      const mode = (stat.mode & 0o7777n).toString(8);
      if (stat.isDirectory()) {
        if (++directories > limits.directories)
          throw new Error(
            `Katalog przekracza limit ${limits.directories} podkatalogów.`,
          );
        files.set(name, {
          type: 'directory',
          hash: digest('directory'),
          mode,
          text: null,
        });
        const handle = await opendir(path, { bufferSize: 32 });
        try {
          check();
          while (true) {
            const entry = await handle.read();
            check();
            if (!entry) break;
            if (++entries > limits.entries)
              throw new Error(
                `Katalog przekracza limit ${limits.entries} wpisów.`,
              );
            if (entry.isDirectory() && excluded.has(entry.name)) continue;
            await visit(
              join(path, entry.name),
              name ? `${name}/${entry.name}` : entry.name,
              depth + 1,
            );
          }
        } finally {
          await handle.close();
        }
        return;
      }
      if (++fileCount > limits.files)
        throw new Error(`Katalog przekracza limit ${limits.files} plików.`);
      if (stat.size > BigInt(limits.fileBytes))
        throw new Error(
          `Katalog zawiera plik większy niż ${limits.fileBytes / 1024} KiB.`,
        );
      if (bytes + Number(stat.size) > limits.bytes)
        throw new Error(
          `Łączny rozmiar plików przekracza ${limits.bytes / 1024 / 1024} MiB.`,
        );
      const handle = await open(
        path,
        constants.O_RDONLY |
          (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
      );
      let content: Buffer;
      try {
        check();
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || signature(before) !== signature(stat))
          throw new Error('Plik zmienił się podczas otwierania.');
        const buffer = Buffer.alloc(Number(stat.size) + 1);
        let offset = 0;
        while (offset < buffer.length) {
          check();
          const read = await handle.read(
            buffer,
            offset,
            buffer.length - offset,
            null,
          );
          check();
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        check();
        if (
          offset !== Number(stat.size) ||
          signature(before) !== signature(after)
        )
          throw new Error('Plik zmienił się podczas odczytu.');
        content = buffer.subarray(0, offset);
      } finally {
        await handle.close();
      }
      bytes += content.length;
      files.set(name, {
        type: 'file',
        hash: digest(content),
        mode,
        text: textContent(content),
      });
    };
    await visit(root, '', 0);
    for (const [path, expected] of observed) {
      check();
      if (signature(await inspect(path)) !== expected)
        throw new Error('Zawartość katalogu zmieniła się podczas odczytu.');
    }
    check();
    const sorted = new Map(
      [...files].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
    const fingerprint = digest(
      JSON.stringify(
        [...sorted].map(([path, file]) => [
          path,
          file.type,
          file.mode,
          file.hash,
        ]),
      ),
    );
    return {
      status: 'complete',
      detail: exclusions,
      fingerprint,
      root,
      files: sorted,
    };
  };
  try {
    return await Promise.race([scan(), aborted]);
  } catch (error) {
    return failure(
      controller.signal.aborted
        ? reason
        : error instanceof Error
          ? 'code' in error
            ? `Nie można odczytać katalogu lub pliku (${String(error.code)}).`
            : error.message
          : 'Nie udało się odczytać katalogu roboczego.',
      root,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function label(prefix: string, path: string): string {
  const value = `${prefix}/${path}`;
  return /[\s"\\\x00-\x1f\x7f]/.test(value) ? JSON.stringify(value) : value;
}

function unified(
  path: string,
  before: WorkspaceFile | undefined,
  after: WorkspaceFile | undefined,
): string {
  const previous = before?.type === 'file' ? before.text! : '';
  const next = after?.type === 'file' ? after.text! : '';
  const oldLines = lines(previous);
  const newLines = lines(next);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] ===
      newLines[newLines.length - suffix - 1]
  )
    suffix++;
  const contextStart = Math.max(0, prefix - 3);
  const contextEnd = Math.min(3, suffix);
  const oldEnd = oldLines.length - suffix;
  const newEnd = newLines.length - suffix;
  const oldCount = oldEnd - contextStart + contextEnd;
  const newCount = newEnd - contextStart + contextEnd;
  const format = (marker: string, value: string) =>
    `${marker}${value.endsWith('\n') ? value : `${value}\n\\ No newline at end of file\n`}`;
  let patch = `diff --git ${label('a', path)} ${label('b', path)}\n`;
  if (before?.mode !== after?.mode || before?.type !== after?.type)
    patch += `old type/mode ${before ? `${before.type} ${before.mode}` : 'absent'}\nnew type/mode ${after ? `${after.type} ${after.mode}` : 'absent'}\n`;
  if (previous === next && before && after) return patch;
  patch += `--- ${before ? label('a', path) : '/dev/null'}\n+++ ${after ? label('b', path) : '/dev/null'}\n@@ -${oldCount ? contextStart + 1 : contextStart},${oldCount} +${newCount ? contextStart + 1 : contextStart},${newCount} @@\n`;
  patch += oldLines
    .slice(contextStart, prefix)
    .map(value => format(' ', value))
    .join('');
  patch += oldLines
    .slice(prefix, oldEnd)
    .map(value => format('-', value))
    .join('');
  patch += newLines
    .slice(prefix, newEnd)
    .map(value => format('+', value))
    .join('');
  patch += oldLines
    .slice(oldEnd, oldEnd + contextEnd)
    .map(value => format(' ', value))
    .join('');
  return patch;
}

export function compareWorkspace(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): ReviewDiff {
  const unavailable = (
    detail: string,
    patch = '',
    files: ReviewDiff['files'] = [],
  ): ReviewDiff => ({
    status: 'unavailable',
    detail,
    patch,
    files,
    fingerprint: null,
  });
  if (before.status !== 'complete' || after.status !== 'complete')
    return unavailable(
      before.status !== 'complete'
        ? (before.detail ?? 'Początkowa migawka katalogu jest niedostępna.')
        : (after.detail ?? 'Końcowa migawka katalogu jest niedostępna.'),
    );
  if (
    !before.root ||
    before.root !== after.root ||
    !before.fingerprint ||
    !after.fingerprint
  )
    return unavailable(
      'Migawki dotyczą różnych katalogów lub nie mają odcisku zawartości.',
    );
  const paths = [
    ...new Set([...before.files.keys(), ...after.files.keys()]),
  ].sort();
  const files: ReviewDiff['files'] = [];
  let patch = '';
  let binary = false;
  let patchLines = 0;
  for (const path of paths) {
    const previous = before.files.get(path);
    const next = after.files.get(path);
    if (
      previous?.hash === next?.hash &&
      previous?.type === next?.type &&
      previous?.mode === next?.mode
    )
      continue;
    if (files.length >= limits.files)
      return unavailable(
        `Przegląd przekracza limit ${limits.files} zmienionych wpisów. ${exclusions}`,
        patch,
        files,
      );
    const isBinary =
      (previous?.type === 'file' && previous.text === null) ||
      (next?.type === 'file' && next.text === null);
    binary ||= isBinary;
    files.push({
      path: path || '.',
      kind: isBinary
        ? 'binary'
        : !previous
          ? 'added'
          : !next
            ? 'deleted'
            : 'modified',
    });
    const part = isBinary
      ? `diff --git ${label('a', path)} ${label('b', path)}\nZmieniono zawartość binarną. Dokładne bajty uwzględniono w hashu; nie są wyświetlane w przeglądzie.\n`
      : unified(path, previous, next);
    const count = part.split('\n').length - 1;
    if (
      patch.length + part.length > limits.patchCharacters - 100 ||
      patchLines + count > limits.patchLines - 1
    ) {
      const marker =
        '[Skrócono różnice: przekroczono limit rozmiaru lub liczby wierszy.]\n';
      return unavailable(
        `Różnice przekraczają limit ${limits.patchCharacters} znaków lub ${limits.patchLines} wierszy. ${exclusions}`,
        `${patch}${marker}`,
        files,
      );
    }
    patch += part;
    patchLines += count;
  }
  if (binary)
    return unavailable(
      `Zmian binarnych nie można w pełni sprawdzić w tym przeglądzie. ${exclusions}`,
      patch,
      files,
    );
  return {
    status: 'complete',
    detail: exclusions,
    patch,
    files,
    fingerprint: after.fingerprint,
  };
}
