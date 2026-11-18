export const ROBOTS_DIRECTIVE = 'noindex, nofollow';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export type HeaderEntry = { key: string; value: string };

export const buildSiteHeaders = (isProduction: boolean): HeaderEntry[] => [
  { key: 'X-Robots-Tag', value: ROBOTS_DIRECTIVE },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
  {
    key: 'Accept-CH',
    value: 'Sec-CH-UA-Platform, Sec-CH-UA-Arch, Sec-CH-UA-Mobile',
  },
  ...(isProduction
    ? [
        { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=31536000; includeSubDomains',
        },
      ]
    : []),
];
