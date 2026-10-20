// A real owner client for the native SDK fixture. No prompt or lease is printed.
import { readFile } from 'node:fs/promises';

import { HostClient, parsePairing } from '../../apps/mobile/src/shared/api/host/client';

const [pairingPath, sessionId] = process.argv.slice(2);
if (!pairingPath || !sessionId) throw new Error('Missing isolated human fixture arguments');
const client = new HostClient();
const deadline = setTimeout(() => {
  client.disconnect();
  process.stdin.pause();
  process.exitCode = 1;
}, 10000);
let ready = false;
client.subscribe(event => {
  if (event.type === 'connected') client.acquireControl(sessionId, 80, 24);
  if (event.type === 'control' && event.sessionId === sessionId && event.leaseId && !ready) {
    ready = true;
    clearTimeout(deadline);
    if (process.argv.includes('--draft')) client.sendInput(sessionId, 'CONTROLLED_HUMAN_DRAFT');
    console.log('HUMAN_CONTROL_READY');
  }
  if (event.type === 'error') {
    clearTimeout(deadline);
    client.disconnect();
    process.stdin.pause();
    process.exitCode = 1;
  }
});
process.stdin.resume();
process.stdin.once('end', () => {
  clearTimeout(deadline);
  client.releaseControl(sessionId);
  client.disconnect();
});
void readFile(pairingPath, 'utf8')
  .then(raw => client.connect(parsePairing(raw)))
  .catch(() => {
    clearTimeout(deadline);
    client.disconnect();
    process.stdin.pause();
    process.exitCode = 1;
  });
