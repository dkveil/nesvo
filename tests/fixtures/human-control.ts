// A real owner client for the native SDK fixture. No prompt or lease is printed.
import { readFile } from 'node:fs/promises';

import { HostClient, parsePairing } from '../../apps/mobile/src/shared/api/host/client';

const [pairingPath, sessionId] = process.argv.slice(2);
if (!pairingPath || !sessionId) throw new Error('Missing isolated human fixture arguments');
const client = new HostClient();
let deadline = setTimeout(() => {
  console.error('HUMAN_CONTROL_ACQUIRE_TIMEOUT');
  finish(1);
}, 10000);
function finish(code: number): never {
  clearTimeout(deadline);
  client.disconnect();
  process.stdin.pause();
  // The host acknowledgement is the behavioral boundary under test. Do not
  // leave this owned helper alive waiting for an unrelated WS close handshake.
  process.exit(code);
}
let ready = false;
let releasing = false;
let hostOwnsLease = false;
client.subscribe(event => {
  if (event.type === 'connected') client.acquireControl(sessionId, 80, 24);
  if (event.type === 'control' && event.sessionId === sessionId) {
    hostOwnsLease = Boolean(event.leaseId);
  }
  if (event.type === 'control' && event.sessionId === sessionId && event.leaseId && !ready) {
    ready = true;
    clearTimeout(deadline);
    if (process.argv.includes('--draft')) client.sendInput(sessionId, 'CONTROLLED_HUMAN_DRAFT');
    console.log('HUMAN_CONTROL_READY');
  }
  if (event.type === 'control' && event.sessionId === sessionId && releasing && !event.leaseId) {
    finish(0);
  }
  if (event.type === 'error') {
    console.error('HUMAN_CONTROL_HOST_ERROR');
    finish(1);
  }
});
process.stdin.resume();
process.stdin.once('end', () => {
  clearTimeout(deadline);
  if (ready && !hostOwnsLease) finish(0); // Host already revoked/released our lease.
  releasing = true;
  deadline = setTimeout(() => {
    console.error('HUMAN_CONTROL_RELEASE_NOT_ACKNOWLEDGED');
    finish(1);
  }, 5000);
  client.releaseControl(sessionId);
});
void readFile(pairingPath, 'utf8')
  .then(raw => client.connect(parsePairing(raw)))
  .catch(() => {
    console.error('HUMAN_CONTROL_PAIRING_UNAVAILABLE');
    finish(1);
  });
