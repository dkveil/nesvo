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
const cliSchemas = [
  'docs/harness-cli.schema.json',
  'tests/fixtures/harness-cli-handwritten.schema.json',
].map(path => new Ajv().compile(JSON.parse(readFileSync(resolve(path), 'utf8'))));
function queryOutput(text: string): unknown {
  const value: unknown = JSON.parse(text);
  for (const cliSchema of cliSchemas)
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
  // Reads happen at different instants. Validate status and optional advisory
  // evidence, but compare process identity, ownership, dimensions and durable
  // metadata unchanged. Repository evidence has its own revision/cooldown;
  // settled native parity is checked separately below.
  assert.equal(decodeServerMessage(snapshot)?.type, 'sessions');
  return {
    ...snapshot,
    sessions: snapshot.sessions.map(
      ({
        status: _status,
        uptimeSeconds: _uptime,
        repositoryContext: _repositoryContext,
        ...session
      }) => session,
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
        if (type !== 'error' && error?.type === 'error') throw new Error(error.message);
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
        'headless TUI and mobile agree on settled independent repository evidence',
        async () => {
          const settled = await until(async () => {
            const current = await snapshot();
            const context = current.sessions.find(
              session => session.id === created.sessionId,
            )?.repositoryContext;
            if (!context || context.state === 'checking') return undefined;
            // This test owns a fresh temporary directory with no repository.
            assert.equal(context.state, 'notRepository');
            assert.equal(context.source, 'launchDirectory');
            assert.equal(context.name, null);
            assert.equal(context.branch, null);
            assert.ok(Number.isSafeInteger(context.observedAt));
            assert.ok(context.revision >= 2);
            return current;
          }, 'native repository observation settles');
          const result = await runTui(tuiBinary, pairingPath, runningTuis);
          assertNoSecret(result, [pairing.key]);
          assert.equal(result.code, 0, result.stderr);
          const decoded = decodeServerMessage(JSON.parse(result.stdout) as unknown);
          assert.ok(decoded?.type === 'sessions');
          assert.deepEqual(stableSnapshot(decoded), stableSnapshot(expected));
          assert.equal(decoded.revision, settled.revision);
          assert.deepEqual(
            decoded.sessions.find(session => session.id === created.sessionId)?.repositoryContext,
            settled.sessions.find(session => session.id === created.sessionId)?.repositoryContext,
          );
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
            [['session', 'get', 'absent', '--json'], 1, 'session_not_found'],
            [['session', 'current', '--json'], 1, 'no_current_session'],
            [
              ['session', 'read', created.sessionId, '--max-bytes', '8193', '--json'],
              1,
              'invalid_argument',
            ],
            [
              ['session', 'read', created.sessionId, '--after', '9007199254740991', '--json'],
              1,
              'invalid_cursor',
            ],
            [['session', 'diff', created.sessionId, '--json'], 4, 'git_unavailable'],
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
          assert.equal(rejected.code, 2);
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
          for (const selector of [[receipt.id], ['--id', receipt.id]]) {
            const byId = await runTui(tuiBinary, pairingPath, runningTuis, [
              'operation',
              ...selector,
              '--json',
            ]);
            assert.equal(byId.code, 0, byId.stderr);
            queryOutput(byId.stdout);
            assert.equal(JSON.parse(byId.stdout).data.receipt.id, receipt.id);
          }
          const ambiguous = await runTui(tuiBinary, pairingPath, runningTuis, [
            'operation',
            '--id',
            receipt.id,
            '--key',
            'cli-key',
            '--json',
          ]);
          assert.equal(ambiguous.code, 1, 'receipt selectors are mutually exclusive');
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
              4,
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
            assert.equal(rejected.code, 4, 'shell prompts fail validation, never execute');
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
          assert.equal(large.code, 1);
          const absent = await runTui(tuiBinary, pairingPath, runningTuis, [
            'operation',
            '--key',
            'large',
            '--json',
          ]);
          queryOutput(absent.stdout);
          assert.equal(absent.code, 1, 'oversized input never creates a receipt');
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
          assert.equal(malformed.code, 1);
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
        'run budget CLI preserves activation clock, revisions and drain history',
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
          const created = await invoke([
            'create',
            'Budget CLI',
            '--key',
            'budget-cli-run',
            '--goal',
            'No native effects',
          ]);
          const id = created.run.id;
          const file = join(fixture, 'run-budget.json');
          await writeFile(
            file,
            JSON.stringify([{ key: 'later', title: 'Later', instruction: 'Controlled admission' }]),
          );
          await invoke(['plan', id, '--key', 'budget-cli-plan', '--revision', '1', '--file', file]);
          const activated = await invoke([
            'activate',
            id,
            '--key',
            'budget-cli-start',
            '--revision',
            '2',
          ]);
          const start = activated.run.budget.startedAt;
          assert.equal(typeof start, 'number');
          const limits = { maxParallel: 2, maxAttemptsPerTask: 3, maxElapsedMs: null };
          await writeFile(file, JSON.stringify(limits));
          const args = [
            'budget',
            'set',
            id,
            '--key',
            'budget-cli-policy',
            '--revision',
            '3',
            '--file',
            file,
          ];
          const configured = await invoke(args);
          assert.deepEqual(configured.policy.limits, limits);
          assert.deepEqual(await invoke(args), configured);
          assert.deepEqual(await invoke(['mutation', '--key', 'budget-cli-policy']), configured);
          const read = await invoke(['budget', 'get', id]);
          assert.equal(read.policy.startedAt, start);
          assert.equal(read.run.revision, 4);
          const drained = await invoke([
            'drain',
            id,
            '--key',
            'budget-cli-drain',
            '--revision',
            '4',
          ]);
          assert.equal(drained.run.state, 'drained');
          assert.equal(drained.run.budget.ownerDrain, true);
          const resumed = await invoke([
            'resume',
            id,
            '--key',
            'budget-cli-resume',
            '--revision',
            '5',
          ]);
          assert.equal(resumed.run.state, 'active');
          assert.equal(resumed.run.budget.startedAt, start);
          const historic = await invoke([
            'drain',
            id,
            '--key',
            'budget-cli-drain',
            '--revision',
            '4',
          ]);
          assert.deepEqual(historic, drained);
          assert.equal((await invoke(['get', id])).run.state, 'active');
          for (const [index, [contents, code]] of [
            [JSON.stringify({ ...limits, maxParallel: 0 }), 'invalid_argument'],
            [JSON.stringify({ ...limits, maxElapsedMs: 999 }), 'invalid_argument'],
            [JSON.stringify({ ...limits, role: 'owner' }), 'invalid_argument'],
            [JSON.stringify({ maxParallel: 2, maxAttemptsPerTask: 3 }), 'invalid_argument'],
            ['x'.repeat(4097), 'input_too_large'],
          ].entries()) {
            await writeFile(file, contents);
            const denied = await runTui(tuiBinary, pairingPath, runningTuis, [
              'run',
              'budget',
              'set',
              id,
              '--key',
              `bad-run-budget-${index}`,
              '--revision',
              '6',
              '--file',
              file,
              '--json',
            ]);
            queryOutput(denied.stdout);
            assert.equal(JSON.parse(denied.stdout).error.code, code);
            assert.equal(denied.code, 1, denied.stdout);
          }
          assert.equal((await invoke(['budget', 'get', id])).run.revision, 6);
          assert.deepEqual(stableSnapshot(await snapshot()), stableSnapshot(expected));
        },
      );

      await suite.test(
        'run control CLI accepts cancellation once and inspects without native effects',
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
          const created = await invoke([
            'create',
            'Cancel draft CLI',
            '--key',
            'control-cli-run',
            '--goal',
            'No native workers',
          ]);
          const id = created.run.id;
          const args = ['cancel', id, '--key', 'control-cli-cancel', '--revision', '1'];
          const accepted = await invoke(args);
          assert.equal(accepted.run.state, 'canceled');
          assert.equal(accepted.control.state, 'completed');
          assert.deepEqual(accepted.targets, []);
          assert.deepEqual(await invoke(args), accepted);
          assert.deepEqual(await invoke(['mutation', '--key', 'control-cli-cancel']), accepted);
          const control = await invoke(['control', id, accepted.control.id]);
          assert.equal(control.run.state, 'canceled');
          assert.deepEqual(control.targets, []);
          for (const [command, code] of [
            [['control', id, accepted.control.id, '--offset', '4097'], 'invalid_argument'],
            [['control', id, 'unknown-control'], 'control_not_found'],
            [
              [
                'resume',
                id,
                '--key',
                'revive-control-cli',
                '--revision',
                String(control.run.revision),
              ],
              'run_state_conflict',
            ],
          ] as const) {
            const denied = await runTui(tuiBinary, pairingPath, runningTuis, [
              'run',
              ...command,
              '--json',
            ]);
            queryOutput(denied.stdout);
            assert.equal(JSON.parse(denied.stdout).error.code, code);
          }
          assert.deepEqual(stableSnapshot(await snapshot()), stableSnapshot(expected));
        },
      );

      await suite.test(
        'run launch CLI reserves a worker once and recovers native creation separately',
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
          const created = await invoke([
            'create',
            'CLI launch',
            '--key',
            'launch-cli-run',
            '--goal',
            'No automatic prompt',
          ]);
          const id = created.run.id;
          const planFile = join(fixture, 'launch-plan.json');
          await writeFile(
            planFile,
            JSON.stringify([
              { key: 'task', title: 'CLI worker', instruction: 'Controlled startup' },
            ]),
          );
          const plan = await invoke([
            'plan',
            id,
            '--key',
            'launch-cli-plan',
            '--revision',
            '1',
            '--file',
            planFile,
          ]);
          const active = await invoke([
            'activate',
            id,
            '--key',
            'launch-cli-active',
            '--revision',
            String(plan.run.revision),
          ]);
          const args = [
            'launch',
            id,
            '--task',
            plan.tasks[0].id,
            '--key',
            'launch-cli-once',
            '--revision',
            String(active.run.revision),
            '--program',
            'shell',
            '--no-harness',
          ];
          for (const flags of [[], ['--shared', '--worktree']]) {
            const invalid = await runTui(tuiBinary, pairingPath, runningTuis, [
              'run',
              ...args,
              ...flags,
              '--json',
            ]);
            assert.equal(invalid.code, 1, 'one explicit workspace mode is required');
          }
          const accepted = await invoke([...args, '--shared']);
          assert.equal(accepted.launch.phase, 'accepted');
          assert.equal(accepted.tasks[0].state, 'launching');
          assert.deepEqual(await invoke([...args, '--shared']), accepted);
          assert.deepEqual(await invoke(['mutation', '--key', 'launch-cli-once']), accepted);
          const history = await invoke(['task', id, plan.tasks[0].id]);
          assert.equal(history.attempts[0].state, 'assigned');
          assert.equal(history.attempts[0].launch.phase, 'created');
          assert.equal(history.attempts[0].launch.receiptId, accepted.launch.receiptId);
          const native = await runTui(tuiBinary, pairingPath, runningTuis, [
            'operation',
            '--id',
            accepted.launch.receiptId,
            '--json',
          ]);
          queryOutput(native.stdout);
          assert.equal(native.code, 0, native.stdout);
          assert.equal(JSON.parse(native.stdout).data.receipt.phase, 'created');
          const child = (await snapshot()).sessions.find(
            session => session.id === accepted.launch.sessionId,
          );
          assert.ok(child?.running);
          assert.equal(child.controllerId, null);
          const conflict = await runTui(tuiBinary, pairingPath, runningTuis, [
            'run',
            ...args,
            '--worktree',
            '--json',
          ]);
          queryOutput(conflict.stdout);
          assert.equal(JSON.parse(conflict.stdout).error.code, 'idempotency_conflict');
          const deliverArgs = [
            'deliver',
            id,
            '--task',
            plan.tasks[0].id,
            '--key',
            'shell-instruction',
            '--revision',
            String(history.run.revision),
            '--timeout-ms',
            '1000',
          ];
          const queued = await invoke(deliverArgs);
          assert.equal(queued.delivery.phase, 'queued');
          assert.equal(queued.delivery.receiptId, null);
          assert.deepEqual(await invoke(deliverArgs), queued);
          assert.deepEqual(await invoke(['mutation', '--key', 'shell-instruction']), queued);
          const rejectedDelivery = await until(async () => {
            const current = await invoke(['task', id, plan.tasks[0].id]);
            return current.attempts[0].delivery?.phase === 'failed' ? current : undefined;
          }, 'plain task text is never executed by a shell');
          assert.equal(rejectedDelivery.attempts[0].delivery.blocker, 'unsupported');
          assert.equal(rejectedDelivery.attempts[0].delivery.receiptId, null);
          assert.equal((await invoke(['executor', 'get', id])).executor, null);
          const executorFile = join(fixture, 'executor profiles łódź.json');
          await writeFile(
            executorFile,
            JSON.stringify({
              tasks: [
                {
                  taskId: plan.tasks[0].id,
                  profile: { program: 'claude', workspace: 'shared', harness: false },
                },
              ],
            }),
          );
          const startExecutor = [
            'executor',
            'start',
            id,
            '--key',
            'cli-executor-start',
            '--revision',
            String(rejectedDelivery.run.revision),
            '--file',
            executorFile,
          ];
          const engine = await invoke(startExecutor);
          assert.equal(engine.executor.enabled, true);
          assert.deepEqual(await invoke(startExecutor), engine);
          assert.deepEqual(await invoke(['mutation', '--key', 'cli-executor-start']), engine);
          await until(async () => {
            const current = await invoke(['executor', 'get', id]);
            return current.executor.reason === 'manual_attempt' ? current : undefined;
          }, 'executor never adopts a manually assigned worker');
          let currentEngine = await invoke(['executor', 'get', id]);
          const disabled = await invoke([
            'executor',
            'disable',
            id,
            '--key',
            'cli-executor-disable',
            '--revision',
            String(currentEngine.run.revision),
          ]);
          assert.equal(disabled.executor.enabled, false);
          const enabled = await invoke([
            'executor',
            'enable',
            id,
            '--key',
            'cli-executor-enable',
            '--revision',
            String(disabled.run.revision),
          ]);
          assert.equal(enabled.executor.generation, disabled.executor.generation + 1);
          currentEngine = await invoke(['executor', 'get', id]);
          const finalEngine = await invoke([
            'executor',
            'disable',
            id,
            '--key',
            'cli-executor-stop',
            '--revision',
            String(currentEngine.run.revision),
          ]);
          assert.equal((await invoke(['task', id, plan.tasks[0].id])).attempts.length, 1);
          const control = await invoke([
            'stop',
            id,
            '--key',
            'stop-cli-launch',
            '--revision',
            String(finalEngine.run.revision),
          ]);
          await until(async () => {
            const current = await invoke(['control', id, control.control.id]);
            return current.control.state === 'completed' ? current : undefined;
          }, 'launched worker exit evidence');
          client.closeSession(accepted.launch.sessionId);
          await next(
            'sessions',
            event => !event.sessions.some(session => session.id === accepted.launch.sessionId),
          );
          assert.deepEqual(stableSnapshot(await snapshot()), stableSnapshot(expected));
        },
      );

      await suite.test(
        'owner budgets reject legacy creation without changing existing sessions',
        async () => {
          const invoke = async (args: string[]) => {
            const output = await runTui(tuiBinary, pairingPath, runningTuis, [
              'budget',
              ...args,
              '--json',
            ]);
            queryOutput(output.stdout);
            assert.equal(output.code, 0, output.stdout);
            return JSON.parse(output.stdout).data;
          };
          const original = await invoke(['get']);
          const path = join(fixture, 'budget łódź.json');
          await writeFile(
            path,
            JSON.stringify({
              ...original.budget.limits,
              providers: { ...original.budget.limits.providers, shell: 0 },
            }),
          );
          const denied = await invoke([
            'set',
            '--key',
            'legacy-shell-budget',
            '--revision',
            String(original.budget.revision),
            '--file',
            path,
          ]);
          try {
            const requestId = client.createSession(
              'Budget must refuse this legacy start',
              child.groupId,
            );
            const refusal = await next('error', event => event.requestId === requestId);
            assert.equal(refusal.code, 'budget_exhausted');
            assert.deepEqual(stableSnapshot(await snapshot()), stableSnapshot(expected));
            const current = await invoke(['get']);
            assert.equal(current.budget.revision, denied.budget.revision);
            assert.equal(current.budget.limits.providers.shell, 0);
            const oversized = join(fixture, 'oversized-budget.json');
            await writeFile(oversized, ' '.repeat(4097));
            const malformed = await runTui(tuiBinary, pairingPath, runningTuis, [
              'budget',
              'set',
              '--key',
              'oversized-budget',
              '--revision',
              String(current.budget.revision),
              '--file',
              oversized,
              '--json',
            ]);
            queryOutput(malformed.stdout);
            assert.equal(malformed.code, 1);
          } finally {
            const current = await invoke(['get']);
            await writeFile(path, JSON.stringify(original.budget.limits));
            await invoke([
              'set',
              '--key',
              'restore-fixture-budget',
              '--revision',
              String(current.budget.revision),
              '--file',
              path,
            ]);
          }
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
