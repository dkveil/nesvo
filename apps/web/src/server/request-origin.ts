const LOCAL_HOST_PATTERN = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
const HOST_PATTERN = /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[::1\](?::\d{1,5})?$/;

export const PUBLIC_ORIGIN = 'https://nesvo.dev';

export const resolveOrigin = (host: string | null): string => {
  if (!host || !HOST_PATTERN.test(host)) return PUBLIC_ORIGIN;
  const protocol = LOCAL_HOST_PATTERN.test(host) ? 'http' : 'https';
  return `${protocol}://${host.toLowerCase()}`;
};

export const resolveRequestOrigin = (request: Request): string =>
  resolveOrigin(request.headers.get('host') ?? new URL(request.url).host);
