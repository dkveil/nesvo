// Owned loopback webhook sender. Secrets enter only through stdin and are never
// returned, put in URLs/argv, or sent to anything outside the isolated host.
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const base = new URL(input.address);
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.pathname !== '/')
  throw new Error('Only the owned loopback listener is allowed');
if (!Array.isArray(input.requests) || input.requests.length < 1 || input.requests.length > 8)
  throw new Error('Bounded request batch required');
function request(spec) {
  if (!/^[0-9a-f]{32}$/.test(spec.triggerId) || !/^[0-9a-f]{64}$/.test(spec.secret))
    throw new Error('Owned trigger and credential required');
  const body = Buffer.from(spec.body, 'utf8');
  const signedBody = Buffer.from(spec.signedBody ?? spec.body, 'utf8');
  if (body.length > 262144) throw new Error('Fixture body exceeds ingress bound');
  const signature = crypto.createHmac('sha256', spec.secret).update(signedBody).digest('hex');
  const generic = spec.adapter === 'webhook';
  const headers = {
    'content-type': 'application/json',
    'content-length': body.length,
    connection: 'close',
    [generic ? 'x-nesvo-delivery' : 'x-github-delivery']: spec.deliveryId,
    [generic ? 'x-nesvo-event' : 'x-github-event']: spec.event,
    [generic ? 'x-nesvo-signature-256' : 'x-hub-signature-256']:
      'sha256=' + (spec.invalidSignature ? '0'.repeat(64) : signature),
  };
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL('/v1/job-triggers/' + spec.triggerId, base),
      { method: 'POST', headers, agent: false },
      response => {
        const parts = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 16384) response.destroy(new Error('Bounded response exceeded'));
          else parts.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode, envelope: JSON.parse(Buffer.concat(parts)) });
          } catch {
            reject(new Error('Expected bounded JSON webhook response'));
          }
        });
      },
    );
    req.setTimeout(5500, () => req.destroy(new Error('Owned HTTP request deadline')));
    req.on('error', reject);
    req.end(body);
  });
}
Promise.all(input.requests.map(request)).then(
  responses => process.stdout.write(JSON.stringify(responses)),
  () => {
    process.stderr.write('Owned loopback webhook request failed\n');
    process.exitCode = 1;
  },
);
