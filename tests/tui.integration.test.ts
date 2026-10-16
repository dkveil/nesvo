import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  HostClient,
  type HostEvent,
  parsePairing,
} from '../apps/mobile/src/shared/api/host/client';
import { decodeServerMessage } from '../apps/mobile/src/shared/api/host/messages';

type Snapshot = Extract<HostEvent, { type: 'sessions' }>;
type CommandResult = { code: number | null; stdout: string; stderr: string };

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
  timeout = 15000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error(`Timed out: ${label}`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // An executable that could not spawn has no process to stop.
  if (child.pid === undefined) return;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.kill();
  await exited;
}

function runTui(
  binary: string,
  pairingPath: string,
  running: Set<ChildProcess>,
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, ['--pairing', pairingPath, '--list'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.add(child);
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    const timeout = setTimeout(() => {
      failure = new Error('TUI --list did not exit within 20 seconds');
      child.kill();
    }, 20000);
    const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (stream === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();
      if (stdout.length + stderr.length > 2 * 1024 * 1024) {
        failure = new Error('TUI output exceeded the smoke test limit');
        child.kill();
      }
    };
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.once('error', error => {
      failure = error;
    });
    child.once('close', code => {
      clearTimeout(timeout);
      running.delete(child);
      if (failure) reject(failure);
      else resolveResult({ code, stdout, stderr });
    });
  });
}

function assertNoSecret(result: CommandResult, secrets: string[]): void {
  const output = result.stdout + result.stderr;
  for (const secret of secrets) {
    // Never include the secret itself in an assertion's diagnostic output.
    assert.equal(output.includes(secret), false, 'TUI must not print a pairing key');
  }
}

test(
  'native TUI shares the mobile client snapshot and rejects invalid pairing',
  { timeout: 90000 },
  async suite => {
    const temporaryRoot = resolve(tmpdir());
    const fixture = await mkdtemp(join(temporaryRoot, 'nesvo-tui-'));
    await chmod(fixture, 0o700);
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const hostBinary =
      process.env.NESVO_HOST_BINARY || resolve('target/debug', `nesvo-host${suffix}`);
    const tuiBinary = process.env.NESVO_TUI_BINARY || resolve('target/debug', `nesvo${suffix}`);
    const pairingPath = join(fixture, 'pairing.json');
    const host = spawn(
      hostBinary,
      ['--port', '0', '--pairing-dir', fixture, '--workspace', fixture],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let hostOutput = '';
    let hostError: Error | undefined;
    host.stdout.on('data', (chunk: Buffer) => {
      hostOutput = (hostOutput + chunk.toString()).slice(-32768);
    });
    host.stderr.on('data', () => {});
    host.on('error', error => {
      hostError = error;
    });

    const client = new HostClient();
    const events: HostEvent[] = [];
    const runningTuis = new Set<ChildProcess>();
    const unsubscribe = client.subscribe(event => events.push(event));

    async function next<T extends HostEvent['type']>(
      type: T,
      predicate: (event: Extract<HostEvent, { type: T }>) => boolean = () => true,
    ): Promise<Extract<HostEvent, { type: T }>> {
      return until(() => {
        const error = events.find(event => event.type === 'error');
        if (error?.type === 'error') throw new Error(error.message);
        const index = events.findIndex(
          event => event.type === type && predicate(event as Extract<HostEvent, { type: T }>),
        );
        if (index >= 0) return events.splice(index, 1)[0] as Extract<HostEvent, { type: T }>;
        const disconnected = events.find(event => event.type === 'disconnected');
        if (disconnected?.type === 'disconnected') throw new Error(disconnected.reason);
        return undefined;
      }, `mobile client event ${type}`);
    }

    async function snapshot(): Promise<Snapshot> {
      for (let index = events.length - 1; index >= 0; index--) {
        if (events[index]?.type === 'sessions') events.splice(index, 1);
      }
      client.listSessions();
      return next('sessions');
    }

    try {
      await until(() => {
        if (hostError) throw hostError;
        assert.equal(host.exitCode, null, 'Host must remain running during startup');
        return hostOutput.includes('host listening') || undefined;
      }, 'Rust host startup');
      const pairing = parsePairing(await readFile(pairingPath, 'utf8'));
      client.connect(pairing);
      assert.equal((await next('connected')).protocolVersion, 2);
      const empty = await next('sessions');
      assert.deepEqual(empty.sessions, []);
      assert.deepEqual(empty.groups, []);

      client.createGroup('TUI workspace', null, empty.revision);
      const parent = await next('groupCreated');
      client.createGroup('Shared subproject', parent.groupId, parent.revision);
      const child = await next('groupCreated');
      const requestId = client.createSession('Cross-client shell', child.groupId);
      const created = await next('created', event => event.requestId === requestId);
      const expected = await snapshot();
      assert.equal(
        expected.groups.find(group => group.id === child.groupId)?.parentId,
        parent.groupId,
      );
      assert.equal(
        expected.sessions.find(session => session.id === created.sessionId)?.groupId,
        child.groupId,
      );
      assert.equal(expected.sessions[0]?.running, true);

      await suite.test(
        'headless TUI returns identical authoritative IDs, hierarchy and revision',
        async () => {
          const result = await runTui(tuiBinary, pairingPath, runningTuis);
          assertNoSecret(result, [pairing.key]);
          assert.equal(result.code, 0, `TUI --list failed: ${result.stderr}`);
          assert.equal(result.stderr, '');
          const decoded = decodeServerMessage(JSON.parse(result.stdout) as unknown);
          assert.equal(decoded?.type, 'sessions', 'TUI output must be a valid protocol snapshot');
          assert.deepEqual(decoded, expected);
        },
      );

      await suite.test(
        'TUI exit preserves the running shell and does not acquire control',
        async () => {
          const afterExit = await snapshot();
          const session = afterExit.sessions.find(item => item.id === created.sessionId);
          assert.ok(session, 'The same host-issued session ID must remain after TUI exit');
          assert.equal(session.running, true);
          assert.equal(session.controllerId, null);
          assert.deepEqual(afterExit, expected);
        },
      );

      await suite.test(
        'a wrong pairing key fails without disclosing either key or changing sessions',
        async () => {
          const wrongKey = `${pairing.key.startsWith('0') ? '1' : '0'}${pairing.key.slice(1)}`;
          const invalidPath = join(fixture, 'invalid-pairing.json');
          await writeFile(invalidPath, JSON.stringify({ ...pairing, key: wrongKey }), {
            mode: 0o600,
          });
          const rejected = await runTui(tuiBinary, invalidPath, runningTuis);
          assertNoSecret(rejected, [pairing.key, wrongKey]);
          assert.notEqual(rejected.code, 0, 'Invalid pairing must not produce a successful list');
          assert.equal(
            rejected.stdout,
            '',
            'No session metadata is returned before authentication',
          );
          assert.match(rejected.stderr, /authenticat|rejected/i);
          assert.deepEqual(await snapshot(), expected);
        },
      );
    } finally {
      try {
        // This private, isolated host contains only sessions created by this test.
        if (client.isConnected) {
          events.splice(0);
          const remaining = await snapshot();
          for (const session of remaining.sessions) client.closeSession(session.id);
          if (remaining.sessions.length)
            await next('sessions', event => event.sessions.length === 0);
        }
      } finally {
        unsubscribe();
        client.disconnect();
        for (const tui of runningTuis) await stopProcess(tui);
        await stopProcess(host);
        // Check the resolved deletion target before recursive cleanup on Windows.
        assert.equal(dirname(resolve(fixture)), temporaryRoot);
        assert.ok(basename(fixture).startsWith('nesvo-tui-'));
        await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  },
);
