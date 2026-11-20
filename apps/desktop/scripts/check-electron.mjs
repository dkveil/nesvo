import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

try {
  let electronPath = process.env.ELECTRON_EXEC_PATH;
  if (!electronPath) {
    const require = createRequire(import.meta.url);
    const directory = dirname(require.resolve('electron'));
    const executable = readFileSync(join(directory, 'path.txt'), 'utf8');
    electronPath = join(directory, 'dist', executable);
  }
  if (!statSync(electronPath).isFile()) throw new Error('Expected a file');
  accessSync(electronPath, constants.X_OK);
} catch {
  console.error(
    'Electron executable is unavailable. From the repository root, run ' +
      '`bun install --frozen-lockfile` if dependencies are missing, then ' +
      '`node node_modules/electron/install.js` before retrying `bun run dev`. ' +
      'If ELECTRON_EXEC_PATH is set, check that it points to the Electron executable.',
  );
  process.exitCode = 1;
}
