import { createInterface } from 'node:readline';
import { Effect } from 'effect';
import { serveHost } from './host';
import { runDaemon } from './daemon';
import { connectDaemon } from './daemon-bridge';

async function main() {
  const command = process.argv[2];
  if (command === 'daemon' || command === 'connect') {
    const runtimeDirectory = process.env.NESVO_RUNTIME_DIR;
    if (!runtimeDirectory)
      throw new Error('Set NESVO_RUNTIME_DIR to a private runtime directory.');
    if (command === 'connect') {
      await connectDaemon(
        runtimeDirectory,
        process.env.NESVO_EXPECTED_INSTANCE_ID,
      );
      return;
    }
    const directory = process.env.NESVO_DATA_DIR;
    if (!directory)
      throw new Error('Set NESVO_DATA_DIR to the host data directory.');
    await runDaemon(directory, runtimeDirectory, health => {
      console.log(JSON.stringify({ type: 'daemon-ready', health }));
    });
    return;
  }
  if (command)
    throw new Error(
      'Supported commands: daemon, connect, or no command for an owned stdio host.',
    );
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
}

await main().catch(error => {
  console.error(
    error instanceof Error ? error.message : 'The host could not start.',
  );
  process.exitCode = 1;
});
