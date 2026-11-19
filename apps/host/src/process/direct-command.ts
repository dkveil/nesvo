import { createHmac, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import type { DirectCommand } from '@nesvo/contracts';
import { runOwnedProcess } from './owned-process';

const environmentNames = [
  'PATH',
  'SystemRoot',
  'TMP',
  'TEMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
] as const;
const blockedExecutable =
  /^(?:cmd|powershell|pwsh|sh|bash|zsh|dash|fish|ksh|wsl)(?:\.exe)?$/i;
const blockedExtension = /\.(?:bat|cmd|ps1|sh|zsh|fish|ksh)$/i;
const maxArtifactBytes = 256 * 1024 * 1024;

const fileIdentity = async (path: string, signal: AbortSignal) => {
  const truePath = await realpath(path);
  if (!(await stat(truePath)).isFile())
    throw new Error('A command artifact is not a regular file.');
  const file = await open(
    truePath,
    constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : constants.O_NONBLOCK),
  );
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxArtifactBytes)
      throw new Error(
        'A command artifact is unavailable or exceeds the size limit.',
      );
    const hash = createHash('sha256');
    const stream = file.createReadStream({
      autoClose: false,
      start: 0,
      end: maxArtifactBytes,
      signal,
    });
    for await (const chunk of stream) hash.update(chunk);
    const after = await file.stat();
    const current = await stat(path);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs ||
      after.dev !== current.dev ||
      after.ino !== current.ino ||
      after.ctimeMs !== current.ctimeMs ||
      truePath !== (await realpath(path))
    )
      throw new Error(
        'A command artifact changed while it was being verified.',
      );
    return { path: truePath, sha256: hash.digest('hex') };
  } finally {
    await file.close();
  }
};

export async function inspectDirectCommand(
  definition: DirectCommand,
  workingDirectory: string,
  scope: string,
  key: string,
  signal: AbortSignal,
) {
  if (
    !isAbsolute(definition.executable) ||
    blockedExtension.test(definition.executable)
  )
    throw new Error('Choose an absolute executable path for a direct command.');
  signal.throwIfAborted();
  const cwd = await realpath(workingDirectory);
  const executable = await fileIdentity(definition.executable, signal);
  if (
    blockedExecutable.test(basename(executable.path)) ||
    blockedExtension.test(executable.path)
  )
    throw new Error('Shell executables are unavailable for direct commands.');
  await access(
    executable.path,
    process.platform === 'win32' ? constants.F_OK : constants.X_OK,
  );
  const referenced = new Set(definition.files.map(path => resolve(cwd, path)));
  for (const argument of definition.argv) {
    if (argument.includes('<') || argument.startsWith('-')) continue;
    const candidate = resolve(cwd, argument);
    const existing = await stat(candidate).catch(() => undefined);
    if (existing?.isFile()) referenced.add(candidate);
  }
  if (referenced.size > 16)
    throw new Error('The command references too many files.');
  const files = await Promise.all(
    [...referenced].sort().map(path => fileIdentity(path, signal)),
  );
  const fingerprint = createHmac('sha256', key)
    .update(JSON.stringify([scope, cwd, definition, executable, files]))
    .digest('hex');
  return { executable: executable.path, cwd, fingerprint };
}

export function runDirectCommand(
  definition: DirectCommand,
  verified: Awaited<ReturnType<typeof inspectDirectCommand>>,
  bindings: Readonly<Record<string, string>>,
  signal: AbortSignal,
) {
  const argv = definition.argv.map(template => {
    const value = template.replace(
      /<([a-zA-Z][a-zA-Z0-9]*)>/g,
      (_, name: string) => {
        if (!Object.hasOwn(bindings, name))
          throw new Error('The command contains an unsupported placeholder.');
        return bindings[name]!;
      },
    );
    if (
      value.length > 8192 ||
      /[\u0000-\u001f\u007f]/u.test(value) ||
      (template.startsWith('<') && value.startsWith('-'))
    )
      throw new Error('A resolved command argument is invalid.');
    return value;
  });
  const env = Object.fromEntries(
    environmentNames.flatMap(name => {
      const value = process.env[name];
      return value ? [[name, value]] : [];
    }),
  );
  return runOwnedProcess({
    command: verified.executable,
    args: argv,
    cwd: verified.cwd,
    env,
    timeoutMs: definition.timeoutMs,
    maxOutputBytes: definition.maxOutputBytes,
    signal,
  });
}
