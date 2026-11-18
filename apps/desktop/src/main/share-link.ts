export const SHARE_PROTOCOL = 'nesvo';
export const PUBLIC_SHARE_ORIGIN = 'https://nesvo.dev';

const MAX_LINK_LENGTH = 2048;
const IMPORT_ACTION = 'import-workflow';
const SHARE_ID = /^[A-Za-z0-9_-]{6,64}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type ImportLink =
  | { ok: true; shareId: string; origin: string }
  | { ok: false; message: string };

export const normalizeShareOrigin = (value: string): string | null => {
  if (value.length > MAX_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
    return url.origin;
  return null;
};

const refused = (message: string): ImportLink => ({ ok: false, message });

export const parseImportLink = (
  raw: string,
  allowedOrigins: readonly string[],
): ImportLink => {
  if (raw.length > MAX_LINK_LENGTH)
    return refused('The link is too long to be a Nesvo share link.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refused('The link is not a valid Nesvo link.');
  }
  if (url.protocol !== `${SHARE_PROTOCOL}:`)
    return refused('The link is not a Nesvo link.');
  if (url.username || url.password || url.port || url.hash)
    return refused('The link has parts Nesvo does not accept.');
  if (
    url.hostname.toLowerCase() !== IMPORT_ACTION ||
    (url.pathname !== '' && url.pathname !== '/')
  )
    return refused('Nesvo links can only import a shared workflow.');
  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== 2 ||
    keys.filter(key => key === 'share').length !== 1 ||
    keys.filter(key => key === 'origin').length !== 1
  )
    return refused('The link must name exactly one share and one origin.');
  const shareId = url.searchParams.get('share') ?? '';
  if (!SHARE_ID.test(shareId))
    return refused('The share ID in the link is not valid.');
  const origin = normalizeShareOrigin(url.searchParams.get('origin') ?? '');
  const allowed = new Set(
    allowedOrigins
      .map(normalizeShareOrigin)
      .filter((value): value is string => !!value),
  );
  if (!origin || !allowed.has(origin))
    return refused(
      'The link points to a site that is not your configured share site. Nesvo did not open it.',
    );
  return { ok: true, shareId, origin };
};

export const findImportLink = (argv: readonly string[]): string | null =>
  argv.find(value => value.toLowerCase().startsWith(`${SHARE_PROTOCOL}:`)) ??
  null;
