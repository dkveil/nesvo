import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AllowPattern } from '@nesvo/contracts';
import { analyzeClaudeBash } from './claude-bash-rule';

export type AllowCandidate = AllowPattern & {
  target: string;
  directory: string;
  value: string;
  binding?: string;
  legacyBinding?: string;
  legacyMcp?: boolean;
  kind: 'shell' | 'file' | 'mcp' | 'web';
};

const windowsDevice =
  /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(?:\.|$)/i;
const outside =
  'A path is outside the session folder or passes through a link.';
const protectedNames = new Set(['..', '.git', '.claude', '.codex', '.agents']);
const bindingHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const slash = (value: string) => value.replaceAll('\\', '/');

export function insideDirectory(directory: string, target: string): boolean {
  const path = relative(directory, target);
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith('..' + sep) &&
    !isAbsolute(path)
  );
}

function scopedPath(
  directory: string,
  path: string,
  includeRoot = false,
): string | null {
  if (
    !path ||
    path.length > 4096 ||
    /[\u0000-\u001f?*\[\]()!{},]/.test(path) ||
    (sep === '/' && path.includes('\\')) ||
    /^[/\\]{2}/.test(path) ||
    path.replace(/^[A-Za-z]:[/\\]/, '').includes(':') ||
    path
      .split(/[/\\]/)
      .some(
        segment =>
          protectedNames.has(segment.toLowerCase()) ||
          (process.platform === 'win32' &&
            (windowsDevice.test(segment) ||
              (/[ .]$/.test(segment) && segment !== '.'))),
      )
  )
    return null;
  const target = resolve(directory, path);
  if (
    !(includeRoot && !relative(directory, target)) &&
    !insideDirectory(directory, target)
  )
    return null;
  try {
    if (relative(realpathSync(directory), directory)) return null;
    let current = directory;
    for (const segment of relative(directory, target)
      .split(sep)
      .filter(Boolean)) {
      current = resolve(current, segment);
      const info = lstatSync(current, { throwIfNoEntry: false });
      if (
        info?.isSymbolicLink() ||
        (info?.isFile() && info.nlink !== 1) ||
        (info && !info.isFile() && !info.isDirectory())
      )
        return null;
    }
  } catch {
    return null;
  }
  return target;
}

function normalRuleDomain(value: string): string | null {
  if (!/^(?:[\p{L}\p{N}.-]+|\[[\da-f:.]+\])$/iu.test(value)) return null;
  try {
    return new URL('https://' + value).hostname.replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

function pathsOnMcpInput(
  directory: string,
  input: Record<string, unknown>,
): boolean {
  const queue = Object.entries(input);
  for (let index = 0; index < queue.length && index < 512; index++) {
    const [key, value] = queue[index]!;
    if (typeof value === 'string') {
      if (value.toLowerCase().startsWith('file:')) {
        try {
          if (!scopedPath(directory, fileURLToPath(value), true)) return false;
        } catch {
          return false;
        }
        continue;
      }
      if (
        /^(?:[A-Za-z]:[/\\]|[/\\]|~[/\\]|\.\.[/\\])/.test(value) ||
        /(?:^|_)(?:.+_)?(?:paths?|files?|directory|cwd)$/i.test(key) ||
        /(?:Path|File|Directory)$/.test(key)
      ) {
        if (!scopedPath(directory, value, true)) return false;
      }
    } else if (Array.isArray(value)) {
      for (const item of value.slice(0, 513)) queue.push([key, item]);
    } else if (value && typeof value === 'object') {
      queue.push(...Object.entries(value).slice(0, 513));
    }
  }
  return queue.length <= 512;
}

export function claudeAllowCandidate(
  directory: string,
  tool: string,
  input: Record<string, unknown>,
  servers: Record<string, unknown>,
  blockedPath: unknown,
): AllowCandidate | { reason: string } {
  if (
    typeof blockedPath === 'string' &&
    blockedPath &&
    !scopedPath(directory, blockedPath, true)
  )
    return { reason: outside };
  if (tool === 'Bash') {
    if (
      typeof input.command !== 'string' ||
      input.run_in_background ||
      Object.keys(input).some(
        key =>
          !['command', 'description', 'timeout', 'run_in_background'].includes(
            key,
          ),
      )
    )
      return {
        reason:
          'The working directory or lifetime of this command cannot be verified.',
      };
    const result = analyzeClaudeBash(input.command, directory, (root, value) =>
      scopedPath(root, value, true),
    );
    if ('reason' in result) return result;
    const proposed =
      result.prefix.length <= 4100 ? result.prefix + ' *' : result.command;
    if (proposed.length > 4100)
      return { reason: 'This command is too long to save as a rule.' };
    return {
      kind: 'shell',
      tool,
      directory,
      target: directory,
      value: result.command,
      pattern: 'Bash(' + proposed + ')',
      legacyBinding: result.script ? bindingHash(result.script) : undefined,
    };
  }
  if (tool === 'Edit' || tool === 'Write') {
    const keys =
      tool === 'Edit'
        ? ['file_path', 'old_string', 'new_string', 'replace_all']
        : ['file_path', 'content'];
    if (Object.keys(input).some(key => !keys.includes(key)))
      return { reason: 'The full set of file changes cannot be verified.' };
    const target =
      typeof input.file_path === 'string'
        ? scopedPath(directory, input.file_path)
        : null;
    if (!target) return { reason: outside };
    const value = './' + slash(relative(directory, target));
    return {
      kind: 'file',
      tool,
      directory,
      target,
      value,
      pattern: tool + '(' + value + ')',
    };
  }
  if (tool === 'WebFetch') {
    try {
      const url = new URL(typeof input.url === 'string' ? input.url : '');
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        Array.from(url.searchParams.keys()).some(key =>
          /(?:token|secret|password|api.?key|authorization)/i.test(key),
        )
      )
        return {
          reason:
            'Only HTTP or HTTPS requests without embedded credentials can be remembered.',
        };
      const value = url.hostname.replace(/\.$/, '');
      return {
        kind: 'web',
        tool,
        directory,
        target: directory,
        value,
        pattern: 'WebFetch(domain:' + value + ')',
      };
    } catch {
      return {
        reason: 'This request does not identify a valid WebFetch domain.',
      };
    }
  }
  const names = Object.keys(servers).filter(name =>
    tool.startsWith('mcp__' + name + '__'),
  );
  if (names.length === 1) {
    const server = names[0]!;
    const name = tool.slice(server.length + 'mcp____'.length);
    if (!/^[\w-]+$/.test(server) || !/^[\w-]+$/.test(name))
      return {
        reason:
          'The MCP server or tool name cannot be represented in an allow rule.',
      };
    if (!pathsOnMcpInput(directory, input)) return { reason: outside };
    const value = server + ':' + name;
    return {
      kind: 'mcp',
      tool,
      directory,
      target: directory,
      value,
      pattern: value,
      binding: bindingHash(servers[server]),
      legacyMcp:
        typeof input.path === 'string' &&
        isAbsolute(input.path) &&
        Object.keys(input).length === 1 &&
        !!scopedPath(directory, input.path),
    };
  }
  return {
    reason:
      'Saved rules are available for Bash, Edit, Write, configured MCP tools and WebFetch.',
  };
}

function wildcard(pattern: string, value: string): boolean {
  if (pattern.endsWith(' *') && value === pattern.slice(0, -2)) return true;
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === value;
  const first = parts[0]!;
  const last = parts.at(-1)!;
  if (!value.startsWith(first) || !value.endsWith(last)) return false;
  let position = first.length;
  const limit = value.length - last.length;
  for (const part of parts.slice(1, -1)) {
    const found = value.indexOf(part, position);
    if (found === -1 || found + part.length > limit) return false;
    position = found + part.length;
  }
  return position <= limit;
}

function unwrap(candidate: AllowCandidate, pattern: string) {
  const prefix = candidate.tool + '(';
  return (
    pattern.startsWith(prefix) && pattern.endsWith(')')
      ? pattern.slice(prefix.length, -1)
      : pattern
  ).trim();
}

function validFilePattern(pattern: string) {
  return (
    pattern.startsWith('./') &&
    !/[\u0000-\u001f\\:?[\]()!{},]/.test(pattern) &&
    pattern
      .slice(2)
      .split('/')
      .every(
        segment =>
          !!segment &&
          segment !== '.' &&
          !protectedNames.has(segment.toLowerCase()) &&
          (!segment.includes('**') || segment === '**') &&
          !windowsDevice.test(segment),
      )
  );
}

export function allowPatternMatches(
  candidate: AllowCandidate,
  pattern: string,
  basis: string,
): boolean {
  const body = unwrap(candidate, pattern);
  if (candidate.kind === 'shell') return wildcard(body, candidate.value);
  if (candidate.kind === 'file') {
    if (!insideDirectory(basis, candidate.target)) return false;
    const normalize = (value: string) =>
      process.platform === 'win32' ? value.toLowerCase() : value;
    return posix.matchesGlob(
      normalize(slash(relative(basis, candidate.target))),
      normalize(body.slice(2)),
    );
  }
  if (candidate.kind === 'mcp')
    return (
      candidate.value === body || candidate.value.split(':')[0] + ':*' === body
    );
  return candidate.value === body.replace(/^domain:/, '');
}

export function prepareAllowPattern(
  candidate: AllowCandidate,
  pattern: string,
  basis: string,
): { pattern: string } | { reason: string } {
  let body = unwrap(candidate, pattern);
  if (
    !body ||
    body.length > 4100 ||
    /[\u0000-\u001f\u007f]/.test(body) ||
    body.split('*').length > 17
  )
    return { reason: 'Enter a single pattern with at most 16 wildcards.' };
  if (candidate.kind === 'file' && !body.startsWith('./')) body = './' + body;
  if (candidate.kind === 'file' && !validFilePattern(body))
    return {
      reason:
        'Use a relative glob such as ./src/**/*.ts. It must stay inside the session folder.',
    };
  if (candidate.kind === 'web') {
    const domain = normalRuleDomain(body.replace(/^domain:/, ''));
    if (!domain)
      return { reason: 'Enter one exact domain without a URL or wildcard.' };
    body = 'domain:' + domain;
  }
  if (!allowPatternMatches(candidate, body, candidate.directory))
    return { reason: 'The pattern must match this operation.' };
  if (candidate.kind === 'file' && relative(basis, candidate.directory))
    body =
      './' + slash(relative(basis, candidate.directory)) + '/' + body.slice(2);
  if (candidate.kind === 'file' && !validFilePattern(body))
    return {
      reason: 'The project-relative pattern cannot be represented safely.',
    };
  const result =
    candidate.kind === 'mcp' ? body : candidate.tool + '(' + body + ')';
  if (result.length > 4200)
    return { reason: 'This pattern is too long to save.' };
  return { pattern: result };
}
