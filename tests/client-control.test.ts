import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { HostClient, type HostEvent } from '../apps/mobile/src/shared/api/host/client';
import type { ClientCommand } from '../apps/mobile/src/shared/api/host/types';
import { decodeFrame, encodeFrame } from '../apps/mobile/src/shared/api/host/wire';

class FakeWebSocket {
  static latest: FakeWebSocket;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
  onerror?: () => void;

  constructor() {
    FakeWebSocket.latest = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }
  receive(data: string) {
    this.onmessage?.({ data });
  }
}

function fixture() {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const client = new HostClient();
  const events: HostEvent[] = [];
  client.subscribe(event => events.push(event));
  const key = new Uint8Array(32).fill(9);
  const challenge = 'a'.repeat(64);
  const pairing = {
    version: 1 as const,
    url: 'ws://localhost:9999',
    key: Buffer.from(key).toString('hex'),
  };

  function connect(clientId = 1) {
    client.connect(pairing);
    const socket = FakeWebSocket.latest;
    socket.receive(JSON.stringify({ type: 'challenge', version: 1, challenge }));
    const authFrame = socket.sent[0];
    assert.ok(authFrame);
    const auth = decodeFrame(authFrame, key, challenge, 'client-to-host', 1) as {
      type: string;
      clientNonce: string;
    };
    assert.equal(auth.type, 'auth');
    let hostSeq = 0;
    function receive(payload: unknown) {
      socket.receive(
        encodeFrame(payload, key, challenge, 'host-to-client', ++hostSeq, randomBytes),
      );
    }
    receive({ type: 'connected', protocolVersion: 2, clientNonce: auth.clientNonce, clientId });
    assert.equal(client.clientId, clientId);
    assert.equal(client.isConnected, true);
    function commands(): ClientCommand[] {
      return socket.sent.map(
        (frame, index) =>
          decodeFrame(frame, key, challenge, 'client-to-host', index + 1) as ClientCommand,
      );
    }
    return { socket, receive, commands };
  }
  return {
    client,
    events,
    connect,
    cleanup() {
      client.disconnect();
      globalThis.WebSocket = originalWebSocket;
    },
  };
}

const owned = (leaseId = 'lease-a') => ({
  type: 'control',
  sessionId: 'session-a',
  controllerId: 1,
  leaseId,
  cols: 80,
  rows: 24,
});

test('launch selection stays on the host and preserves path and creation correlation', () => {
  const f = fixture();
  try {
    const peer = f.connect();
    const cwd = 'C:\\projects\\My project & tools';
    const requestId = f.client.createSession('Review', 'group-a', 'create-a', {
      cwd,
      program: 'codex',
    });
    assert.equal(requestId, 'create-a');
    assert.deepEqual(peer.commands().at(-1), {
      type: 'create',
      name: 'Review',
      groupId: 'group-a',
      requestId: 'create-a',
      cwd,
      program: 'codex',
    });
    f.client.createSession('Shell', null, 'create-b');
    assert.deepEqual(peer.commands().at(-1), {
      type: 'create',
      name: 'Shell',
      groupId: null,
      requestId: 'create-b',
    });
  } finally {
    f.cleanup();
  }
});

test('passive viewers never send input or resize; acquisition clamps the requested PTY grid', () => {
  const f = fixture();
  try {
    const peer = f.connect();
    peer.receive({ type: 'subscribed', sessionId: 'session-a', cols: 80, rows: 24 });
    peer.receive({ type: 'control', sessionId: 'session-a', controllerId: 2, cols: 80, rows: 24 });
    f.client.sendInput('session-a', 'echo PASSIVE\r');
    f.client.resizeSession('session-a', 40, 10);
    assert.deepEqual(
      peer.commands().map(command => command.type),
      ['auth', 'getCapabilities'],
    );
    assert.equal(f.client.hasControl('session-a'), false);
    f.client.acquireControl('session-a', 999.9, -10, true);
    assert.deepEqual(peer.commands().at(-1), {
      type: 'acquireControl',
      sessionId: 'session-a',
      cols: 300,
      rows: 2,
      takeOver: true,
    });
    f.client.sendInput('session-a', 'NOT_YET\r');
    assert.equal(peer.commands().length, 3, 'Requesting control alone never grants permission');
    f.client.acquireControl('session-a', 0, 999);
    assert.deepEqual(peer.commands().at(-1), {
      type: 'acquireControl',
      sessionId: 'session-a',
      cols: 10,
      rows: 150,
      takeOver: false,
    });
  } finally {
    f.cleanup();
  }
});

test('a granted lease accompanies input and resize and is replaced on reacquisition', () => {
  const f = fixture();
  try {
    const peer = f.connect();
    peer.receive(owned());
    assert.equal(f.client.hasControl('session-a'), true);
    f.client.sendInput('session-a', 'echo CONTROLLED\r');
    assert.deepEqual(peer.commands().at(-1), {
      type: 'input',
      sessionId: 'session-a',
      data: 'echo CONTROLLED\r',
      leaseId: 'lease-a',
    });
    f.client.resizeSession('session-a', 45.9, 20.9);
    assert.deepEqual(peer.commands().at(-1), {
      type: 'resize',
      sessionId: 'session-a',
      cols: 45,
      rows: 20,
      leaseId: 'lease-a',
    });
    peer.receive(owned('lease-b'));
    f.client.sendInput('session-a', 'NEW_LEASE\r');
    assert.deepEqual(peer.commands().at(-1), {
      type: 'input',
      sessionId: 'session-a',
      data: 'NEW_LEASE\r',
      leaseId: 'lease-b',
    });
    const count = peer.commands().length;
    f.client.sendInput('other-session', 'WRONG_SESSION\r');
    assert.equal(peer.commands().length, count, 'A lease is scoped to its session');
  } finally {
    f.cleanup();
  }
});

test('takeover, a null controller and disconnect each revoke permission immediately', () => {
  const f = fixture();
  try {
    const peer = f.connect();
    for (const controllerId of [2, null]) {
      peer.receive(owned());
      peer.receive({ type: 'control', sessionId: 'session-a', controllerId, cols: 100, rows: 30 });
      assert.equal(f.client.hasControl('session-a'), false);
      assert.equal(f.client.getControl('session-a')?.leaseId, undefined);
      const count = peer.commands().length;
      f.client.sendInput('session-a', 'STALE\r');
      f.client.resizeSession('session-a', 40, 10);
      assert.equal(peer.commands().length, count);
    }
    peer.receive(owned());
    peer.socket.close();
    assert.equal(f.client.isConnected, false);
    assert.equal(f.client.clientId, null);
    assert.equal(f.client.getControl('session-a'), undefined);
    const count = peer.commands().length;
    f.client.sendInput('session-a', 'OFFLINE\r');
    f.client.resizeSession('session-a', 40, 10);
    assert.equal(peer.commands().length, count);
  } finally {
    f.cleanup();
  }
});

test('leaving a session releases its lease before unsubscribe and blocks queued renderer input', () => {
  const f = fixture();
  try {
    const peer = f.connect();
    peer.receive(owned());
    f.client.unsubscribeSession('session-a');
    assert.deepEqual(peer.commands().slice(2), [
      { type: 'releaseControl', sessionId: 'session-a', leaseId: 'lease-a' },
      { type: 'unsubscribe', sessionId: 'session-a' },
    ]);
    assert.equal(
      f.client.hasControl('session-a'),
      false,
      'No server round trip is needed to revoke local permission',
    );
    f.client.sendInput('session-a', 'AFTER_LEAVE\r');
    f.client.resizeSession('session-a', 40, 10);
    assert.equal(peer.commands().length, 4);
  } finally {
    f.cleanup();
  }
});

test('late messages, errors and close callbacks from the old socket are ignored after reconnect', () => {
  const f = fixture();
  try {
    const old = f.connect();
    old.receive(owned('old-lease'));
    const current = f.connect(3);
    assert.equal(f.client.hasControl('session-a'), false);
    f.events.length = 0;
    old.receive(owned('late-old-lease'));
    old.receive({ type: 'output', sessionId: 'session-a', data: 'STALE OUTPUT' });
    old.socket.onerror?.();
    old.socket.onclose?.({ code: 4003, reason: 'old disconnect' });
    assert.deepEqual(f.events, []);
    assert.equal(f.client.clientId, 3);
    assert.equal(f.client.isConnected, true);
    assert.equal(f.client.getControl('session-a'), undefined);
    assert.equal(current.commands().length, 2);
    current.receive({ ...owned('new-lease'), controllerId: 3 });
    f.client.sendInput('session-a', 'CURRENT\r');
    assert.deepEqual(current.commands().at(-1), {
      type: 'input',
      sessionId: 'session-a',
      data: 'CURRENT\r',
      leaseId: 'new-lease',
    });
  } finally {
    f.cleanup();
  }
});

for (const [label, malformed] of [
  ['invalid dimensions', { ...owned('malformed-lease'), cols: '80' }],
  ['lease belonging to another client', { ...owned('foreign-lease'), controllerId: 2 }],
  ['invalid snapshot', { type: 'sessions', sessions: [], groups: null, revision: 1 }],
] as const) {
  test(`malformed host event (${label}) closes the connection before mutation or dispatch`, () => {
    const f = fixture();
    try {
      const peer = f.connect();
      peer.receive(owned('prior-valid-lease'));
      const priorControl = f.client.getControl('session-a');
      let controlAtError: unknown;
      f.client.subscribe(event => {
        if (event.type === 'error') controlAtError = f.client.getControl('session-a');
      });
      f.events.length = 0;
      peer.receive(malformed);
      assert.equal(controlAtError, priorControl, 'Invalid data must not replace the valid lease');
      assert.deepEqual(
        f.events.map(event => event.type),
        ['error', 'disconnected'],
      );
      assert.equal(peer.socket.readyState, 3);
      assert.equal(f.client.isConnected, false);
      assert.equal(
        f.client.getControl('session-a'),
        undefined,
        'Disconnect clears even previously valid permission',
      );
    } finally {
      f.cleanup();
    }
  });
}
