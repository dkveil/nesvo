import Ajv from 'ajv';
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
import { stopFixtureHost } from './host-fixture-shutdown';

type Snapshot = Extract<HostEvent, { type: 'sessions' }>;
type CommandResult = { code: number | null; stdout: string; stderr: string };
// Ajv is a test-only dependency; the native CLI has no JSON-schema runtime.
const cliSchema = new Ajv().compile(
  JSON.parse(readFileSync(resolve('docs/harness-cli.schema.json'), 'utf8')),
);
function queryOutput(text: string): unknown {
  const value: unknown = JSON.parse(text);
  assert.equal(cliSchema(value), true, JSON.stringify(cliSchema.errors));
  return value;
}

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
  command = ['--list'],
  environment: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, [...(pairingPath ? ['--pairing', pairingPath] : []), ...command], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...environment },
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

function stableSnapshot(snapshot: Snapshot) {
  // Reads happen at different instants. Validate observed status, but compare
  // process identity, ownership, dimensions and all other metadata unchanged.
  assert.equal(decodeServerMessage(snapshot)?.type, 'sessions');
  return {
    ...snapshot,
    sessions: snapshot.sessions.map(
      ({ status: _status, uptimeSeconds: _uptime, ...session }) => session,
    ),
  };
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
      ['--port', '0', '--pairing-dir', fixture, '--workspace', fixture, '--exit-on-stdin-close'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
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
        'doctor and session explain use authenticated read-only commands',
        async () => {
          for (const command of [
            ['doctor', '--json'],
            ['session', 'explain', created.sessionId, '--json'],
          ]) {
            const result = await runTui(tuiBinary, pairingPath, runningTuis, command);
            assertNoSecret(result, [pairing.key]);
            assert.equal(result.code, 0, result.stderr);
            const report = JSON.parse(result.stdout);
            queryOutput(result.stdout);
            assert.equal(report.schemaVersion, 1);
            assert.match(report.host.buildId, /^[a-f0-9]{16}$/);
            assert.equal(report.sessions.length, 1);
            assert.equal(report.sessions[0].sessionId, created.sessionId);
            assert.equal(report.sessions[0].integration.configured, false);
            assert.equal(report.sessions[0].terminalProtocol.owner, 'host');
          }
          const unknown = await runTui(tuiBinary, pairingPath, runningTuis, [
            'session',
            'explain',
            'absent',
            '--json',
          ]);
          assert.notEqual(unknown.code, 0);
          assertNoSecret(unknown, [pairing.key]);
          const after = await snapshot();
          assert.equal(after.sessions[0]?.controllerId, null, 'diagnostics cannot acquire control');
        },
      );

      await suite.test(
        'headless TUI returns identical authoritative IDs, hierarchy and revision',
        async () => {
          const result = await runTui(tuiBinary, pairingPath, runningTuis);
          assertNoSecret(result, [pairing.key]);
          assert.equal(result.code, 0, `TUI --list failed: ${result.stderr}`);
          assert.equal(result.stderr, '');
          const decoded = decodeServerMessage(JSON.parse(result.stdout) as unknown);
          assert.ok(decoded?.type === 'sessions', 'TUI output must be a valid protocol snapshot');
          assert.deepEqual(stableSnapshot(decoded), stableSnapshot(expected));
        },
      );

      await suite.test(
        'read-only session CLI has stable JSON, cursor bounds and process context without control',
        async () => {
          for (const command of [
            ['session', 'list', '--json'],
            ['session', 'get', created.sessionId, '--json'],
            ['session', 'current', '--json'],
          ]) {
            const result = await runTui(tuiBinary, pairingPath, runningTuis, command, {
              NESVO_SESSION_ID: created.sessionId,
            });
            assertNoSecret(result, [pairing.key]);
            assert.equal(result.code, 0, result.stderr);
            const body = JSON.parse(result.stdout);
            queryOutput(result.stdout);
            assert.equal(body.schemaVersion, 1);
            assert.equal(body.ok, true);
            if (command[1] === 'list') assert.equal(body.data.sessions[0].id, created.sessionId);
            else assert.equal(body.data.session.id, created.sessionId);
          }
          const first = await runTui(tuiBinary, pairingPath, runningTuis, [
            'session',
            'read',
            created.sessionId,
            '--max-bytes',
            '128',
            '--json',
          ]);
          assert.equal(first.code, 0, first.stderr);
          const page = JSON.parse(first.stdout).data.page;
          queryOutput(first.stdout);
          assert.equal(page.format, 'terminalReplay');
          assert.ok(Buffer.byteLength(page.data) <= 128);
          const next = await runTui(tuiBinary, pairingPath, runningTuis, [
            'session',
            'read',
            created.sessionId,
            '--after',
            String(page.nextCursor),
            '--json',
          ]);
          assert.equal(next.code, 0, next.stderr);
          assert.equal(JSON.parse(next.stdout).data.page.fromCursor, page.nextCursor);
          for (const [command, code, kind] of [
            [['session', 'get', 'absent', '--json'], 5, 'session_not_found'],
            [['session', 'current', '--json'], 2, 'no_current_session'],
            [
              ['session', 'read', created.sessionId, '--max-bytes', '8193', '--json'],
              2,
              'invalid_argument',
            ],
            [
              ['session', 'read', created.sessionId, '--after', '9007199254740991', '--json'],
              6,
              'invalid_cursor',
            ],
            [['session', 'diff', created.sessionId, '--json'], 6, 'git_unavailable'],
          ] as const) {
            const result = await runTui(tuiBinary, pairingPath, runningTuis, [...command], {
              NESVO_SESSION_ID: undefined,
            });
            assert.equal(result.code, code, result.stderr);
            assert.equal(result.stderr, '');
            const failure = JSON.parse(result.stdout);
            queryOutput(result.stdout);
            assert.equal(failure.ok, false);
            assert.equal(failure.error.code, kind);
            assertNoSecret(result, [pairing.key]);
          }
          const help = await runTui(tuiBinary, join(fixture, 'missing.json'), runningTuis, [
            'session',
            'read',
            '--help',
          ]);
          assert.equal(help.code, 0);
          assert.match(help.stdout, /max-bytes/);
          const after = await snapshot();
          assert.equal(
            after.sessions[0]?.controllerId,
            null,
            'reads cannot acquire a control lease',
          );
          assert.equal(after.sessions[0]?.id, created.sessionId);
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
          assert.deepEqual(stableSnapshot(afterExit), stableSnapshot(expected));
        },
      );

      await suite.test(
        'managed-process CLI uses its own capability and cannot turn a context hint into authority',
        async () => {
          const pointer = join(fixture, 'caller-path.txt');
          client.acquireControl(created.sessionId, 80, 24);
          await next('control', e => e.sessionId === created.sessionId && !!e.leaseId);
          const command =
            process.platform === 'win32'
              ? `[System.IO.File]::WriteAllText('${pointer.replaceAll("'", "''")}',$env:NESVO_AGENT_CONTEXT)\r`
              : `printf '%s' "$NESVO_AGENT_CONTEXT" > '${pointer.replaceAll("'", "'\\''")}'\r`;
          client.sendInput(created.sessionId, command);
          const contextPath = await until(async () => {
            try {
              return (await readFile(pointer, 'utf8')).trim() || undefined;
            } catch {
              return undefined;
            }
          }, 'private caller context');
          client.releaseControl(created.sessionId);
          await next('control', e => e.sessionId === created.sessionId && e.controllerId === null);
          const capability = JSON.parse(await readFile(contextPath, 'utf8'));
          assert.notEqual(capability.key, pairing.key);
          for (const subcommand of [
            ['session', 'current', '--json'],
            ['session', 'list', '--json'],
            ['session', 'explain', created.sessionId, '--json'],
          ]) {
            const result = await runTui(tuiBinary, '', runningTuis, subcommand, {
              NESVO_AGENT_CONTEXT: contextPath,
              NESVO_SESSION_ID: created.sessionId,
            });
            assert.equal(result.code, 0, result.stderr);
            queryOutput(result.stdout);
            assertNoSecret(result, [pairing.key, capability.key]);
            const body = JSON.parse(result.stdout);
            if (subcommand[1] === 'current') assert.equal(body.data.session.id, created.sessionId);
            if (subcommand[1] === 'list')
              assert.deepEqual(
                body.data.sessions.map((s: { id: string }) => s.id),
                [created.sessionId],
              );
          }
          const forbidden = await runTui(
            tuiBinary,
            '',
            runningTuis,
            ['session', 'current', '--json'],
            { NESVO_AGENT_CONTEXT: contextPath, NESVO_SESSION_ID: 'someone-else' },
          );
          assert.equal(forbidden.code, 6);
          assert.equal(JSON.parse(forbidden.stdout).error.code, 'forbidden');
          const forged = join(fixture, 'forged-context.json');
          await writeFile(forged, JSON.stringify({ ...capability, scopeId: '0'.repeat(32) }));
          const rejected = await runTui(tuiBinary, forged, runningTuis, [
            'session',
            'list',
            '--json',
          ]);
          assert.equal(rejected.code, 4);
          assert.equal(JSON.parse(rejected.stdout).error.code, 'host_unavailable');
          assertNoSecret(rejected, [pairing.key, capability.key]);
          assert.equal((await snapshot()).sessions[0]?.controllerId, null);
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
          assert.deepEqual(stableSnapshot(await snapshot()), stableSnapshot(expected));
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
        try {
          for (const tui of runningTuis) await stopProcess(tui);
        } finally {
          try {
            await stopFixtureHost(host);
          } finally {
            // Check the resolved deletion target before recursive cleanup on Windows.
            assert.equal(dirname(resolve(fixture)), temporaryRoot);
            assert.ok(basename(fixture).startsWith('nesvo-tui-'));
            await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          }
        }
      }
    }
  },
);
