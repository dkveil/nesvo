import {
  checkCandidateSchema,
  looksExternal,
  type CheckCandidate,
} from '@nesvo/contracts';
import { createHash } from 'node:crypto';
import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import {
  inside,
  missing,
  pathKey,
  readDefinitionFile,
  type DefinitionFile,
} from './definitions';
import { filterResultText } from './evidence';

export const hashText = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const windows = process.platform === 'win32';
export type CheckTarget = CheckCandidate['target'];
export type Invocation = Extract<CheckTarget, { tool: string }>;
export type CandidateInput = Omit<CheckCandidate, 'id' | 'intent'>;
export type ReadInput = (path: string) => Promise<DefinitionFile | null>;

export async function readCheckInput(
  root: string,
  name: string,
  signal: AbortSignal,
) {
  const path = resolve(root, name);
  if (!inside(root, path))
    throw new Error('Project input is outside the check folder.');
  try {
    if (pathKey(await realpath(path)) !== pathKey(path))
      throw new Error(
        'Project inputs must be regular files inside the check folder.',
      );
    const file = await readDefinitionFile(path, signal);
    if (pathKey(file.path) !== pathKey(path))
      throw new Error('Project input changed location.');
    return file;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export async function launcher(
  tool: string,
  root: string,
  environment: NodeJS.ProcessEnv,
) {
  const folders = tool.includes('/')
    ? [root]
    : (environment.Path ?? environment.PATH ?? environment.path ?? '')
        .split(delimiter)
        .map(path => path.replace(/^"|"$/g, ''))
        .filter(path => isAbsolute(path));
  const extensions =
    windows && !/\.(?:exe|cmd|bat)$/i.test(tool)
      ? ['.exe', '.cmd', '.bat']
      : [''];
  for (const folder of folders)
    for (const extension of extensions) {
      const path = join(folder, tool + extension);
      try {
        if (
          tool.includes('/') &&
          pathKey(await realpath(path)) !== pathKey(path)
        )
          continue;
        if (
          windows &&
          /\.(?:cmd|bat)$/i.test(path) &&
          /["%!^&|<>\r\n]/.test(path)
        )
          continue;
        const canonical = await realpath(path);
        const file = await lstat(canonical, { bigint: true });
        if (!file.isFile()) continue;
        await access(path, windows ? constants.F_OK : constants.X_OK);
        return {
          path,
          stamp: [canonical, file.size, file.mtimeNs, file.ctimeNs].join(':'),
        };
      } catch {
        continue;
      }
    }
  return null;
}

export const sourceAt = (
  root: string,
  file: DefinitionFile,
  location: string,
) => ({
  file: relative(root, file.path).replaceAll('\\', '/').slice(0, 240),
  hash: file.contentHash,
  location: filterResultText(location).slice(0, 300),
});

export function candidate(input: CandidateInput): CheckCandidate | null {
  const id = hashText(
    JSON.stringify([input.target, input.directory, input.source]),
  );
  const parsed = checkCandidateSchema.safeParse({
    ...input,
    id,
    intent: 'tests',
  });
  return parsed.success ? parsed.data : null;
}

const commandWords =
  /^(?:\.\/)?[A-Za-z0-9][\w./-]*(?: +[A-Za-z0-9_./:@=+-]+)*$/;
const unsafeOption =
  /^(?:-c|-e|--eval|--exec|--require|--config|--project-directory|--directory|--cwd|--prefix|-C|-f|--file)(?:=|$)/;

export function parseCheckCommand(command: string): Invocation | null {
  const text = command.trim();
  if (
    text.length > 600 ||
    !commandWords.test(text) ||
    looksExternal(text) ||
    filterResultText(text) !== text
  )
    return null;
  const [raw, ...args] = text.split(/ +/);
  const tool = raw!;
  if (
    tool.length > 120 ||
    args.length > 24 ||
    args.some(
      arg =>
        arg.length > 200 ||
        unsafeOption.test(arg) ||
        /(?:^|[=/])\.\.(?:\/|$)|(?:^|=)(?:https?:|\/|[A-Za-z]:)/.test(arg),
    )
  )
    return null;
  if (
    tool
      .replace(/^\.\//, '')
      .split('/')
      .some(segment => segment === '.' || segment === '..')
  )
    return null;
  if (tool.includes('/') && !raw!.startsWith('./')) return null;
  if (
    /^(?:bash|sh|zsh|fish|cmd|powershell|pwsh|curl|wget|ssh|scp|rsync|git|gh|sudo|docker|podman)(?:\.exe)?$/i.test(
      tool,
    )
  )
    return null;
  if (
    args.some(arg =>
      /^(?:install|uninstall|upload|publish|push|deploy|exec|download)$/i.test(
        arg,
      ),
    )
  )
    return null;
  return { tool, args };
}

export function isUniversalTest({ tool, args }: Invocation): boolean {
  const [first, second] = args;
  if (tool === 'node')
    return (
      first === '--test' &&
      args.slice(1).every(arg => /^[\w./-]+\.[cm]?[jt]s$/.test(arg))
    );
  if (['go', 'dotnet', 'cargo', 'mix', 'swift', 'zig'].includes(tool))
    return first === 'test';
  if (['python', 'python3', 'py'].includes(tool))
    return first === '-m' && ['pytest', 'unittest'].includes(second ?? '');
  if (['make', 'just', 'task'].includes(tool))
    return (
      args.length === 1 && /^tests?(?:[-_:](?:all|ci))?$/.test(first ?? '')
    );
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(tool))
    return (
      (first === 'test' && args.length === 1) ||
      (first === 'run' &&
        /^tests?(?:[-_:](?:all|ci))?$/.test(second ?? '') &&
        args.length === 2)
    );
  return (
    ['pytest', 'vitest', 'jest', 'tox', 'nox', 'ctest'].includes(tool) &&
    args.every(arg => /^-?[\w./-]+$/.test(arg))
  );
}
