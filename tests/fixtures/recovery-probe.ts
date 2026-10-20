// Read raw native recovery metadata without a UI projection dropping new fields.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';

import {
  decodeFrame,
  encodeFrame,
  keyBytes,
  parsePairing,
} from '../../apps/mobile/src/shared/api/host/wire';

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('Missing isolated recovery pairing path');
  const pairing = parsePairing(await readFile(path, 'utf8'));
  const key = keyBytes(pairing.key);
  const nonce = randomBytes(32).toString('hex');
  const socket = new WebSocket(pairing.url);
  let challenge = '';
  let incoming = 0;
  let outgoing = 0;
  const deadline = setTimeout(() => {
    console.error('Recovery probe deadline');
    socket.terminate();
    process.exitCode = 1;
  }, 8000);
  const fail = () => {
    clearTimeout(deadline);
    console.error('Recovery probe protocol failed');
    socket.terminate();
    process.exitCode = 1;
  };
  function send(payload: object) {
    socket.send(encodeFrame(payload, key, challenge, 'client-to-host', ++outgoing, randomBytes));
  }
  socket.on('error', fail);
  socket.on('message', bytes => {
    try {
      if (!challenge) {
        const hello: unknown = JSON.parse(bytes.toString());
        if (
          !hello ||
          typeof hello !== 'object' ||
          !('challenge' in hello) ||
          typeof hello.challenge !== 'string' ||
          !('type' in hello) ||
          hello.type !== 'challenge' ||
          !('version' in hello) ||
          hello.version !== 1 ||
          !/^[a-f0-9]{64}$/.test(hello.challenge)
        )
          throw new Error('Invalid challenge');
        challenge = hello.challenge;
        send({ type: 'auth', clientNonce: nonce });
        return;
      }
      const message: unknown = decodeFrame(
        bytes.toString(),
        key,
        challenge,
        'host-to-client',
        ++incoming,
      );
      if (!message || typeof message !== 'object' || !('type' in message))
        throw new Error('Invalid event');
      if (message.type === 'connected') {
        if (
          !('clientNonce' in message) ||
          message.clientNonce !== nonce ||
          !('protocolVersion' in message) ||
          message.protocolVersion !== 2
        )
          throw new Error('Invalid host proof');
        send({ type: 'listRecovery', requestId: 'owned-recovery-probe' });
      }
      if (
        message.type === 'recovery' &&
        'requestId' in message &&
        message.requestId === 'owned-recovery-probe'
      ) {
        if (
          !('records' in message) ||
          !Array.isArray(message.records) ||
          ('nextOffset' in message && message.nextOffset !== null)
        )
          throw new Error('Expected one bounded recovery page');
        clearTimeout(deadline);
        process.stdout.write(JSON.stringify(message.records), () => socket.terminate());
      }
      if (message.type === 'error') throw new Error('Host refused recovery read');
    } catch {
      fail();
    }
  });
}
void main().catch(() => {
  console.error('Recovery probe initialization failed');
  process.exitCode = 1;
});
