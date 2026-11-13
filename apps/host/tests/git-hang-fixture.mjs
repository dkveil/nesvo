import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const descendant = spawn(
  process.execPath,
  ['-e', 'setInterval(() => undefined, 60_000)'],
  { stdio: 'ignore' },
);
writeFileSync(
  join(process.cwd(), 'git-stand-in.json'),
  JSON.stringify({
    pid: process.pid,
    descendant: descendant.pid,
    args: process.argv.slice(2),
    environment: Object.keys(process.env),
    terminalPrompt: process.env.GIT_TERMINAL_PROMPT ?? null,
  }),
);
setInterval(() => undefined, 60_000);
