import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from 'bun:test';

import {
  WORKFLOW_SHARE_EXPIRES_HEADER,
  WORKFLOW_SHARE_RETENTION_MS,
  workflowShareBundleSchema,
  workflowShareCreatedSchema,
  workflowShareErrorSchema,
  workflowShareLimits,
} from '@nesvo/contracts/workflow-share';

import { runScheduledCleanup } from '@/server/scheduled-cleanup';
import { SHARE_RATE_LIMIT_ATTEMPTS } from '@/shares/rate-limit';

import { createBundle } from './support/bundles';
import {
  createTestDatabase,
  type TestDatabase,
} from './support/sqlite-database';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const ORIGIN = 'https://nesvo.dev';

let database: TestDatabase | null = null;

mock.module('@opennextjs/cloudflare', () => ({
  getCloudflareContext: async () => ({
    env: {
      DB: database ?? undefined,
      NESVO_RELEASE_REPO: 'dkveil/nesvo',
    },
  }),
}));

const sharesRoute = await import('@/app/api/shares/route');
const shareRoute = await import('@/app/api/shares/[id]/route');

const postShare = (
  body: unknown,
  { ip = '203.0.113.7', contentType = 'application/json' } = {},
) =>
  sharesRoute.POST(
    new Request(`${ORIGIN}/api/shares`, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'cf-connecting-ip': ip,
        host: 'nesvo.dev',
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

const routeContext = (id: string) => ({ params: Promise.resolve({ id }) });

const getShare = (id: string) =>
  shareRoute.GET(
    new Request(`${ORIGIN}/api/shares/${id}`, {
      headers: { host: 'nesvo.dev' },
    }),
    routeContext(id),
  );

const revokeShare = (id: string, token?: string) =>
  shareRoute.DELETE(
    new Request(`${ORIGIN}/api/shares/${id}`, {
      method: 'DELETE',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
    routeContext(id),
  );

const createShare = async () => {
  const response = await postShare(createBundle());
  expect(response.status).toBe(201);
  return workflowShareCreatedSchema.parse(await response.json());
};

const readError = async (response: Response) =>
  workflowShareErrorSchema.parse(await response.json());

beforeEach(() => {
  database = createTestDatabase();
  setSystemTime(NOW);
});

afterEach(() => {
  setSystemTime();
  database?.sqlite.close();
  database = null;
});

describe('POST /api/shares', () => {
  it('stores a bundle and returns its link, revoke token and expiry', async () => {
    const created = await createShare();

    expect(created.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(created.url).toBe(`${ORIGIN}/w/${created.id}`);
    expect(Date.parse(created.expiresAt)).toBe(
      NOW.getTime() + WORKFLOW_SHARE_RETENTION_MS,
    );
    const row = database?.sqlite
      .query('SELECT revoke_token_hash FROM shares WHERE id = ?')
      .get(created.id) as { revoke_token_hash: string };
    expect(row.revoke_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.revoke_token_hash).not.toContain(created.revokeToken);
  });

  it('gives every share a different id and token', async () => {
    const first = await createShare();
    const second = await createShare();

    expect(first.id).not.toBe(second.id);
    expect(first.revokeToken).not.toBe(second.revokeToken);
  });

  it('rejects a bundle that contains a secret without echoing it', async () => {
    const secret = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const bundle = createBundle();
    bundle.steps[1] = {
      fileName: 'lint.md',
      content: `---\nname: lint\ntype: command\n---\ncurl -H "token: x" https://example.com\nexport GH=${secret}\n`,
    };

    const response = await postShare(bundle);
    const text = await response.text();

    expect(response.status).toBe(422);
    expect(text).not.toContain(secret);
    const error = workflowShareErrorSchema.parse(JSON.parse(text));
    expect(error.error).toBe('secret_detected');
    expect(error.secrets).toContainEqual({
      fileName: 'lint.md',
      kind: 'access-token',
      line: 6,
    });
    expect(
      database?.sqlite.query('SELECT COUNT(*) AS count FROM shares').get(),
    ).toEqual({ count: 0 });
  });

  it('accepts environment references that are not secrets', async () => {
    const bundle = createBundle();
    bundle.steps[1] = {
      fileName: 'lint.md',
      content:
        '---\nname: lint\ntype: command\nneeds: [env:API_TOKEN]\n---\ncurl -H "Authorization: Bearer $API_TOKEN" https://example.com\nTOKEN=$API_TOKEN bun run check\n',
    };

    expect((await postShare(bundle)).status).toBe(201);
  });

  it('rejects a request body above the size limit', async () => {
    const response = await postShare(
      'x'.repeat(workflowShareLimits.requestBytes + 1),
    );

    expect(response.status).toBe(413);
    expect((await readError(response)).error).toBe('payload_too_large');
  });

  it('rejects a step file above the per-file limit', async () => {
    const bundle = createBundle();
    bundle.steps[0] = {
      fileName: 'review.md',
      content: 'a'.repeat(workflowShareLimits.fileBytes + 1),
    };

    const response = await postShare(bundle);

    expect(response.status).toBe(400);
    const error = await readError(response);
    expect(error.error).toBe('invalid_request');
    expect(error.issues?.[0]?.path).toBe('steps.0.content');
  });

  it('rejects invalid JSON, unknown fields and other content types', async () => {
    expect((await postShare('{"version":')).status).toBe(400);
    expect((await postShare({ ...createBundle(), extra: true })).status).toBe(
      400,
    );
    expect(
      (await postShare(createBundle(), { contentType: 'text/plain' })).status,
    ).toBe(415);
  });

  it('limits shares per address and window', async () => {
    for (let attempt = 0; attempt < SHARE_RATE_LIMIT_ATTEMPTS; attempt += 1) {
      expect((await postShare(createBundle())).status).toBe(201);
    }

    const limited = await postShare(createBundle());

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await readError(limited)).error).toBe('rate_limited');
    expect(
      (await postShare(createBundle(), { ip: '198.51.100.4' })).status,
    ).toBe(201);
  });
});

describe('GET /api/shares/:id', () => {
  it('returns the stored bundle with its expiry', async () => {
    const created = await createShare();

    const response = await getShare(created.id);

    expect(response.status).toBe(200);
    expect(response.headers.get(WORKFLOW_SHARE_EXPIRES_HEADER)).toBe(
      created.expiresAt,
    );
    expect(workflowShareBundleSchema.parse(await response.json())).toEqual(
      createBundle(),
    );
  });

  it('returns 404 for unknown and malformed ids', async () => {
    expect((await getShare('A'.repeat(32))).status).toBe(404);
    expect((await getShare('not-an-id')).status).toBe(404);
  });

  it('returns 410 once the share has expired', async () => {
    const created = await createShare();
    setSystemTime(new Date(NOW.getTime() + WORKFLOW_SHARE_RETENTION_MS));

    const response = await getShare(created.id);

    expect(response.status).toBe(410);
    expect((await readError(response)).error).toBe('expired');
  });
});

describe('DELETE /api/shares/:id', () => {
  it('removes the share with the revoke token', async () => {
    const created = await createShare();

    const response = await revokeShare(created.id, created.revokeToken);

    expect(response.status).toBe(204);
    expect((await getShare(created.id)).status).toBe(404);
  });

  it('refuses a missing or wrong revoke token', async () => {
    const created = await createShare();
    const other = await createShare();

    expect((await revokeShare(created.id)).status).toBe(401);
    expect((await revokeShare(created.id, other.revokeToken)).status).toBe(403);
    expect((await getShare(created.id)).status).toBe(200);
  });
});

describe('scheduled cleanup', () => {
  it('deletes expired shares and old rate limit windows', async () => {
    const created = await createShare();
    const later = NOW.getTime() + WORKFLOW_SHARE_RETENTION_MS + 1;

    const removed = await runScheduledCleanup(database ?? undefined, later);

    expect(removed).toEqual({ shares: 1, rateLimits: 1 });
    expect((await getShare(created.id)).status).toBe(404);
  });
});
