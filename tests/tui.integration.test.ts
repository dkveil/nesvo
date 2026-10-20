import Ajv from 'ajv';
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  input?: string,
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, [...(pairingPath ? ['--pairing', pairingPath] : []), ...command], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...environment },
    });
    running.add(child);
    child.stdin.end(input);
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
          const journal = await runTui(tuiBinary, pairingPath, runningTuis, [
            'events',
            '--session',
            created.sessionId,
            '--json',
          ]);
          assert.equal(journal.code, 0, journal.stderr);
          queryOutput(journal.stdout);
          const eventPage = JSON.parse(journal.stdout).data;
          assert.ok(
            eventPage.events.every((e: { sessionId: string }) => e.sessionId === created.sessionId),
          );
          assert.ok(eventPage.events.some((e: { kind: string }) => e.kind === 'session.created'));
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
            ['events', '--json'],
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
          assert.equal(forbidden.code, 0);
          assert.equal(
            JSON.parse(forbidden.stdout).data.session.id,
            created.sessionId,
            'authenticated process identity overrides a forged environment hint',
          );
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
        'event CLI watch streams versioned deltas and stays quiet without changes',
        async () => {
          const watcher = spawn(
            tuiBinary,
            ['--pairing', pairingPath, 'events', '--watch', '--json'],
            { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          runningTuis.add(watcher);
          let buffer = '';
          let stderr = '';
          let parseFailure: unknown;
          const pages: {
            events: { sessionId: string | null; kind: string }[];
            nextCursor: number;
          }[] = [];
          watcher.stdout.setEncoding('utf8');
          watcher.stdout.on('data', (chunk: string) => {
            buffer += chunk;
            for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              try {
                queryOutput(line);
                const value = JSON.parse(line);
                assert.equal(value.ok, true);
                pages.push(value.data);
              } catch (error) {
                parseFailure = error;
              }
            }
          });
          watcher.stderr.on('data', chunk => {
            stderr += chunk.toString();
          });
          try {
            await until(() => {
              if (parseFailure) throw parseFailure;
              return pages.length || undefined;
            }, 'first event CLI page');
            const initial = pages.length;
            const cursor = pages.at(-1)!.nextCursor;
            await delay(300);
            assert.equal(pages.length, initial, 'idle watch must not poll or print heartbeat data');
            const request = client.createSession('Event watch fixture', null);
            const started = await next('created', e => e.requestId === request);
            await until(() => {
              if (parseFailure) throw parseFailure;
              return (
                pages.some(p =>
                  p.events.some(
                    e => e.sessionId === started.sessionId && e.kind === 'session.created',
                  ),
                ) || undefined
              );
            }, 'new process event');
            assert.ok(pages.at(-1)!.nextCursor > cursor);
            client.closeSession(started.sessionId);
            await until(
              () =>
                pages.some(p =>
                  p.events.some(
                    e => e.sessionId === started.sessionId && e.kind === 'session.closed',
                  ),
                ) || undefined,
              'closed process event',
            );
            assert.equal((await snapshot()).sessions[0]?.controllerId, null);
            assert.equal(stderr, '');
            assert.equal(parseFailure, undefined);
          } finally {
            await stopProcess(watcher);
            runningTuis.delete(watcher);
          }
        },
      );

      await suite.test(
        'CLI creates once with receipts and preserves literal paths and prompts',
        async () => {
          const cwd = join(fixture, 'folder with spaces łódź');
          await mkdir(cwd);
          const command = [
            'session',
            'create',
            'Literal session łódź',
            '--key',
            'cli-key',
            '--cwd',
            cwd,
            '--json',
          ];
          const first = await runTui(tuiBinary, pairingPath, runningTuis, command);
          assert.equal(first.code, 0, first.stderr);
          queryOutput(first.stdout);
          const receipt = JSON.parse(first.stdout).data.receipt;
          assert.equal(receipt.phase, 'created');
          const repeat = await runTui(tuiBinary, pairingPath, runningTuis, command);
          queryOutput(repeat.stdout);
          assert.equal(JSON.parse(repeat.stdout).data.receipt.id, receipt.id);
          const lookup = await runTui(tuiBinary, pairingPath, runningTuis, [
            'operation',
            '--key',
            'cli-key',
            '--json',
          ]);
          queryOutput(lookup.stdout);
          assert.equal(JSON.parse(lookup.stdout).data.receipt.id, receipt.id);
          const current = await snapshot();
          assert.equal(current.sessions.filter(s => s.id === receipt.sessionId).length, 1);
          assert.equal(
            current.sessions
              .find(s => s.id === receipt.sessionId)
              ?.cwd.replace(/\\/g, '/')
              .endsWith('/folder with spaces łódź'),
            true,
          );
          assert.equal(current.sessions.find(s => s.id === receipt.sessionId)?.controllerId, null);
          const sendFile = join(fixture, 'send prompt.txt');
          await writeFile(sendFile, 'echo NESVO_CLI_FILE');
          for (const [key, args, input] of [
            ['send-file', ['--prompt-file', sendFile], undefined],
            ['send-stdin', ['--stdin'], 'echo NESVO_CLI_STDIN'],
          ] as const) {
            const sendArgs = [
              'session',
              'send',
              receipt.sessionId,
              '--key',
              key,
              ...args,
              '--json',
            ];
            const sent = await runTui(tuiBinary, pairingPath, runningTuis, sendArgs, {}, input);
            queryOutput(sent.stdout);
            assert.equal(sent.code, 0, sent.stdout);
            const sentReceipt = JSON.parse(sent.stdout).data.receipt;
            assert.equal(sentReceipt.phase, 'delivered');
            assert.equal(sentReceipt.result.nativeWriteFlushed, true);
            const repeated = await runTui(tuiBinary, pairingPath, runningTuis, sendArgs, {}, input);
            assert.deepEqual(JSON.parse(repeated.stdout).data.receipt, sentReceipt);
            const waited = await runTui(tuiBinary, pairingPath, runningTuis, [
              'session',
              'wait',
              '--key',
              key,
              '--until',
              'delivered',
              '--session',
              receipt.sessionId,
              '--timeout-ms',
              '100',
              '--json',
            ]);
            queryOutput(waited.stdout);
            assert.equal(waited.code, 0, waited.stdout);
            assert.equal(JSON.parse(waited.stdout).data.wait.reached, true);
            const unsupported = await runTui(tuiBinary, pairingPath, runningTuis, [
              'session',
              'wait',
              sentReceipt.id,
              '--until',
              'settled',
              '--timeout-ms',
              '100',
              '--json',
            ]);
            queryOutput(unsupported.stdout);
            assert.equal(
              unsupported.code,
              8,
              'shell delivery cannot imply provider response completion',
            );
          }
          assert.equal(
            (await snapshot()).sessions.find(s => s.id === receipt.sessionId)?.controllerId,
            null,
          );
          const prompt = 'Literal $(never-execute) `never-execute` "łódź"\r\nnext line';
          const file = join(fixture, 'prompt with spaces.txt');
          await writeFile(file, prompt);
          for (const [key, args, input] of [
            ['file', ['--prompt-file', file], undefined],
            ['stdin', ['--stdin'], prompt],
          ] as const) {
            const rejected = await runTui(
              tuiBinary,
              pairingPath,
              runningTuis,
              ['session', 'create', 'No shell prompt execution', '--key', key, ...args, '--json'],
              {},
              input,
            );
            queryOutput(rejected.stdout);
            assert.equal(rejected.code, 6, 'shell prompts fail validation, never execute');
            assert.ok(JSON.parse(rejected.stdout).error.receipt, rejected.stdout);
            assert.equal(JSON.parse(rejected.stdout).error.receipt.phase, 'failed');
            assert.equal(JSON.parse(rejected.stdout).error.receipt.result.effectStarted, false);
          }
          await writeFile(file, 'x'.repeat(8193));
          const large = await runTui(tuiBinary, pairingPath, runningTuis, [
            'session',
            'create',
            'Oversized',
            '--key',
            'large',
            '--prompt-file',
            file,
            '--json',
          ]);
          queryOutput(large.stdout);
          assert.equal(large.code, 2);
          const absent = await runTui(tuiBinary, pairingPath, runningTuis, [
            'operation',
            '--key',
            'large',
            '--json',
          ]);
          queryOutput(absent.stdout);
          assert.equal(absent.code, 5, 'oversized input never creates a receipt');
          for (const [operation, phase] of [
            ['interrupt', 'delivered'],
            ['stop', 'stopRequested'],
          ] as const) {
            const args = [
              'session',
              operation,
              receipt.sessionId,
              '--key',
              `cli-${operation}`,
              '--json',
            ];
            const controlled = await runTui(tuiBinary, pairingPath, runningTuis, args);
            queryOutput(controlled.stdout);
            assert.equal(controlled.code, 0, controlled.stdout);
            const historical = JSON.parse(controlled.stdout).data.receipt;
            if (operation === 'stop' && historical.phase === 'stopped') {
              assert.equal(historical.result.processExited, true);
              assert.equal(historical.result.nativeStopRequested, false);
            } else {
              assert.equal(historical.phase, phase);
            }
            const repeat = await runTui(tuiBinary, pairingPath, runningTuis, args);
            assert.equal(repeat.code, 0, repeat.stdout);
            assert.deepEqual(JSON.parse(repeat.stdout).data.receipt, historical);
          }
          await until(
            async () =>
              (await snapshot()).sessions.some(s => s.id === receipt.sessionId && !s.running) ||
              undefined,
            'native stopped session remains readable',
          );
          client.closeSession(receipt.sessionId);
          await next('sessions', e => !e.sessions.some(s => s.id === receipt.sessionId));
        },
      );

      await suite.test(
        'workflow CLI commits a DAG once and recovers the same revision without native effects',
        async () => {
          const invoke = async (args: string[]) => {
            const output = await runTui(tuiBinary, pairingPath, runningTuis, [
              'run',
              ...args,
              '--json',
            ]);
            queryOutput(output.stdout);
            assert.equal(output.code, 0, output.stdout);
            return JSON.parse(output.stdout).data;
          };
          const goalPath = join(fixture, 'goal łódź.txt');
          await writeFile(goalPath, 'Literal $(do-not-execute) goal\nwith Unicode łódź');
          const created = await invoke([
            'create',
            'CLI plan',
            '--key',
            'run-create',
            '--goal-file',
            goalPath,
          ]);
          assert.equal(created.run.state, 'draft');
          assert.equal(created.run.goal, await readFile(goalPath, 'utf8'));
          assert.deepEqual(await invoke(['mutation', '--key', 'run-create']), created);
          const planPath = join(fixture, 'plan.json');
          await writeFile(
            planPath,
            JSON.stringify([
              { key: 'implement', title: 'Implement', instruction: 'Produce explicit result' },
              {
                key: 'review',
                title: 'Review',
                instruction: 'Validate',
                dependencies: ['implement'],
              },
            ]),
          );
          const planned = await invoke([
            'plan',
            created.run.id,
            '--key',
            'run-plan',
            '--revision',
            '1',
            '--file',
            planPath,
          ]);
          assert.equal(planned.run.revision, 2);
          assert.equal(planned.tasks[0].state, 'planned');
          assert.equal(planned.tasks[1].dependencyState, 'waiting');
          assert.equal(planned.tasks[1].dependencies[0], planned.tasks[0].id);
          const current = await invoke(['get', created.run.id]);
          assert.deepEqual(current.tasks, planned.tasks);
          assert.ok(
            (await invoke(['list'])).runs.some((r: { id: string }) => r.id === created.run.id),
          );
          const stale = await runTui(tuiBinary, pairingPath, runningTuis, [
            'run',
            'plan',
            created.run.id,
            '--key',
            'run-stale',
            '--revision',
            '1',
            '--file',
            planPath,
            '--json',
          ]);
          queryOutput(stale.stdout);
          assert.equal(JSON.parse(stale.stdout).error.code, 'revision_conflict');
          assert.equal((await invoke(['get', created.run.id])).run.revision, 2);
          await writeFile(
            planPath,
            JSON.stringify([{ key: 'bad', title: 'bad', instruction: 'x', dependencies: false }]),
          );
          const malformed = await runTui(tuiBinary, pairingPath, runningTuis, [
            'run',
            'plan',
            created.run.id,
            '--key',
            'malformed',
            '--revision',
            '2',
            '--file',
            planPath,
            '--json',
          ]);
          queryOutput(malformed.stdout);
          assert.equal(malformed.code, 2);
          const activated = await invoke([
            'activate',
            created.run.id,
            '--key',
            'run-activate',
            '--revision',
            '2',
          ]);
          assert.equal(activated.run.state, 'active');
          assert.equal(activated.run.revision, 3);
          const decisions = await invoke(['decision', 'list', created.run.id]);
          assert.deepEqual(decisions.decisions, []);
          assert.equal(decisions.nextOffset, null);
          const sendArgs = [
            'inbox',
            'send',
            created.run.id,
            '--key',
            'cli-message',
            '--correlation',
            'literal-context',
            '--message-file',
            goalPath,
          ];
          const message = await invoke(sendArgs);
          assert.equal(message.message.body, await readFile(goalPath, 'utf8'));
          assert.deepEqual(await invoke(sendArgs), message);
          const recovered = await invoke(['mutation', '--key', 'cli-message']);
          assert.equal(recovered.message.id, message.message.id);
          const inbox = await invoke(['inbox', 'read', created.run.id]);
          assert.equal(inbox.messages[0].id, message.message.id);
          assert.equal(inbox.pendingCount, 1);
          const ack = await invoke(['inbox', 'ack', created.run.id, message.message.id]);
          assert.equal(ack.acknowledged[0].ackedBy.role, 'owner');
          assert.deepEqual(
            (await invoke(['inbox', 'ack', created.run.id, message.message.id])).acknowledged,
            ack.acknowledged,
          );
          assert.equal((await invoke(['inbox', 'read', created.run.id])).pendingCount, 0);
          assert.equal(
            (await invoke(['inbox', 'read', created.run.id, '--include-acked'])).messages[0]
              .ackedAt,
            ack.acknowledged[0].ackedAt,
          );
          assert.equal(
            (await invoke(['get', created.run.id])).run.revision,
            3,
            'Inbox ACK is separate from workflow execution',
          );
          const history = await invoke(['task', created.run.id, planned.tasks[0].id]);
          assert.deepEqual(history.attempts, []);
          const context = await runTui(tuiBinary, pairingPath, runningTuis, [
            'run',
            'context',
            '--json',
          ]);
          queryOutput(context.stdout);
          assert.equal(
            JSON.parse(context.stdout).error.code,
            'forbidden',
            'owner focus is not a worker binding',
          );
          assert.deepEqual(stableSnapshot(await snapshot()), stableSnapshot(expected));
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
