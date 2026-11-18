import {
  WORKFLOW_SHARE_EXPIRES_HEADER,
  workflowShareApiPath,
  workflowShareBundleSchema,
  workflowShareCreatedSchema,
  workflowShareErrorSchema,
  workflowShareLimits,
  workflowSharingLimits,
  workflowShareSecretLabels,
  type WorkflowShareBundle,
  type WorkflowShareCreated,
  type WorkflowShareError,
} from '@nesvo/contracts';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CREATED_RESPONSE_BYTES = 16_384;
const MAX_ERROR_RESPONSE_BYTES = 16_384;
const MAX_BUNDLE_RESPONSE_BYTES = workflowShareLimits.requestBytes;
const LISTED_SECRET_LIMIT = 5;

export class ShareRequestError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ShareRequestError';
    this.status = status;
  }
}

const unreachable = (origin: string) =>
  new ShareRequestError(
    `${origin} did not answer. Check your connection and the share site in Settings › Sharing.`,
  );

const request = async (url: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, {
      ...init,
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw unreachable(new URL(url).origin);
  }
};

const readJson = async (
  response: Response,
  limit: number,
): Promise<unknown> => {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > limit)
    throw new ShareRequestError('The share site sent too much data.');
  const reader = response.body?.getReader();
  if (!reader) throw new ShareRequestError('The share site sent no data.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ShareRequestError('The share site sent too much data.');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ShareRequestError('The share site sent an unreadable answer.');
  }
};

const shareUrl = (origin: string, id?: string) =>
  `${origin}${workflowShareApiPath(id)}`;

const readError = async (
  response: Response,
): Promise<WorkflowShareError | null> => {
  try {
    const parsed = workflowShareErrorSchema.safeParse(
      await readJson(response, MAX_ERROR_RESPONSE_BYTES),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const plural = (count: number, unit: string) =>
  `${count} ${unit}${count === 1 ? '' : 's'}`;

const retryAfterText = (response: Response): string => {
  const header = response.headers.get('retry-after') ?? '';
  if (!/^\d+$/.test(header)) return 'Try again later.';
  const seconds = Number(header);
  return seconds < 60
    ? `Try again in ${plural(seconds, 'second')}.`
    : `Try again in ${plural(Math.ceil(seconds / 60), 'minute')}.`;
};

const secretsText = (error: WorkflowShareError | null): string => {
  const secrets = error?.secrets ?? [];
  if (!secrets.length) return '';
  const listed = secrets
    .slice(0, LISTED_SECRET_LIMIT)
    .map(
      secret =>
        `${secret.fileName} line ${secret.line} (${workflowShareSecretLabels[secret.kind].toLowerCase()})`,
    )
    .join(', ');
  const more =
    secrets.length > LISTED_SECRET_LIMIT
      ? ` and ${secrets.length - LISTED_SECRET_LIMIT} more`
      : '';
  return ` Check ${listed}${more}.`;
};

const invalidText = (error: WorkflowShareError | null): string => {
  const issue = error?.issues?.[0];
  if (!issue) return '';
  return issue.path ? ` ${issue.path}: ${issue.message}` : ` ${issue.message}`;
};

const unavailableError = (status: number) =>
  new ShareRequestError(
    'Sharing is not available right now. Try again later.',
    status,
  );

const createFailure = async (
  response: Response,
): Promise<ShareRequestError> => {
  const { status } = response;
  if (status === 429)
    return new ShareRequestError(
      `The share site is limiting new links. ${retryAfterText(response)}`,
      status,
    );
  if (status === 413)
    return new ShareRequestError(
      `The share site refused the workflow as too large. A shared workflow can be at most ${workflowShareLimits.requestBytes / 1024} KiB.`,
      status,
    );
  if (status === 415)
    return new ShareRequestError(
      'The share site did not accept the request format. Update Nesvo and try again.',
      status,
    );
  if (status === 503) return unavailableError(status);
  const error = await readError(response);
  if (status === 422 && error?.error === 'secret_detected')
    return new ShareRequestError(
      `The share site found what looks like a secret and did not create a link.${secretsText(error)}`,
      status,
    );
  if (status === 400)
    return new ShareRequestError(
      `The share site refused the workflow as invalid.${invalidText(error)}`,
      status,
    );
  return new ShareRequestError(
    `The share site refused the workflow (${status}).`,
    status,
  );
};

export const createShare = async (
  origin: string,
  bundle: WorkflowShareBundle,
): Promise<WorkflowShareCreated> => {
  const response = await request(shareUrl(origin), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(bundle),
  });
  if (response.status !== 201) {
    const failure = await createFailure(response);
    await response.body?.cancel().catch(() => undefined);
    throw failure;
  }
  const parsed = workflowShareCreatedSchema.safeParse(
    await readJson(response, MAX_CREATED_RESPONSE_BYTES),
  );
  if (
    !parsed.success ||
    parsed.data.url.length > workflowSharingLimits.url ||
    !URL.canParse(parsed.data.url)
  )
    throw new ShareRequestError('The share site sent an unexpected answer.');
  if (new URL(parsed.data.url).origin !== origin)
    throw new ShareRequestError(
      'The share site answered with a link to another site.',
    );
  return parsed.data;
};

export type FetchedShare = {
  bundle: WorkflowShareBundle;
  expiresAt: string | null;
};

const expiryOf = (response: Response): string | null => {
  const time = Date.parse(
    response.headers.get(WORKFLOW_SHARE_EXPIRES_HEADER) ?? '',
  );
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};

const fetchFailure = (status: number): ShareRequestError => {
  if (status === 404)
    return new ShareRequestError(
      'This shared workflow does not exist or its link was revoked.',
      status,
    );
  if (status === 410)
    return new ShareRequestError(
      'This shared workflow link has expired. Ask for a new link.',
      status,
    );
  if (status === 503) return unavailableError(status);
  return new ShareRequestError(
    `The share site could not return the workflow (${status}).`,
    status,
  );
};

export const fetchShare = async (
  origin: string,
  id: string,
): Promise<FetchedShare> => {
  const response = await request(shareUrl(origin, id), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw fetchFailure(response.status);
  }
  const parsed = workflowShareBundleSchema.safeParse(
    await readJson(response, MAX_BUNDLE_RESPONSE_BYTES),
  );
  if (!parsed.success)
    throw new ShareRequestError(
      'The shared workflow is not in a format this version of Nesvo can read.',
    );
  return { bundle: parsed.data, expiresAt: expiryOf(response) };
};

export const deleteShare = async (
  origin: string,
  id: string,
  revokeToken: string,
): Promise<'revoked' | 'gone'> => {
  const response = await request(shareUrl(origin, id), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${revokeToken}` },
  });
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 404 || response.status === 410) return 'gone';
  if (response.status === 401 || response.status === 403)
    throw new ShareRequestError(
      'The share site did not accept the stored revoke token. Remove the link from this list or let it expire.',
      response.status,
    );
  if (!response.ok)
    throw new ShareRequestError(
      `The share site did not revoke the link (${response.status}).`,
      response.status,
    );
  return 'revoked';
};
