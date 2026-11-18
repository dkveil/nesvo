import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const MAX_BODY_BYTES = 512 * 1024;
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

const json = (response, status, body) => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
};

export const startShareServer = async () => {
  const shares = new Map();
  const requests = [];
  let origin = '';
  const server = createServer((request, response) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.on('end', () => {
      const path = new URL(request.url ?? '/', origin).pathname;
      const id = /^\/api\/shares\/([A-Za-z0-9_-]+)$/.exec(path)?.[1];
      requests.push({
        method: request.method,
        path,
        authorization: request.headers.authorization ?? null,
      });
      if (size > MAX_BODY_BYTES) return json(response, 413, {});
      if (request.method === 'POST' && path === '/api/shares') {
        let bundle;
        try {
          bundle = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return json(response, 400, {});
        }
        const shareId = randomBytes(9).toString('base64url');
        const revokeToken = randomBytes(24).toString('base64url');
        const expiresAt = new Date(Date.now() + EXPIRY_MS).toISOString();
        shares.set(shareId, { bundle, revokeToken, expiresAt });
        return json(response, 201, {
          id: shareId,
          url: `${origin}/s/${shareId}`,
          revokeToken,
          expiresAt,
        });
      }
      if (request.method === 'GET' && id === 'expired-share')
        return json(response, 410, {});
      const share = id ? shares.get(id) : undefined;
      if (request.method === 'GET' && id)
        return share
          ? json(response, 200, share.bundle)
          : json(response, 404, {});
      if (request.method === 'DELETE' && id) {
        if (!share) return json(response, 404, {});
        if (request.headers.authorization !== `Bearer ${share.revokeToken}`)
          return json(response, 403, {});
        shares.delete(id);
        response.writeHead(204).end();
        return;
      }
      json(response, 404, {});
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    shares,
    requests,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
};
