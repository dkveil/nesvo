import {
  WORKFLOW_SHARE_EXPIRES_HEADER,
  WORKFLOW_SHARE_ID_PATTERN,
  findWorkflowShareSecrets,
  workflowShareBundleSchema,
  workflowShareLimits,
  type WorkflowShareCreated,
} from '@nesvo/contracts/workflow-share';

import type { SiteDatabase } from '../server/database';
import { consumeShareAttempt } from './rate-limit';
import { readBodyWithLimit } from './read-body';
import { errorResponse, jsonResponse } from './share-responses';
import {
  deleteShare,
  findRevokeTokenHash,
  findShare,
  insertShare,
} from './share-store';
import {
  createRevokeToken,
  createShareId,
  hashSecret,
  isSameHash,
} from './share-tokens';

export type ShareHandlerContext = {
  db: SiteDatabase | null;
  origin: string;
  now: number;
};

const BEARER_PATTERN = /^Bearer\s+([A-Za-z0-9_-]{16,128})$/;

const unavailable = (): Response =>
  errorResponse(503, {
    error: 'unavailable',
    message: 'Sharing is not available right now. Try again later.',
  });

const notFound = (): Response =>
  errorResponse(404, {
    error: 'not_found',
    message: 'This shared workflow does not exist or was removed.',
  });

const clientAddressOf = (request: Request): string =>
  request.headers.get('cf-connecting-ip') ?? 'unknown';

const isJsonRequest = (request: Request): boolean =>
  (request.headers.get('content-type') ?? '')
    .toLowerCase()
    .startsWith('application/json');

const parseJson = (text: string): { value: unknown } | null => {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
};

export const handleCreateShare = async (
  request: Request,
  { db, origin, now }: ShareHandlerContext,
): Promise<Response> => {
  if (!db) return unavailable();
  if (!isJsonRequest(request)) {
    return errorResponse(415, {
      error: 'unsupported_media_type',
      message: 'Send the workflow as application/json.',
    });
  }
  const rateLimit = await consumeShareAttempt(
    db,
    clientAddressOf(request),
    now,
  );
  if (rateLimit.status === 'limited') {
    return errorResponse(
      429,
      {
        error: 'rate_limited',
        message: 'Too many shares from this address. Try again later.',
      },
      { 'Retry-After': String(rateLimit.retryAfterSeconds) },
    );
  }
  const body = await readBodyWithLimit(
    request,
    workflowShareLimits.requestBytes,
  );
  if (body.status === 'too-large') {
    return errorResponse(413, {
      error: 'payload_too_large',
      message: `A shared workflow can be at most ${workflowShareLimits.requestBytes / 1024} KiB.`,
    });
  }
  const json = body.status === 'read' ? parseJson(body.text) : null;
  if (!json) {
    return errorResponse(400, {
      error: 'invalid_request',
      message: 'The request body is not valid JSON.',
    });
  }
  const parsed = workflowShareBundleSchema.safeParse(json.value);
  if (!parsed.success) {
    return errorResponse(400, {
      error: 'invalid_request',
      message: 'The workflow bundle is not valid.',
      issues: parsed.error.issues.slice(0, 20).map(issue => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  const secrets = findWorkflowShareSecrets(parsed.data);
  if (secrets.length > 0) {
    return errorResponse(422, {
      error: 'secret_detected',
      message:
        'The workflow looks like it contains a secret. Remove it and share again.',
      secrets: secrets.slice(0, 20),
    });
  }
  const id = createShareId();
  const revokeToken = createRevokeToken();
  const { expiresAt } = await insertShare(db, {
    id,
    bundle: parsed.data,
    revokeTokenHash: await hashSecret(revokeToken),
    now,
  });
  const created: WorkflowShareCreated = {
    id,
    url: `${origin}/w/${id}`,
    revokeToken,
    expiresAt: new Date(expiresAt).toISOString(),
  };
  return jsonResponse(201, created, { Location: `/api/shares/${id}` });
};

export const handleReadShare = async (
  id: string,
  { db, now }: ShareHandlerContext,
): Promise<Response> => {
  if (!WORKFLOW_SHARE_ID_PATTERN.test(id)) return notFound();
  if (!db) return unavailable();
  const share = await findShare(db, id, now);
  if (share.status === 'missing') return notFound();
  if (share.status === 'expired') {
    return errorResponse(410, {
      error: 'expired',
      message: 'This shared workflow has expired.',
    });
  }
  return new Response(share.bundleJson, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      [WORKFLOW_SHARE_EXPIRES_HEADER]: new Date(share.expiresAt).toISOString(),
    },
  });
};

export const handleRevokeShare = async (
  request: Request,
  id: string,
  { db }: ShareHandlerContext,
): Promise<Response> => {
  if (!WORKFLOW_SHARE_ID_PATTERN.test(id)) return notFound();
  const token = BEARER_PATTERN.exec(
    request.headers.get('authorization') ?? '',
  )?.[1];
  if (!token) {
    return errorResponse(
      401,
      {
        error: 'unauthorized',
        message: 'Send the revoke token as a bearer token.',
      },
      { 'WWW-Authenticate': 'Bearer' },
    );
  }
  if (!db) return unavailable();
  const storedHash = await findRevokeTokenHash(db, id);
  if (!storedHash) return notFound();
  if (!isSameHash(storedHash, await hashSecret(token))) {
    return errorResponse(403, {
      error: 'forbidden',
      message: 'The revoke token does not match this share.',
    });
  }
  await deleteShare(db, id);
  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store' },
  });
};
