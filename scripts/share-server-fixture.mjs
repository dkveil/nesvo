import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  WORKFLOW_SHARE_EXPIRES_HEADER,
  WORKFLOW_SHARE_ID_PATTERN,
  WORKFLOW_SHARE_RETENTION_MS,
  findWorkflowShareSecrets,
  workflowShareBundleSchema,
  workflowShareLimits,
} from '../packages/contracts/src/workflow-share.ts';

export const EXPIRED_SHARE_ID = 'expired'.padEnd(32, '0');

const json = (response, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
};

const failure = (response, status, error, message, extra = {}, headers) =>
  json(response, status, { error, message, ...extra }, headers);

export const startShareServer = async () => {
  const shares = new Map();
  const requests = [];
  const pendingCreateFailures = [];
  let origin = '';
  const create = (request, response, text) => {
    const planned = pendingCreateFailures.shift();
    if (planned?.status === 429)
      return failure(
        response,
        429,
        'rate_limited',
        'Too many shares from this address. Try again later.',
        {},
        { 'retry-after': String(planned.retryAfter) },
      );
    if (
      !(request.headers['content-type'] ?? '').startsWith('application/json')
    )
      return failure(
        response,
        415,
        'unsupported_media_type',
        'Send the workflow as application/json.',
      );
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      return failure(
        response,
        400,
        'invalid_request',
        'The request body is not valid JSON.',
      );
    }
    const parsed = workflowShareBundleSchema.safeParse(value);
    if (!parsed.success)
      return failure(
        response,
        400,
        'invalid_request',
        'The workflow bundle is not valid.',
        {
          issues: parsed.error.issues.slice(0, 20).map(issue => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      );
    const secrets = findWorkflowShareSecrets(parsed.data);
    if (secrets.length)
      return failure(
        response,
        422,
        'secret_detected',
        'The workflow looks like it contains a secret. Remove it and share again.',
        { secrets: secrets.slice(0, 20) },
      );
    const id = randomBytes(24).toString('base64url');
    const revokeToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + WORKFLOW_SHARE_RETENTION_MS,
    ).toISOString();
    shares.set(id, { bundle: parsed.data, revokeToken, expiresAt });
    json(
      response,
      201,
      { id, url: `${origin}/w/${id}`, revokeToken, expiresAt },
      { location: `/api/shares/${id}` },
    );
  };
  const server = createServer((request, response) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size <= workflowShareLimits.requestBytes) chunks.push(chunk);
    });
    request.on('end', () => {
      const path = new URL(request.url ?? '/', origin).pathname;
      const id = /^\/api\/shares\/([^/]+)$/.exec(path)?.[1];
      requests.push({
        method: request.method,
        path,
        authorization: request.headers.authorization ?? null,
      });
      if (request.method === 'POST' && path === '/api/shares') {
        if (size > workflowShareLimits.requestBytes)
          return failure(
            response,
            413,
            'payload_too_large',
            'A shared workflow can be at most 256 KiB.',
          );
        return create(request, response, Buffer.concat(chunks).toString());
      }
      const known = id && WORKFLOW_SHARE_ID_PATTERN.test(id);
      if (request.method === 'GET' && known && id === EXPIRED_SHARE_ID)
        return failure(
          response,
          410,
          'expired',
          'This shared workflow has expired.',
        );
      const share = known ? shares.get(id) : undefined;
      if (!share)
        return failure(
          response,
          404,
          'not_found',
          'This shared workflow does not exist or was removed.',
        );
      if (request.method === 'GET') {
        const text = JSON.stringify(share.bundle);
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(text),
          'cache-control': 'no-store',
          [WORKFLOW_SHARE_EXPIRES_HEADER]: share.expiresAt,
        });
        response.end(text);
        return;
      }
      if (request.method === 'DELETE') {
        const token = /^Bearer\s+([A-Za-z0-9_-]{16,128})$/.exec(
          request.headers.authorization ?? '',
        )?.[1];
        if (!token)
          return failure(
            response,
            401,
            'unauthorized',
            'Send the revoke token as a bearer token.',
          );
        if (token !== share.revokeToken)
          return failure(
            response,
            403,
            'forbidden',
            'The revoke token does not match this share.',
          );
        shares.delete(id);
        response.writeHead(204, { 'cache-control': 'no-store' }).end();
        return;
      }
      failure(response, 404, 'not_found', 'Unknown route.');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    shares,
    requests,
    failNextCreate: planned => pendingCreateFailures.push(planned),
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
};
