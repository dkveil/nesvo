import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

type Word = { raw: string; text: string };
type Part = { words: Word[]; separator: string; writes: Word[] };
type Analysis =
  { command: string; prefix: string; script?: string } | { reason: string };

const lexeme =
  /[ \t]+|\r?\n|&&|\|\||>>|[;|<>]|(?:[^ \t\r\n;&|<>(){}'"\\\x60]+|'[^']*'|"(?:[^"\\]|\\.)*"|\\[ \t'"\\])+/gy;
const pieces = /'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)|([^'"\\]+)/g;
const opaque = 'Nesvo cannot verify shell expansion or indirect execution.';
const external =
  'This call refers to a path outside the session folder or through a link.';
const escalation = 'This call can elevate privileges or change ownership.';
const destructive = 'This call can delete data or rewrite Git history.';
const transfer = 'This call can upload data or execute downloaded content.';
const managers = new Set(['bun', 'npm', 'pnpm', 'yarn']);
const shells = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'cmd',
  'powershell',
  'pwsh',
]);
const receive = new Set(['curl', 'wget', 'invoke-webrequest', 'irm', 'iwr']);
const redirects = new Set(['>', '>>', '<']);
const boundaries = new Set([';', '\n', '&&', '||', '|']);

function parse(command: string): Part[] | null {
  if (
    !command.trim() ||
    command.length > 8192 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)
  )
    return null;
  const parts: Part[] = [];
  let words: Word[] = [];
  let writes: Word[] = [];
  let redirect: string | null = null;
  let offset = 0;
  lexeme.lastIndex = 0;
  for (let match = lexeme.exec(command); match; match = lexeme.exec(command)) {
    offset = lexeme.lastIndex;
    const raw = match[0];
    if (/^[ \t]+$/.test(raw)) continue;
    const separator = raw === '\r\n' ? '\n' : raw;
    if (boundaries.has(separator)) {
      if (!words.length || redirect) return null;
      parts.push({ words, separator, writes });
      words = [];
      writes = [];
      continue;
    }
    if (redirects.has(raw)) {
      if (redirect || words.at(-1)?.raw.endsWith('=')) return null;
      redirect = raw;
      continue;
    }
    const unquoted = raw.replace(/'[^']*'/g, '');
    if (
      /[$%\x60!]|\*(?=[^"]*$)|^\s*[~#]|[\[\]?]/.test(unquoted) &&
      !/^https?:\/\/[^$%\x60!]+$/i.test(raw)
    )
      return null;
    const text = raw.replace(
      pieces,
      (_, single, double, escaped, unquotedWord) =>
        single ??
        double?.replace(/\\(["\\])/g, '$1') ??
        escaped ??
        unquotedWord,
    );
    const word = { raw, text };
    if (redirect) {
      writes.push(word);
      redirect = null;
    } else words.push(word);
  }
  if (offset !== command.length || redirect || !words.length) return null;
  return [...parts, { words, separator: '', writes }];
}

const binary = (value: string) =>
  basename(value.replaceAll('\\', '/'))
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|ps1)$/i, '');

function gitRisk(args: string[]): string | null {
  let index = 0;
  while (args[index]?.startsWith('-')) {
    const flag = args[index++]!;
    if (/^(?:-c|--config-env|--exec-path)/.test(flag)) return opaque;
    if (['-C', '--git-dir', '--work-tree', '--namespace'].includes(flag))
      index++;
  }
  const command = args[index]?.toLowerCase();
  const flags = args.slice(index + 1);
  if (
    [
      'reset',
      'rebase',
      'filter-branch',
      'filter-repo',
      'update-ref',
      'reflog',
    ].includes(command ?? '') ||
    (command === 'clean' &&
      !flags.some(flag => /^(?:--dry-run|-[dfnxX]*n[dfnxX]*)$/.test(flag))) ||
    (command === 'push' &&
      flags.some(flag =>
        /^--force|^--delete$|^-[a-z]*[fd][a-z]*$|^\+|^:/.test(flag),
      )) ||
    (command === 'commit' && flags.includes('--amend')) ||
    (['branch', 'tag', 'checkout', 'switch', 'restore'].includes(
      command ?? '',
    ) &&
      flags.some(flag =>
        /^--(?:force|delete|discard-changes)$|^-[a-zA-Z]*[fDBd][a-zA-Z]*$/.test(
          flag,
        ),
      ))
  )
    return destructive;
  return null;
}

function commandRisk(
  name: string,
  args: string[],
  piped: boolean,
  depth = 0,
): string | null {
  if (depth > 4) return opaque;
  if (
    managers.has(name) &&
    args[0]?.startsWith('-') &&
    args.some(arg => !arg.startsWith('-'))
  )
    return opaque;
  if (
    name === 'npx' ||
    (managers.has(name) && ['dlx', 'x'].includes(args[0] ?? ''))
  )
    return transfer;
  if (managers.has(name) && args[0] === 'exec') {
    const command = args[1] === '--' ? args.slice(2) : args.slice(1);
    const executable = command[0];
    return executable && !executable.startsWith('-')
      ? commandRisk(binary(executable), command.slice(1), piped, depth + 1)
      : opaque;
  }
  if (
    [
      'sudo',
      'doas',
      'su',
      'pkexec',
      'runas',
      'chown',
      'chgrp',
      'takeown',
    ].includes(name) ||
    (name === 'chmod' &&
      args.some(arg => /^(?:[2467][0-7]{3}|[ugoa]*\+s)$/.test(arg)))
  )
    return escalation;
  if (
    [
      'rm',
      'rmdir',
      'unlink',
      'shred',
      'del',
      'erase',
      'remove-item',
      'rd',
      'diskpart',
      'format',
      'mkfs',
      'dd',
    ].includes(name) ||
    name.startsWith('mkfs.') ||
    (name === 'find' && args.includes('-delete')) ||
    (name === 'rsync' && args.some(arg => arg.startsWith('--delete'))) ||
    (name === 'robocopy' &&
      args.some(arg => /^\/(?:mir|purge|move|mov)$/i.test(arg)))
  )
    return destructive;
  if (
    (shells.has(name) && piped) ||
    ['ftp', 'sftp', 'scp', 'ssh', 'nc', 'netcat', 'ncat'].includes(name) ||
    (name === 'rsync' &&
      args.some(arg => /^(?:[^/]+@)?[^/:]+:(?:[^\\/]|$)/.test(arg))) ||
    (receive.has(name) &&
      args.some(
        arg =>
          /^-[A-Za-z]*[dFTKuU]/.test(arg) ||
          /^(?:--(?:data|form|upload|post|body|input-file|config|user|proxy-user|oauth2-bearer)|-body|https?:\/\/[^/]+@)/i.test(
            arg,
          ),
      ))
  )
    return transfer;
  if (
    shells.has(name) ||
    [
      'eval',
      'exec',
      'source',
      '.',
      'xargs',
      'env',
      'command',
      'time',
      'nohup',
      'nice',
      'ionice',
      'timeout',
      'taskset',
      'setsid',
      'stdbuf',
      'busybox',
      'git-lfs',
    ].includes(name) ||
    (/^(?:node|bun|deno|ruby|perl|python\d*|php)$/.test(name) &&
      (args[0] === 'eval' ||
        args.some(arg =>
          /^(?:--(?:eval|print)(?:=|$)|-[ec]|-command\b|-encodedcommand\b)/i.test(
            arg,
          ),
        ))) ||
    (name === 'find' && args.some(arg => /^-(?:exec|ok)(?:dir)?$/.test(arg))) ||
    ['cd', 'pushd', 'popd'].includes(name) ||
    /^[_A-Za-z][_A-Za-z0-9]*=/.test(name)
  )
    return opaque;
  return name === 'git' ? gitRisk(args) : null;
}

const location = (argument: string) =>
  argument.startsWith('-') ? argument.split(/=(.*)/s, 2)[1] : argument;
const pathLike = (argument: string) =>
  /^(?:[A-Za-z]:|[./\\~])/.test(argument) ||
  (/[\\/]/.test(argument) && !/^(?:https?|ssh):\/\//i.test(argument));

function manifestScript(
  directory: string,
  name: string,
  file: (directory: string, path: string) => string | null,
): { value: string; directory: string } | { reason: string } | undefined {
  const manifest = file(directory, 'package.json');
  if (!manifest) return { reason: external };
  try {
    if (statSync(manifest).size > 1_000_000) return { reason: opaque };
    const scripts = JSON.parse(readFileSync(manifest, 'utf8'))?.scripts;
    const value =
      scripts && Object.hasOwn(scripts, name) ? scripts[name] : null;
    if (typeof value !== 'string') return undefined;
    const hooks = ['pre' + name, name, 'post' + name].flatMap(key =>
      typeof scripts[key] === 'string' ? [scripts[key] as string] : [],
    );
    return { value: hooks.join('\n'), directory };
  } catch (error) {
    return {
      reason:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'This package script could resolve outside the session folder.'
          : opaque,
    };
  }
}

export function analyzeClaudeBash(
  command: string,
  directory: string,
  file: (directory: string, path: string) => string | null,
  depth = 0,
): Analysis {
  const parts = parse(command.trim());
  if (!parts || depth > 4)
    return {
      reason: /(?:curl|wget)\b.*\|\s*(?:ba|z|da|k)?sh\b/i.test(command)
        ? transfer
        : opaque,
    };
  let script: string | undefined;
  for (const [index, part] of parts.entries()) {
    const [first, ...rest] = part.words;
    const name = binary(first!.text);
    const args = rest.map(word => word.text);
    const risk = commandRisk(name, args, parts[index - 1]?.separator === '|');
    if (risk) return { reason: risk };
    if (/[\\/]/.test(first!.text) && !file(directory, first!.text))
      return { reason: external };
    for (const { text } of part.writes) {
      if (!file(directory, text)) return { reason: external };
    }
    for (const argument of args) {
      const path = location(argument);
      if (
        path &&
        (pathLike(path) || /^[\w.-]+$/.test(path)) &&
        !file(directory, path)
      )
        return { reason: external };
      if (path && /^[^:\s]+:\/\/[^/]+@/.test(path)) return { reason: transfer };
    }
    if (!managers.has(name)) continue;
    if (
      args.some(arg =>
        /^(?:--(?:cwd|prefix|dir|filter|workspace)|-C)(?:=|$)/.test(arg),
      )
    )
      return { reason: opaque };
    const runner = args[0];
    if (runner && ['exec', 'dlx', 'x'].includes(runner)) continue;
    const scriptName =
      runner === 'run' || runner === 'run-script'
        ? args[1]
        : runner &&
            (name === 'yarn' ||
              name === 'pnpm' ||
              runner === 'test' ||
              runner === 'start')
          ? runner
          : null;
    if (!scriptName || scriptName.startsWith('-') || /[\\/]/.test(scriptName))
      continue;
    const definition = manifestScript(directory, scriptName, file);
    if (!definition) continue;
    if ('reason' in definition) return definition;
    const check = analyzeClaudeBash(
      definition.value,
      definition.directory,
      file,
      depth + 1,
    );
    if ('reason' in check) return check;
    if (parts.length === 1) script = definition.value;
  }
  const raw = parts[0]!.words;
  const first = binary(raw[0]!.text);
  const length =
    managers.has(first) &&
    ['run', 'run-script', 'exec', 'dlx', 'x'].includes(raw[1]?.text ?? '')
      ? 3
      : 2;
  const prefix = raw
    .slice(0, length)
    .map(word => word.raw)
    .join(' ');
  lexeme.lastIndex = 0;
  const normalized = Array.from(
    command.trim().matchAll(lexeme),
    match => match[0],
  )
    .filter(token => !/^[ \t]+$/.test(token))
    .map(token => (token === '\n' || token === '\r\n' ? ';' : token))
    .join(' ');
  return { command: normalized, prefix, script };
}
