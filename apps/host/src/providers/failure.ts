import type { SessionFailure } from '@nesvo/contracts';

export type FailureKind = SessionFailure['kind'];

const signInPattern =
  /not logged in|please run `?\/?(?:claude )?(?:auth )?login`?|invalid api key|authentication_error|authentication_failed|\b401\b/i;
const networkPattern =
  /ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed|socket hang up|network error|\b503\b|\b529\b|overloaded_error/i;

export function errorFailureKind(text: string): FailureKind | null {
  if (signInPattern.test(text)) return 'sign-in';
  if (networkPattern.test(text)) return 'network';
  return null;
}

export function sessionFailure(
  kind: FailureKind,
  message: string,
  extra: {
    resetsAt?: string | null;
    exitCode?: number | null;
    detail?: string | null;
  } = {},
): SessionFailure {
  return {
    kind,
    message: message.slice(0, 2000),
    resetsAt: extra.resetsAt ?? null,
    exitCode: extra.exitCode ?? null,
    detail: extra.detail ? extra.detail.slice(-4000) : null,
  };
}

export class ProviderFailureError extends Error {
  constructor(readonly failure: SessionFailure) {
    super(failure.message);
  }
}
