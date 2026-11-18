import {
  workflowShareBundleSchema,
  workflowShareCreatedSchema,
  workflowShareLimits,
  type WorkflowShareBundle,
  type WorkflowShareCreated,
} from '@nesvo/contracts';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CREATED_RESPONSE_BYTES = 16_384;
const MAX_BUNDLE_RESPONSE_BYTES = workflowShareLimits.totalBytes * 2;

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
  `${origin}/api/shares${id ? `/${encodeURIComponent(id)}` : ''}`;

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
  if (response.status === 413)
    throw new ShareRequestError(
      'The share site refused the workflow as too large.',
      413,
    );
  if (response.status === 429)
    throw new ShareRequestError(
      'The share site is limiting new links. Try again later.',
      429,
    );
  if (!response.ok)
    throw new ShareRequestError(
      `The share site refused the workflow (${response.status}).`,
      response.status,
    );
  const parsed = workflowShareCreatedSchema.safeParse(
    await readJson(response, MAX_CREATED_RESPONSE_BYTES),
  );
  if (!parsed.success)
    throw new ShareRequestError('The share site sent an unexpected answer.');
  if (new URL(parsed.data.url).origin !== origin)
    throw new ShareRequestError(
      'The share site answered with a link to another site.',
    );
  return parsed.data;
};

export const fetchShare = async (
  origin: string,
  id: string,
): Promise<WorkflowShareBundle> => {
  const response = await request(shareUrl(origin, id), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (response.status === 404)
    throw new ShareRequestError(
      'This shared workflow does not exist or its link was revoked.',
      404,
    );
  if (response.status === 410)
    throw new ShareRequestError(
      'This shared workflow link has expired. Ask for a new link.',
      410,
    );
  if (!response.ok)
    throw new ShareRequestError(
      `The share site could not return the workflow (${response.status}).`,
      response.status,
    );
  const parsed = workflowShareBundleSchema.safeParse(
    await readJson(response, MAX_BUNDLE_RESPONSE_BYTES),
  );
  if (!parsed.success)
    throw new ShareRequestError(
      'The shared workflow is not in a format this version of Nesvo can read.',
    );
  return parsed.data;
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
  if (!response.ok)
    throw new ShareRequestError(
      `The share site did not revoke the link (${response.status}).`,
      response.status,
    );
  return 'revoked';
};
