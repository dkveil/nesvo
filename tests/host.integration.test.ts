import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

import type { Pairing, TerminalSession } from '../apps/mobile/src/shared/api/host/types';
import {
  decodeFrame,
  encodeFrame,
  keyBytes,
  parsePairing,
} from '../apps/mobile/src/shared/api/host/wire';
import { stopFixtureHost } from './host-fixture-shutdown';

type Event = {
  type: string;
  sessionId?: string;
  data?: string;
  replay?: boolean;
  message?: string;
  clientNonce?: string;
  requestId?: string;
  workspace?: string;
  programs?: { id: string; label: string; available: boolean }[];
  sessions?: TerminalSession[];
};

function hostBinary(): string {
  return (
    process.env.NESVO_HOST_BINARY ??
    resolve('target/debug', process.platform === 'win32' ? 'nesvo-host.exe' : 'nesvo-host')
  );
}

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
  timeout = 10000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error(`Timed out: ${label}`);
}

class Peer {
  socket: WebSocket;
  challenge = '';
  outgoing = 0;
  incoming = 0;
  events: Event[] = [];
  error?: Error;
  closeCode?: number;
  closed = false;
  nonce = randomBytes(32).toString('hex');
  authFrame = '';

  constructor(private pairing: Pairing) {
    this.socket = new WebSocket(pairing.url);
    this.socket.on('error', error => {
      this.error = error;
    });
    this.socket.on('close', code => {
      this.closeCode = code;
      this.closed = true;
    });
    this.socket.on('message', data => {
      try {
        const text = data.toString();
        if (!this.challenge) {
          this.challenge = JSON.parse(text).challenge;
          return;
        }
        const event = decodeFrame(
          text,
          keyBytes(this.pairing.key),
          this.challenge,
          'host-to-client',
          ++this.incoming,
        ) as Event;
        this.events.push(event);
        // ConPTY asks the attached terminal for its initial cursor position.
        if (event.type === 'output' && event.data?.includes('\x1b[6n'))
          this.send({ type: 'input', sessionId: event.sessionId, data: '\x1b[1;1R' });
      } catch (error) {
        this.error = error as Error;
      }
    });
  }

  async hello(): Promise<void> {
    await until(() => this.challenge || undefined, 'host challenge');
  }

  async authenticate(): Promise<void> {
    await this.hello();
    this.authFrame = this.send({ type: 'auth', clientNonce: this.nonce });
    const ready = await this.next('connected');
    assert.equal(ready.clientNonce, this.nonce, 'host proves freshness with client nonce');
  }

  send(command: unknown): string {
    const frame = encodeFrame(
      command,
      keyBytes(this.pairing.key),
      this.challenge,
      'client-to-host',
      ++this.outgoing,
      randomBytes,
    );
    this.socket.send(frame);
    return frame;
  }

  next(type: string, predicate: (event: Event) => boolean = () => true): Promise<Event> {
    return until(() => {
      if (this.error) throw this.error;
      const index = this.events.findIndex(event => event.type === type && predicate(event));
      if (index >= 0) return this.events.splice(index, 1)[0];
      const failure = this.events.find(event => event.type === 'error');
      if (failure && type !== 'error') throw new Error(`Host error: ${failure.message}`);
      return undefined;
    }, type);
  }

  async output(id: string, marker: string): Promise<string> {
    let seen = '';
    try {
      return await until(
        () => {
          if (this.error) throw this.error;
          const text = this.events
            .filter(event => event.type === 'output' && event.sessionId === id)
            .map(event => event.data)
            .join('');
          seen = text;
          return text.includes(marker) ? text : undefined;
        },
        `shell output: ${marker}`,
        20000,
      );
    } catch (error) {
      throw new Error(`${String(error)}; terminal tail: ${JSON.stringify(seen.slice(-3500))}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.socket.close();
    await until(() => this.closed || undefined, 'socket closed');
  }
}

test(
  'Rust host interoperates with TweetNaCl and preserves real PTYs securely',
  { timeout: 120000 },
  async suite => {
    const fixture = await mkdtemp(join(tmpdir(), 'pocket-host-test-'));
    const binary = hostBinary();
    const host: ChildProcess = spawn(
      binary,
      [
        '--port',
        '0',
        '--pairing-dir',
        fixture,
        '--workspace',
        process.cwd(),
        '--exit-on-stdin-close',
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stderr = '';
    host.stderr?.on('data', chunk => {
      stderr += chunk.toString();
    });
    host.on('error', error => {
      stderr += error.message;
    });
    const peers: Peer[] = [];
    let pairing: Pairing;
    const peer = (key?: string) => {
      const client = new Peer({ ...pairing, key: key ?? pairing.key });
      peers.push(client);
      return client;
    };
    try {
      pairing = await until(async () => {
        if (host.exitCode !== null) throw new Error(`Rust host exited: ${stderr}`);
        try {
          return parsePairing(await readFile(join(fixture, 'pairing.json'), 'utf8'));
        } catch {
          return undefined;
        }
      }, 'private pairing file');
      // JSON is written before QR generation. Its presence does not mean the SVG
      // is ready yet, especially on slower Windows runners.
      const pairingSvg = await until(async () => {
        if (host.exitCode !== null) throw new Error(`Rust host exited: ${stderr}`);
        try {
          const svg = await readFile(join(fixture, 'pairing.svg'), 'utf8');
          return svg.trimEnd().endsWith('</svg>') ? svg : undefined;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        }
      }, 'complete pairing QR file');
      assert.match(pairingSvg, /<svg/);

      await suite.test('wrong secret is rejected before any session is created', async () => {
        const invalid = peer(randomBytes(32).toString('hex'));
        await invalid.hello();
        invalid.send({ type: 'auth', clientNonce: invalid.nonce });
        await until(() => invalid.closed || undefined, 'wrong key closes connection');
        assert.equal(invalid.closeCode, 4003);
        assert.equal(invalid.events.length, 0);
      });

      await suite.test(
        'recorded authentication cannot be reused on another connection or sequence',
        async () => {
          const first = peer();
          await first.authenticate();
          const captured = first.authFrame;
          first.socket.send(captured);
          await until(() => first.closed || undefined, 'same-connection replay rejected');
          assert.equal(first.closeCode, 4003);
          const second = peer();
          await second.hello();
          assert.notEqual(first.challenge, second.challenge);
          second.socket.send(captured);
          await until(() => second.closed || undefined, 'cross-connection replay rejected');
          assert.equal(second.closeCode, 4003);
        },
      );

      await suite.test('untrusted browser origins are rejected', async () => {
        const rejected = await new Promise<number>((resolveStatus, reject) => {
          const socket = new WebSocket(pairing.url, { origin: 'https://untrusted.invalid' });
          socket.on('unexpected-response', (_request, response) => {
            resolveStatus(response.statusCode ?? 0);
            socket.terminate();
          });
          socket.on('error', () => {});
          socket.on('open', () => {
            socket.close();
            reject(new Error('Untrusted origin accepted'));
          });
        });
        assert.equal(rejected, 403);
      });

      await suite.test(
        'real shell survives disconnect, replays output, resizes and closes',
        async () => {
          const first = peer();
          await first.authenticate();
          const empty = await first.next('sessions');
          assert.deepEqual(empty.sessions, []);
          first.send({ type: 'create', name: 'Integration shell' });
          const created = await first.next(
            'sessions',
            event => event.sessions?.some(session => session.name === 'Integration shell') ?? false,
          );
          const id = created.sessions![0].id;
          first.send({ type: 'attach', sessionId: id, cols: 90, rows: 30 });
          await first.next('attached');
          const initialCommand =
            process.platform === 'win32'
              ? "$pocketValue = 'PERSIST' + '_OK'; Write-Output ('SHELL' + '_OK')\r"
              : "pocketValue='PERSIST''_OK'; printf 'SHELL%s\\n' '_OK'\r";
          const encrypted = first.send({ type: 'input', sessionId: id, data: initialCommand });
          assert.ok(!encrypted.includes('pocketValue'), 'shell input is encrypted on wire');
          await first.output(id, 'SHELL_OK');

          const second = peer();
          await second.authenticate();
          second.send({ type: 'attach', sessionId: id, cols: 80, rows: 24 });
          assert.match((await second.next('error')).message!, /Another device/);
          await first.disconnect();
          // Allow server's close cleanup to release its controller lease.
          await delay(100);
          second.send({ type: 'attach', sessionId: id, cols: 80, rows: 24 });
          await second.next('attached');
          await second.output(id, 'SHELL_OK');
          assert.ok(second.events.some(event => event.type === 'output' && event.replay));
          second.send({
            type: 'input',
            sessionId: id,
            data:
              process.platform === 'win32'
                ? 'Write-Output $pocketValue\r'
                : 'printf "%s\\n" "$pocketValue"\r',
          });
          await second.output(id, 'PERSIST_OK');
          second.send({ type: 'resize', sessionId: id, cols: 100, rows: 32 });
          second.send({ type: 'resize', sessionId: id, cols: 0, rows: 24 });
          assert.match((await second.next('error')).message!, /Terminal size/);
          second.send({ type: 'create', name: 'Second session' });
          const multiple = await second.next('sessions', event => event.sessions?.length === 2);
          assert.equal(multiple.sessions?.length, 2);
          for (const session of multiple.sessions!)
            second.send({ type: 'close', sessionId: session.id });
          await second.next('sessions', event => event.sessions?.length === 0);
          await second.disconnect();
        },
      );
    } finally {
      for (const client of peers) client.socket.terminate();
      try {
        await stopFixtureHost(host);
      } finally {
        // Only this mkdtemp fixture is removed; it contains ephemeral pairing credentials.
        await rm(fixture, { recursive: true, force: true });
      }
    }
  },
);

test('cached CLI discovery and literal cwd/launcher arguments', { timeout: 120000 }, async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'nesvo-launcher-test-')));
  const workspace = join(fixture, 'workspace');
  const outside = join(fixture, 'external repo & %NESVO_LITERAL%');
  const bin = join(fixture, 'bin space & %NESVO_LITERAL%');
  await Promise.all([
    mkdir(join(workspace, 'nested'), { recursive: true }),
    mkdir(outside),
    mkdir(bin),
  ]);
  const unixFixture = String.raw`#!/bin/sh
while IFS= read -r input; do
  case "$input" in
    status-blocked*) printf '\033[2J\033[HAllow execution of [Shell]?\r\n1. Allow once\r\n2. No, suggest changes (esc)' ;;
    status-clear*) printf '\033[2J\033[HUnrecognized ordinary output\r\n' ;;
    status-exit*) exit 7 ;;
    *) printf 'CLI_CWD=%s\nCLI_ARGC=0\n' "$PWD" ;;
  esac
done
`;
  if (process.platform === 'win32') {
    // A real Node executable exercises npm-style Windows shims without invoking
    // a real AI tool, authentication flow or model request.
    await link(process.execPath, join(bin, 'node.exe')).catch(() =>
      copyFile(process.execPath, join(bin, 'node.exe')),
    );
    const packageDirectory = join(bin, 'node_modules', '@google', 'gemini-cli');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, 'package.json'),
      JSON.stringify({ bin: { gemini: 'main.js' } }),
    );
    await writeFile(
      join(packageDirectory, 'main.js'),
      String.raw`process.stdin.on('data', data => {
        const command = data.toString();
        if (command.includes('status-blocked')) process.stdout.write('\x1b[2J\x1b[HAllow execution of [Shell]?\r\n1. Allow once\r\n2. No, suggest changes (esc)');
        else if (command.includes('status-clear')) process.stdout.write('\x1b[2J\x1b[HUnrecognized ordinary output\r\n');
        else if (command.includes('status-exit')) process.exit(7);
        else process.stdout.write('CLI_CWD='+process.cwd()+'\nCLI_ARGC='+process.argv.length+'\n');
      }); process.stdin.resume();`,
    );
    await writeFile(join(bin, 'gemini.cmd'), '@echo off\r\necho WRAPPER_MUST_NOT_EXECUTE\r\n');
    await writeFile(join(bin, 'claude.cmd'), '@echo off\r\necho unsupported custom wrapper\r\n');
  } else {
    const executable = join(bin, 'gemini');
    await writeFile(executable, unixFixture);
    await chmod(executable, 0o755);
    await writeFile(join(bin, 'claude'), 'not executable');
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
  );
  const host = spawn(
    hostBinary(),
    [
      '--port',
      '0',
      '--pairing-dir',
      join(fixture, 'pairing'),
      '--workspace',
      workspace,
      '--exit-on-stdin-close',
    ],
    {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, PATH: bin },
    },
  );
  let failure = '';
  host.on('error', error => {
    failure += error.message;
  });
  host.stderr?.on('data', data => {
    failure += data.toString();
  });
  let ready = false;
  host.stdout?.on('data', data => {
    ready ||= data.toString().includes('Rust host listening');
  });
  let peer: Peer | undefined;
  let bodyFailure: unknown;
  try {
    await until(() => {
      if (host.exitCode !== null || failure) throw new Error(`Host startup failed: ${failure}`);
      return ready || undefined;
    }, 'launcher fixture host ready');
    const pairing = parsePairing(await readFile(join(fixture, 'pairing', 'pairing.json'), 'utf8'));
    peer = new Peer(pairing);
    await peer.authenticate();
    await peer.next('sessions');
    peer.send({ type: 'getCapabilities', requestId: 'capabilities-1' });
    const capabilities = await peer.next('capabilities');
    assert.equal(capabilities.requestId, 'capabilities-1');
    assert.equal(capabilities.workspace, workspace);
    assert.deepEqual(
      capabilities.programs?.map(({ id, available }) => ({ id, available })),
      [
        { id: 'shell', available: true },
        { id: 'claude', available: false },
        { id: 'gemini', available: true },
        { id: 'codex', available: false },
      ],
    );
    // Detection never executes the package. Installation changes require restart.
    await rm(join(bin, process.platform === 'win32' ? 'gemini.cmd' : 'gemini'));
    peer.send({ type: 'getCapabilities', requestId: 'capabilities-cached' });
    assert.deepEqual((await peer.next('capabilities')).programs, capabilities.programs);
    if (process.platform !== 'win32') {
      await writeFile(join(bin, 'gemini'), unixFixture);
      await chmod(join(bin, 'gemini'), 0o755);
    }
    peer.send({ type: 'create', name: 'Unavailable', program: 'codex', requestId: 'missing-cli' });
    const unavailable = await peer.next('error');
    assert.equal(unavailable.requestId, 'missing-cli');
    assert.match(unavailable.message!, /Codex is not available/);
    peer.send({
      type: 'create',
      name: 'Bad cwd',
      cwd: join(fixture, 'does-not-exist'),
      requestId: 'bad-cwd',
    });
    const invalid = await peer.next('error');
    assert.equal(invalid.requestId, 'bad-cwd');
    assert.match(invalid.message!, /Starting directory/);
    peer.send({
      type: 'create',
      name: 'External CLI',
      program: 'gemini',
      cwd: outside,
      requestId: 'external-cli',
    });
    const created = await peer.next('created');
    assert.equal(created.requestId, 'external-cli');
    const snapshot = await peer.next(
      'sessions',
      event => event.sessions?.some(session => session.id === created.sessionId) ?? false,
    );
    const externalSession = snapshot.sessions!.find(session => session.id === created.sessionId)!;
    assert.equal(externalSession.cwd, outside);
    assert.equal(externalSession.program, 'gemini');
    peer.send({ type: 'attach', sessionId: created.sessionId, cols: 100, rows: 30 });
    await peer.next('attached');
    peer.send({ type: 'input', sessionId: created.sessionId, data: 'report\r' });
    const output = await peer.output(created.sessionId!, 'CLI_ARGC=');
    assert.ok(output.includes(`CLI_CWD=${outside}`), output);
    assert.ok(output.includes(`CLI_ARGC=${process.platform === 'win32' ? 2 : 0}`), output);
    assert.ok(!output.includes('WRAPPER_MUST_NOT_EXECUTE'));
    peer.send({ type: 'input', sessionId: created.sessionId, data: 'status-blocked\r' });
    const blocked = await peer.next(
      'sessions',
      event =>
        event.sessions?.some(
          session => session.id === created.sessionId && session.status?.state === 'blocked',
        ) ?? false,
    );
    const blockedStatus = blocked.sessions!.find(
      session => session.id === created.sessionId,
    )!.status!;
    assert.equal(blockedStatus.source, 'screen');
    assert.ok(blockedStatus.updatedAt > 0);
    // The status is authoritative for newly connected observers too.
    const observer = new Peer(pairing);
    try {
      await observer.authenticate();
      const observerSnapshot = await observer.next('sessions');
      assert.deepEqual(
        observerSnapshot.sessions!.find(session => session.id === created.sessionId)!.status,
        blockedStatus,
      );
      peer.send({ type: 'input', sessionId: created.sessionId, data: 'status-clear\r' });
      const cleared = await observer.next(
        'sessions',
        event =>
          event.sessions?.some(
            session => session.id === created.sessionId && session.status?.state === 'unknown',
          ) ?? false,
      );
      assert.equal(
        cleared.sessions!.find(session => session.id === created.sessionId)!.status!.source,
        'activity',
      );
      peer.send({ type: 'input', sessionId: created.sessionId, data: 'status-exit\r' });
      const exited = await observer.next(
        'sessions',
        event =>
          event.sessions?.some(
            session => session.id === created.sessionId && session.status?.state === 'failed',
          ) ?? false,
      );
      const ended = exited.sessions!.find(session => session.id === created.sessionId)!;
      assert.equal(ended.running, false);
      assert.equal(ended.status!.source, 'process');
    } finally {
      await observer.disconnect();
    }
    peer.send({ type: 'close', sessionId: created.sessionId });
    await peer.next('sessions', event => event.sessions?.length === 0);
    for (const [index, cwd] of ['nested', '   '].entries()) {
      peer.send({ type: 'create', name: 'Shell', cwd, requestId: `shell-${index}` });
      const shell = await peer.next('created');
      const snapshot = await peer.next(
        'sessions',
        event => event.sessions?.some(session => session.id === shell.sessionId) ?? false,
      );
      const shellSession = snapshot.sessions!.find(session => session.id === shell.sessionId)!;
      assert.equal(shellSession.program, 'shell');
      assert.equal(shellSession.cwd, index === 0 ? join(workspace, 'nested') : workspace);
      peer.send({ type: 'close', sessionId: shell.sessionId });
      await peer.next('sessions', event => event.sessions?.length === 0);
    }
    await peer.disconnect();
  } catch (error) {
    bodyFailure = error;
    throw error;
  } finally {
    peer?.socket.terminate();
    try {
      await stopFixtureHost(host);
    } finally {
      await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        cleanupError => {
          if (bodyFailure)
            throw new AggregateError(
              [bodyFailure, cleanupError],
              'Host fixture failed and cleanup did not complete',
            );
          throw cleanupError;
        },
      );
    }
  }
});
