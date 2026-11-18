import { dirname } from 'node:path';

export function tomlInline(value: unknown): string {
  if (typeof value === 'string')
    return JSON.stringify(value).replace(/\u007f/g, '\\u007F');
  if (
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return String(value);
  if (Array.isArray(value)) return '[' + value.map(tomlInline).join(', ') + ']';
  if (
    value &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  )
    return (
      '{' +
      Object.entries(value)
        .map(([key, entry]) => tomlInline(key) + ' = ' + tomlInline(entry))
        .join(', ') +
      '}'
    );
  throw new Error('Codex configuration contains an unsupported value.');
}

export function codexProjectOverride(directory: string): string[] {
  const projects: Record<string, { trust_level: string }> = Object.create(null);
  let folder = directory;
  while (true) {
    for (const path of [folder, folder.replaceAll('\\', '/')]) {
      projects[path] = { trust_level: 'untrusted' };
      if (process.platform === 'win32')
        projects[path.toLowerCase()] = projects[path]!;
    }
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return ['-c', 'projects=' + tomlInline(projects)];
}
