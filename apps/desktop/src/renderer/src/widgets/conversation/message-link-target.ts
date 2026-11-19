export type FileTarget = { path: string; line?: number };

export type MessageLinkTarget =
  | { kind: 'pr' | 'issue'; url: string; repository: string; number: number }
  | { kind: 'preview'; url: string; port: number }
  | { kind: 'session' | 'inbox'; id: string; hostId?: string }
  | { kind: 'file'; file: FileTarget }
  | { kind: 'external'; url: string };

export function fileTarget(raw: string, directory: string): FileTarget | null {
  if (!raw || !directory || raw.length > 4096) return null;
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(directory);
  const normalize = (path: string) =>
    windows ? path.replaceAll('\\', '/') : path;
  value = normalize(value);
  const lineMatch = /(?::|#L)([1-9]\d{0,8})$/.exec(value);
  const line = lineMatch ? Number(lineMatch[1]) : undefined;
  if (lineMatch) value = value.slice(0, lineMatch.index);
  const root = normalize(directory).replace(/\/+$/, '');
  const compare = (text: string) => (windows ? text.toLowerCase() : text);
  const absolute = value.startsWith('/') || /^[a-z]:/i.test(value);
  if (absolute && !compare(value).startsWith(compare(root + '/'))) return null;
  const relative = absolute ? value.slice(root.length + 1) : value;
  if (/[:\\?#\p{Cc}]/u.test(relative) || relative.startsWith('/')) return null;
  const segments = relative.split('/').filter(segment => segment !== '.');
  if (
    !segments.length ||
    segments.some(
      segment =>
        !segment || segment === '..' || (windows && /[. ]$/.test(segment)),
    )
  )
    return null;
  return { path: segments.join('/'), ...(line === undefined ? {} : { line }) };
}

const itemId = /^\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i;

export function classifyMessageLink(
  href: string | undefined,
  scope?: { directory: string; ports: ReadonlySet<number> },
): MessageLinkTarget | null {
  const value = href?.trim();
  if (!value) return null;
  const url = URL.canParse(value) ? new URL(value) : null;
  if (url?.protocol === 'nesvo:') {
    const kind = url.hostname;
    const match = itemId.exec(url.pathname);
    if (
      !match ||
      url.username ||
      url.password ||
      url.port ||
      (kind !== 'session' && kind !== 'inbox')
    )
      return null;
    return {
      kind,
      id: match[1]!,
      hostId: url.searchParams.get('host') ?? undefined,
    };
  }
  if (url?.protocol === 'https:' || url?.protocol === 'http:') {
    if (!/^https?:\/\//i.test(value) || url.username || url.password)
      return null;
    const github =
      url.hostname === 'github.com' && !url.port
        ? /^\/([a-z\d][a-z\d-]{0,38}\/[a-z\d._-]{1,100})\/(pull|issues)\/([1-9]\d{0,8})(?:\/|$)/.exec(
            url.pathname,
          )
        : null;
    if (github)
      return {
        kind: github[2] === 'pull' ? ('pr' as const) : ('issue' as const),
        repository: github[1]!,
        number: Number(github[3]),
        url: url.href,
      };
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (
      scope &&
      (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        (!!url.port && scope.ports.has(port)))
    )
      return { kind: 'preview' as const, url: url.href, port };
    return { kind: 'external' as const, url: url.href };
  }
  const file =
    scope && !value.startsWith('//')
      ? fileTarget(value, scope.directory)
      : null;
  return file ? { kind: 'file' as const, file } : null;
}
