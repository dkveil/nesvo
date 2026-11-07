import { on } from 'node:events';
import { runHost } from '@nesvo/host';

const port = process.parentPort;
const directory = process.env.NESVO_DATA_DIR;
if (!port || !directory)
  throw new Error('Host requires a parent port and data directory');

async function* incoming() {
  for await (const [event] of on(port, 'message')) {
    yield (event as { data: unknown }).data;
  }
}

await runHost({
  directory,
  incoming: incoming(),
  send: async response => {
    port.postMessage(response);
  },
}).then(
  () => process.exit(0),
  () => {
    console.error('Nesvo host failed');
    process.exit(1);
  },
);
