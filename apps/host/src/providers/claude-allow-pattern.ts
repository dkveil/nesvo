import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { AllowPattern } from '@nesvo/contracts';

export type AllowCandidate = AllowPattern & {
  target: string;
  binding?: string;
};

const packageCommand =
  /^bun run (?:test|lint|typecheck|format:check|check|build)$/;
const filesystemTool =
  /^mcp__([\w-]+)__(?:read_file|read_text_file|list_directory|get_file_info)$/;
const filesystemPackage =
  /^@modelcontextprotocol\/server-filesystem@\d+\.\d+\.\d+$/;

const windowsDevice =
  /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/i;
const externalScriptPath =
  /(?:^|[\s='"])(?:[A-Za-z]:[\\/]|[\\/]|~[\\/])|(?:^|[\\/\s='"])\.\.(?:[\\/]|$)|[a-z]+:\/\//i;

export function insideDirectory(directory: string, target: string): boolean {
  const path = relative(directory, target);
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith('..' + sep) &&
    !isAbsolute(path)
  );
}

const bindingHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function localPath(directory: string, path: unknown): string | null {
  if (
    typeof path !== 'string' ||
    path.length > 4096 ||
    /[\u0000-\u001f?*\[\]()!{},]/.test(path) ||
    /^[/\\]{2}/.test(path) ||
    path.replace(/^[A-Za-z]:[/\\]/, '').includes(':') ||
    path
      .split(/[/\\]/)
      .some(
        segment =>
          ['..', '.git', '.claude', '.codex', '.agents'].includes(
            segment.toLowerCase(),
          ) ||
          (process.platform === 'win32' &&
            (windowsDevice.test(segment) ||
              (/[ .]$/.test(segment) && segment !== '.'))),
      )
  )
    return null;
  const target = resolve(directory, path);
  if (!insideDirectory(directory, target)) return null;
  let current = directory;
  try {
    if (relative(realpathSync(directory), directory)) return null;
    for (const segment of relative(directory, target).split(sep)) {
      current = resolve(current, segment);
      const info = lstatSync(current, { throwIfNoEntry: false });
      if (info?.isSymbolicLink() || (info?.isFile() && info.nlink !== 1))
        return null;
    }
  } catch {
    return null;
  }
  return target;
}

export function claudeAllowCandidate(
  directory: string,
  tool: string,
  input: Record<string, unknown>,
  servers: Record<string, unknown>,
  blockedPath: unknown,
): AllowCandidate | null {
  if (blockedPath) return null;
  if (tool === 'Bash') {
    if (
      typeof input.command !== 'string' ||
      !packageCommand.test(input.command) ||
      Object.keys(input).some(
        key =>
          !['command', 'description', 'timeout', 'run_in_background'].includes(
            key,
          ),
      )
    )
      return null;
    if (input.run_in_background) return null;
    const manifest = localPath(directory, 'package.json');
    if (!manifest) return null;
    try {
      if (lstatSync(manifest).size > 1_000_000) return null;
      const script = JSON.parse(readFileSync(manifest, 'utf8'))?.scripts?.[
        input.command.slice('bun run '.length)
      ];
      if (
        typeof script !== 'string' ||
        externalScriptPath.test(script) ||
        /[;&|><`\r\n]|\$\(|\b(?:curl|wget|ssh|scp|sudo|rm|del|remove-item|invoke-webrequest)\b|\bgit\s+push\b/i.test(
          script,
        )
      )
        return null;
      return {
        tool,
        pattern: 'Bash(' + input.command + ')',
        target: directory,
        binding: bindingHash(script),
      };
    } catch {
      return null;
    }
  }
  if (tool === 'Edit' || tool === 'Write') {
    const keys =
      tool === 'Edit'
        ? ['file_path', 'old_string', 'new_string', 'replace_all']
        : ['file_path', 'content'];
    if (Object.keys(input).some(key => !keys.includes(key))) return null;
    const target = localPath(directory, input.file_path);
    if (!target) return null;
    const glob = './' + relative(directory, target).split(sep).join('/');
    return { tool, pattern: tool + '(' + glob + ')', target };
  }
  const server = filesystemTool.exec(tool)?.[1];
  const config = server ? servers[server] : null;
  if (!config || typeof config !== 'object') return null;
  const { args, command, type } = config as {
    args?: unknown;
    command?: unknown;
    type?: unknown;
  };
  if (
    (type !== undefined && type !== 'stdio') ||
    !Array.isArray(args) ||
    typeof command !== 'string' ||
    /^[/\\]{2}/.test(command) ||
    !/^npx(?:\.cmd|\.exe)?$/i.test(basename(command)) ||
    args[0] !== '-y' ||
    typeof args[1] !== 'string' ||
    !filesystemPackage.test(args[1]) ||
    typeof input.path !== 'string' ||
    !isAbsolute(input.path) ||
    Object.keys(input).some(key => key !== 'path')
  )
    return null;
  const target = localPath(directory, input.path);
  if (!target) return null;
  return {
    tool,
    pattern: tool,
    target: directory,
    binding: bindingHash(config),
  };
}
