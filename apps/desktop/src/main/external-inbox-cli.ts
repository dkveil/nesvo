import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { InboxCliInstallation } from '@nesvo/contracts';

const quotePowerShell = (value: string) => `'${value.replaceAll("'", "''")}'`;
const quoteShell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function inboxCliInstallation(): InboxCliInstallation | null {
  const directory = app.isPackaged
    ? join(process.resourcesPath, 'inbox-cli')
    : join(app.getAppPath(), 'dist', 'inbox-cli');
  const runtimePath = process.execPath;
  const entryPath = join(directory, 'cli.mjs');
  const windows = process.platform === 'win32';
  const launcher = join(directory, windows ? 'nesvo.cmd' : 'nesvo');
  if (!existsSync(entryPath) || !existsSync(launcher)) return null;

  const command = windows
    ? `$env:Path = ${quotePowerShell(directory + ';')} + $env:Path`
    : `export PATH=${quoteShell(directory)}:"$PATH"`;
  const developmentRuntime = windows
    ? `$env:NESVO_INBOX_CLI_RUNTIME = ${quotePowerShell(runtimePath)}`
    : `export NESVO_INBOX_CLI_RUNTIME=${quoteShell(runtimePath)}`;
  const addToPathCommand = app.isPackaged
    ? command
    : `${developmentRuntime}\n${command}`;
  return { runtimePath, entryPath, addToPathCommand };
}
