import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { platform } from 'node:os';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const defaultOs = () => (platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'macos' : 'linux');

export const parseArgs = (argv) => {
  const options = { os: defaultOs(), timeoutMs: 180000 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--os') options.os = argv[++i];
    if (argv[i] === '--timeout-ms') options.timeoutMs = Number(argv[++i]);
  }
  return options;
};

export const fixturePath = (provider, os, name) =>
  resolve(repoRoot, 'tests', 'fixtures', 'structured', provider, os, name);

export const createRecorder = () => {
  const startedAt = Date.now();
  const entries = [];
  return {
    record: (dir, payload) => entries.push({ dir, ms: Date.now() - startedAt, msg: payload }),
    save: (file) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    },
    entries,
  };
};

export const spawnJsonLines = (command, args, { cwd, onMessage, onExit }) => {
  const child = spawn(command, args, { cwd, shell: platform() === 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  const stderrChunks = [];
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString()));
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = { unparsed: line };
    }
    onMessage(parsed);
  });
  child.on('exit', (code) => onExit?.(code));
  const send = (payload) => child.stdin.write(JSON.stringify(payload) + '\n');
  return { child, send, stderr: () => stderrChunks.join('') };
};

export const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms)),
  ]);

export const killTree = (child) => {
  if (platform() === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f']);
  else child.kill('SIGKILL');
};
