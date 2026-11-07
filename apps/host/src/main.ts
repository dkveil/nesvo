import { createInterface } from 'node:readline';
import { Effect } from 'effect';
import { serveHost } from './host';

const directory = process.env.NESVO_DATA_DIR;
if (!directory)
  throw new Error('Set NESVO_DATA_DIR to the host data directory');

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
async function* incoming() {
  try {
    for await (const line of lines) {
      try {
        yield JSON.parse(line) as unknown;
      } catch {
        yield null;
      }
    }
  } finally {
    lines.close();
    process.stdin.pause();
  }
}

await Effect.runPromise(
  serveHost({
    directory,
    incoming: incoming(),
    send: response =>
      new Promise((resolve, reject) => {
        process.stdout.write(JSON.stringify(response) + '\n', error =>
          error ? reject(error) : resolve(),
        );
      }),
  }),
).catch(() => {
  console.error('Nesvo host failed to start or stopped unexpectedly');
  process.exitCode = 1;
  lines.close();
  process.stdin.pause();
});
