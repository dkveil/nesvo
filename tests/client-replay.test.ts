import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { HostClient, type HostEvent } from '../src/connection/client';
import { decodeFrame, encodeFrame } from '../src/connection/wire';

class FakeWebSocket {
  static latest: FakeWebSocket;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number; reason: string }) => void;

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

test('host authentication rejects a complete recorded handshake after reconnect', () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const client = new HostClient();
  const events: HostEvent[] = [];
  client.subscribe((event) => events.push(event));
  const key = new Uint8Array(32).fill(7);
  const challenge = 'c'.repeat(64);
  const pairing = { version: 1 as const, url: 'ws://localhost:9999', key: Buffer.from(key).toString('hex') };
  const hello = JSON.stringify({ type: 'challenge', version: 1, challenge });

  try {
    client.connect(pairing);
    const original = FakeWebSocket.latest;
    original.receive(hello);
    const auth = decodeFrame(original.sent[0], key, challenge, 'client-to-host', 1) as { type: string; clientNonce: string };
    assert.equal(auth.type, 'auth');
    assert.match(auth.clientNonce, /^[a-f0-9]{64}$/);
    const recordedResponse = encodeFrame(
      { type: 'connected', clientNonce: auth.clientNonce }, key, challenge, 'host-to-client', 1, randomBytes,
    );
    const recordedOutput = encodeFrame(
      { type: 'output', sessionId: 'prior-session', data: 'OLD RESPONSE' }, key, challenge, 'host-to-client', 2, randomBytes,
    );
    original.receive(recordedResponse);
    assert.deepEqual(events, [{ type: 'connected' }], 'Protocol nonce must not enter the UI event');
    client.disconnect();
    events.length = 0;

    client.connect(pairing);
    const replay = FakeWebSocket.latest;
    replay.receive(hello);
    const nextAuth = decodeFrame(replay.sent[0], key, challenge, 'client-to-host', 1) as { clientNonce: string };
    assert.notEqual(nextAuth.clientNonce, auth.clientNonce, 'Every connection needs fresh client entropy');
    replay.receive(recordedResponse);
    replay.receive(recordedOutput);
    assert.equal(replay.readyState, 3);
    assert.ok(events.some((event) => event.type === 'error'));
    assert.ok(!events.some((event) => event.type === 'connected' || event.type === 'output'));
  } finally {
    client.disconnect();
    globalThis.WebSocket = originalWebSocket;
  }
});
