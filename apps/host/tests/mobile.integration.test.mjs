import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMobileGateway } from '../dist/mobile.js';

function bounded(operation, description, milliseconds = 7000) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function connection(url) {
  const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/v1/events`);
  const queued = [];
  const waiting = new Set();
  const closed = new Promise(resolve =>
    socket.addEventListener(
      'close',
      event => resolve({ code: event.code, reason: event.reason }),
      { once: true },
    ),
  );
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const waiter = [...waiting].find(value => value.match(message));
    if (waiter) {
      waiting.delete(waiter);
      waiter.resolve(message);
    } else queued.push(message);
  });
  await bounded(
    new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }),
    'Mobile WebSocket did not open',
  );
  return {
    socket,
    closed,
    send: value => socket.send(JSON.stringify(value)),
    async message(match) {
      const index = queued.findIndex(match);
      if (index >= 0) return queued.splice(index, 1)[0];
      const waiter = { match };
      try {
        return await bounded(
          new Promise(resolve => {
            waiter.resolve = resolve;
            waiting.add(waiter);
          }),
          'Mobile WebSocket response missing',
        );
      } finally {
        waiting.delete(waiter);
      }
    },
  };
}

async function eventStream(url, credentials) {
  const controller = new AbortController();
  const response = await fetch(new URL('/v1/events', url), {
    headers: {
      authorization: `Bearer ${credentials.token}`,
      'x-nesvo-server-id': credentials.serverId,
    },
    redirect: 'error',
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/x-ndjson/);
  const queued = [];
  const waiting = new Set();
  const decoder = new TextDecoder();
  const closed = (async () => {
    let pending = '';
    try {
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        assert.ok(pending.length <= 8 * 1024 * 1024);
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line);
          const waiter = [...waiting].find(value => value.match(message));
          if (waiter) {
            waiting.delete(waiter);
            waiter.resolve(message);
          } else queued.push(message);
        }
      }
    } catch (error) {
      if (!(controller.signal.aborted || error instanceof TypeError))
        throw error;
    }
  })();
  closed.catch(() => {});
  return {
    close: () => controller.abort(),
    closed,
    async message(match) {
      const index = queued.findIndex(match);
      if (index >= 0) return queued.splice(index, 1)[0];
      const waiter = { match };
      try {
        return await bounded(
          new Promise(resolve => {
            waiter.resolve = resolve;
            waiting.add(waiter);
          }),
          'Mobile HTTP event stream response missing',
        );
      } finally {
        waiting.delete(waiter);
      }
    },
  };
}

test(
  'mobile gateway authenticates, restricts commands and durably revokes paired devices',
  { timeout: 30_000 },
  async t => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'nesvo-mobile-boundary-')),
    );
    let gateway;
    let mutationCalls = 0;
    let sessionReads = 0;
    const listeners = new Set();
    const sockets = [];
    const streams = [];
    const remoteId = randomUUID();
    const instanceId = randomUUID();
    const workspace = {
      listComputers: async () => [
        {
          id: 'local',
          name: 'Local boundary fixture',
          kind: 'local',
          status: 'connected',
          instanceId,
          lastSyncedAt: null,
          error: null,
        },
        {
          id: remoteId,
          name: 'Remote boundary fixture',
          kind: 'ssh',
          status: 'disconnected',
          instanceId: null,
          lastSyncedAt: null,
          error: null,
          ssh: {
            name: 'Remote boundary fixture',
            hostname: 'private.example.invalid',
            port: 22,
            identityFile: '/private/fixture-key',
            entryPath: '/private/entry.mjs',
            runtimeDirectory: '/private/runtime',
          },
        },
      ],
      listSessions: async () => {
        sessionReads++;
        return [];
      },
      subscribe: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      ...Object.fromEntries(
        ['sendMessage', 'stopRun', 'respondApproval', 'decideDelegation'].map(
          method => [
            method,
            async () => {
              mutationCalls++;
              throw new Error('An unauthorized mutation reached the workspace');
            },
          ],
        ),
      ),
    };
    const open = async () => {
      gateway = await createMobileGateway({ directory, workspace });
      await gateway.start();
      return await gateway.status();
    };
    t.after(async () => {
      for (const stream of streams) stream.close();
      for (const peer of sockets)
        if (peer.socket.readyState < WebSocket.CLOSING) peer.socket.close();
      await gateway?.stop();
      assert.equal(await realpath(directory), directory);
      await rm(directory, { recursive: true, force: true });
    });
    let status = await open();
    assert.equal(status.enabled, true);
    assert.equal(new URL(status.url).hostname, '127.0.0.1');
    const readsBeforeAuthentication = sessionReads;
    const request = async (path, { token, body, headers = {} } = {}) => {
      const response = await fetch(new URL(path, status.url), {
        method: body ? 'POST' : 'GET',
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, body: await response.json() };
    };
    const health = await request('/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, {
      serverId: status.serverId,
      protocolVersion: 1,
    });
    assert.equal((await request('/v1/snapshot')).status, 401);
    assert.equal(sessionReads, readsBeforeAuthentication);
    const pairing = await gateway.createPairing();
    const parameters = new URLSearchParams(new URL(pairing.link).hash.slice(1));
    const secret = parameters.get('secret');
    assert.equal(
      typeof secret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(secret),
      true,
    );
    assert.equal(parameters.get('serverId'), status.serverId);
    assert.equal(
      (
        await request('/v1/pair', {
          body: { serverId: randomUUID(), secret, name: 'Wrong server' },
        })
      ).status,
      401,
    );
    const paired = await request('/v1/pair', {
      body: { serverId: status.serverId, secret, name: 'Boundary device' },
    });
    assert.ok(paired.status >= 200 && paired.status < 300);
    const credentials = paired.body;
    assert.equal(credentials.serverId, status.serverId);
    assert.equal(
      typeof credentials.token === 'string' &&
        /^[A-Za-z0-9_-]{43}$/.test(credentials.token),
      true,
    );
    assert.equal(
      (
        await request('/v1/pair', {
          body: { serverId: status.serverId, secret, name: 'Duplicate device' },
        })
      ).status,
      401,
    );
    assert.equal((await gateway.status()).devices.length, 1);
    assert.equal(
      (
        await request('/v1/snapshot', {
          token: randomBytes(32).toString('base64url'),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request('/v1/snapshot', {
          token: credentials.token,
          headers: { origin: 'https://foreign.example.invalid' },
        })
      ).status,
      403,
    );
    assert.equal(sessionReads, readsBeforeAuthentication);
    for (const headers of [{}, { 'x-nesvo-server-id': randomUUID() }]) {
      const response = await request('/v1/events', {
        token: credentials.token,
        headers,
      });
      assert.equal(response.status, 401);
      assert.equal(response.body.code, 'server-mismatch');
    }
    const badStream = await request('/v1/events', {
      token: randomBytes(32).toString('base64url'),
      headers: { 'x-nesvo-server-id': status.serverId },
    });
    assert.equal(badStream.status, 401);
    assert.equal(badStream.body.code, 'unauthorized');
    assert.equal(sessionReads, readsBeforeAuthentication);
    for (const method of [
      'create-session',
      'read-workspace-file',
      'provider-usage',
    ]) {
      const response = await request('/v1/command', {
        token: credentials.token,
        body: { id: randomUUID(), hostId: 'local', method, input: {} },
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'invalid-request');
    }
    const command = {
      id: randomUUID(),
      hostId: 'local',
      method: 'send-message',
      input: {
        sessionId: randomUUID(),
        messageId: randomUUID(),
        text: 'A forbidden unauthenticated request',
      },
    };
    assert.equal((await request('/v1/command', { body: command })).status, 401);
    assert.equal(
      (
        await request('/v1/command', {
          token: credentials.token,
          body: {
            ...command,
            input: { ...command.input, skillId: 'unapproved-skill' },
          },
        })
      ).status,
      400,
    );
    assert.equal(mutationCalls, 0);
    const snapshot = await request('/v1/snapshot', {
      token: credentials.token,
    });
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.serverId, status.serverId);
    assert.deepEqual(snapshot.body.sessions, []);
    assert.equal(snapshot.body.computers.length, 2);
    assert.equal(
      snapshot.body.computers.some(
        computer => 'ssh' in computer || 'instanceId' in computer,
      ),
      false,
    );
    assert.equal(
      JSON.stringify(snapshot.body).includes('/private/fixture-key'),
      false,
    );
    const savedText = await readFile(join(directory, 'pairing.json'), 'utf8');
    assert.equal(savedText.includes(secret), false);
    assert.equal(savedText.includes(credentials.token), false);
    assert.equal(
      JSON.parse(savedText).devices[0].tokenHash,
      createHash('sha256').update(credentials.token).digest('hex'),
    );
    const peer = await connection(status.url);
    sockets.push(peer);
    peer.send({
      type: 'authenticate',
      protocolVersion: 1,
      serverId: status.serverId,
      token: credentials.token,
    });
    const initial = await peer.message(value => value.type === 'snapshot');
    assert.equal(initial.serverId, status.serverId);
    const http = await eventStream(status.url, credentials);
    streams.push(http);
    const httpSnapshot = await http.message(value => value.type === 'snapshot');
    assert.equal(httpSnapshot.serverId, status.serverId);
    assert.deepEqual(httpSnapshot.sessions, []);
    for (const listener of listeners)
      listener({ type: 'host-disconnected', hostId: 'local' });
    const changed = await peer.message(
      value => value.type === 'host-disconnected',
    );
    assert.equal(changed.hostId, 'local');
    assert.ok(changed.sequence > initial.sequence);
    const httpChanged = await http.message(
      value => value.type === 'host-disconnected',
    );
    assert.deepEqual(httpChanged, changed);
    const unauthenticated = await connection(status.url);
    sockets.push(unauthenticated);
    assert.notEqual(
      (
        await bounded(
          unauthenticated.closed,
          'Unauthenticated WebSocket stayed open',
        )
      ).code,
      1000,
    );
    const serverId = status.serverId;
    await gateway.stop();
    await bounded(peer.closed, 'Gateway stop left its client connected');
    await bounded(http.closed, 'Gateway stop left its HTTP stream connected');
    status = await open();
    assert.equal(status.serverId, serverId);
    assert.equal(status.devices[0].id, credentials.deviceId);
    assert.equal(
      (await request('/v1/snapshot', { token: credentials.token })).status,
      200,
    );
    const resumed = await connection(status.url);
    sockets.push(resumed);
    resumed.send({
      type: 'authenticate',
      protocolVersion: 1,
      serverId,
      token: credentials.token,
    });
    await resumed.message(value => value.type === 'snapshot');
    const resumedHttp = await eventStream(status.url, credentials);
    streams.push(resumedHttp);
    await resumedHttp.message(value => value.type === 'snapshot');
    await gateway.revoke(credentials.deviceId);
    assert.equal(
      (await resumed.message(value => value.type === 'error')).code,
      'revoked',
    );
    assert.equal(
      (await bounded(resumed.closed, 'Revoked client stayed connected')).code,
      4001,
    );
    assert.equal(
      (await resumedHttp.message(value => value.type === 'error')).code,
      'revoked',
    );
    await bounded(resumedHttp.closed, 'Revoked HTTP stream stayed connected');
    assert.equal(
      (await request('/v1/snapshot', { token: credentials.token })).status,
      401,
    );
    await gateway.stop();
    status = await open();
    assert.equal(status.serverId, serverId);
    assert.deepEqual(status.devices, []);
    assert.equal(
      (await request('/v1/snapshot', { token: credentials.token })).status,
      401,
    );
    assert.equal(mutationCalls, 0);
    t.diagnostic(
      JSON.stringify({
        serverId,
        deviceId: credentials.deviceId,
        pairingOneUse: true,
        privateTokenHash: true,
        forbiddenCommandsRejected: true,
        durableRevocation: true,
        authenticatedHttpStream: true,
      }),
    );
  },
);
