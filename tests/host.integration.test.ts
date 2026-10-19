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
import { delimiter, dirname, join, resolve } from 'node:path';
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
  report?: {
    providerVersions?: { program: string; status: string; version: string | null }[];
    sessions?: {
      sessionId: string;
      publicationLatency: {
        scope: string;
        connectedBatches: number;
        events: number;
        p95Ms: number | null;
        maxMs: number | null;
      };
    }[];
  };
  type: string;
  code?: string;
  groupId?: string;
  revision?: number;
  groups?: { id: string; name: string; parentId: string | null }[];
  id?: string;
  enabled?: boolean;
  hostId?: string;
  templates?: { id: string; name: string; spec: { prompt: string } }[];
  records?: { id: string; spec: { prompt: string; muted: boolean }; state: string }[];
  schedules?: { id: string; name: string; state: string; result?: string }[];
  error?: string;
  sessionId?: string;
  data?: string;
  replay?: boolean;
  allowResponses?: boolean;
  message?: string;
  clientNonce?: string;
  requestId?: string;
  workspace?: string;
  programs?: { id: string; label: string; available: boolean }[];
  providerLimits?: { id: string; status: string; windows: unknown[] }[];
  directoryBrowser?: boolean;
  path?: string;
  parent?: string | null;
  entries?: { name: string; path: string }[];
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
  attached = new Set<string>();

  constructor(private pairing: Pairing & { scopeId?: string }) {
    this.socket = new WebSocket(pairing.url, {
      headers: pairing.scopeId ? { 'x-nesvo-scope': pairing.scopeId } : {},
    });
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
        if (event.type === 'attached' && event.sessionId) this.attached.add(event.sessionId);
        // ConPTY asks the attached terminal for its initial cursor position.
        if (
          event.type === 'output' &&
          event.sessionId &&
          this.attached.has(event.sessionId) &&
          (!event.replay || event.allowResponses) &&
          event.data?.includes('\x1b[6n')
        )
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
  'launch-scoped lifecycle reaches real helper, host and late observers without a model',
  { timeout: 60000 },
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'nesvo-lifecycle-'));
    const bin = join(fixture, 'bin');
    await mkdir(bin);
    const script = String.raw`#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
if(process.argv.includes('--version')) { console.log('2.1.303-fixture'); process.exit(0); }
require('node:fs').writeFileSync(process.env.NESVO_FIXTURE_CALLER_PATH,process.env.NESVO_AGENT_CONTEXT);
const settings=JSON.parse(process.argv[process.argv.indexOf('--settings')+1]);
function hook(name, extra={}) {
  const command=settings.hooks[name][0].hooks[0];
  const result=spawnSync(command.command,command.args,{windowsHide:true,input:JSON.stringify({hook_event_name:name,session_id:'fixture-conversation',agent_id:'',...extra}),stdio:['pipe','ignore','ignore']});
  if(result.status!==0) throw new Error('Fixture hook failed');
}
hook('SessionStart',{source:'startup'});
console.log('FIXTURE_READY');
process.stdin.on('data', bytes=>{
  const input=bytes.toString();
  if(input.includes('fast-exit')) { hook('UserPromptSubmit');hook('Stop');process.exit(0); }
  else if(input.includes('fast-turn')) { hook('UserPromptSubmit');hook('Stop'); }
  else if(input.includes('question')) { hook('UserPromptSubmit');hook('PreToolUse',{tool_name:'AskUserQuestion'}); }
  else if(input.includes('child-stop')) hook('Stop',{agent_id:'native-child'});
  else if(input.includes('foreign-stop')) hook('Stop',{session_id:'foreign-conversation'});
});process.stdin.resume();`;
    if (process.platform === 'win32') {
      await link(process.execPath, join(bin, 'node.exe')).catch(() =>
        copyFile(process.execPath, join(bin, 'node.exe')),
      );
      const pkg = join(bin, 'node_modules', '@anthropic-ai', 'claude-code');
      await mkdir(pkg, { recursive: true });
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ bin: { claude: 'main.js' } }));
      await writeFile(join(pkg, 'main.js'), script);
      await writeFile(join(bin, 'claude.cmd'), '@echo off\r\necho SHIM_MUST_NOT_EXECUTE\r\n');
    } else {
      await link(process.execPath, join(bin, 'node')).catch(() =>
        copyFile(process.execPath, join(bin, 'node')),
      );
      await chmod(join(bin, 'node'), 0o755);
      await writeFile(join(bin, 'claude'), script);
      await chmod(join(bin, 'claude'), 0o755);
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
    );
    env.PATH = [bin, dirname(process.execPath)].join(delimiter);
    env.NESVO_FIXTURE_CALLER_PATH = join(fixture, 'caller-path.txt');
    const host = spawn(
      hostBinary(),
      [
        '--port',
        '0',
        '--pairing-dir',
        join(fixture, 'pairing'),
        '--workspace',
        fixture,
        '--exit-on-stdin-close',
      ],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    host.stdout?.resume();
    host.stderr?.resume();
    let peer: Peer | undefined;
    try {
      const pairing = await until(async () => {
        try {
          return parsePairing(await readFile(join(fixture, 'pairing', 'pairing.json'), 'utf8'));
        } catch {
          return undefined;
        }
      }, 'lifecycle pairing');
      peer = new Peer(pairing);
      await peer.authenticate();
      await peer.next('sessions');
      peer.send({
        type: 'create',
        name: 'Lifecycle fixture',
        program: 'claude',
        requestId: 'lifecycle-create',
      });
      const id = (await peer.next('created', e => e.requestId === 'lifecycle-create')).sessionId!;
      peer.send({ type: 'attach', sessionId: id, cols: 100, rows: 32 });
      await peer.next('attached');
      await peer.output(id, 'FIXTURE_READY');
      const contextPath = await readFile(env.NESVO_FIXTURE_CALLER_PATH, 'utf8');
      const scopedPairing = JSON.parse(await readFile(contextPath, 'utf8')) as Pairing & {
        scopeId: string;
      };
      assert.notEqual(scopedPairing.key, pairing.key);
      const scoped = new Peer(scopedPairing);
      await scoped.authenticate();
      const scopedInitial = await scoped.next('sessions');
      assert.deepEqual(
        scopedInitial.sessions?.map(s => s.id),
        [id],
      );
      peer.send({
        type: 'create',
        name: 'Unrelated private process',
        program: 'shell',
        requestId: 'private-other',
      });
      const other = (await peer.next('created', e => e.requestId === 'private-other')).sessionId!;
      const outsider = new Peer(pairing);
      await outsider.authenticate();
      outsider.send({ type: 'attach', sessionId: other, cols: 80, rows: 24 });
      await outsider.next('attached', e => e.sessionId === other);
      peer.send({
        type: 'createGroup',
        name: 'Unrelated private group',
        parentId: null,
        expectedRevision: 0,
        requestId: 'private-group',
      });
      const privateGroup = await peer.next('groupCreated', e => e.requestId === 'private-group');
      peer.send({
        type: 'moveSession',
        sessionId: other,
        groupId: privateGroup.groupId,
        expectedRevision: privateGroup.revision,
        requestId: 'private-move',
      });
      await peer.next('updated', e => e.requestId === 'private-move');
      for (const forbidden of [
        { type: 'getSession', sessionId: other },
        { type: 'getDiagnostics' },
        { type: 'acquireControl', sessionId: id, cols: 80, rows: 24 },
        { type: 'input', sessionId: id, data: 'DO_NOT_SEND\r' },
        { type: 'getDiff', sessionId: id, scope: 'unstaged', directory: fixture },
        { type: 'launch', spec: { name: 'unauthorized', program: 'shell' } },
        { type: 'close', sessionId: other },
      ]) {
        scoped.send({ ...forbidden, requestId: 'forbidden' });
        assert.equal(
          (await scoped.next('error', e => e.requestId === 'forbidden')).code,
          'forbidden',
        );
      }
      scoped.send({ type: 'list', requestId: 'scope-list' });
      const scopedList = await scoped.next('sessions', e => e.requestId === 'scope-list');
      assert.deepEqual(scopedList.groups, [], 'foreign group names and rollups are not broadcast');
      assert.ok(
        scoped.events.every(e => e.sessionId !== other),
        'background control notifications cannot reveal foreign sessions',
      );
      await outsider.disconnect();
      for (const proof of ['wrong-key', 'recorded-auth']) {
        const impostor = new Peer(
          proof === 'wrong-key' ? { ...scopedPairing, key: pairing.key } : scopedPairing,
        );
        await impostor.hello();
        if (proof === 'wrong-key') impostor.send({ type: 'auth', clientNonce: impostor.nonce });
        else impostor.socket.send(scoped.authFrame);
        await until(() => impostor.closed || undefined, 'scoped authentication rejection');
        assert.equal(impostor.closeCode, 4003);
      }
      assert.deepEqual(
        scopedList.sessions?.map(s => s.id),
        [id],
      );
      await peer.next(
        'sessions',
        e =>
          e.sessions?.some(
            s => s.id === id && s.status?.evidence === 'hook' && s.status.state === 'idle',
          ) ?? false,
      );
      peer.send({ type: 'input', sessionId: id, data: 'question\r' });
      const question = await peer.next(
        'sessions',
        e => e.sessions?.some(s => s.id === id && s.lifecycle?.turn?.phase === 'waiting') ?? false,
      );
      const waiting = question.sessions!.find(s => s.id === id)!;
      assert.equal(waiting.lifecycle?.agent.blockReason, 'question');
      assert.equal(waiting.currentAttention?.reason, 'question');
      assert.equal(waiting.currentAttention?.priority, 3);
      const oldTurn = waiting.lifecycle!.turn!.id;
      peer.send({ type: 'input', sessionId: id, data: 'child-stop\r' });
      peer.send({ type: 'input', sessionId: id, data: 'foreign-stop\r' });
      await delay(600);
      peer.send({ type: 'list', requestId: 'after-foreign' });
      const stillWaiting = await peer.next(
        'sessions',
        e =>
          e.requestId === 'after-foreign' &&
          (e.sessions?.some(s => s.id === id && s.lifecycle?.turn?.id === oldTurn) ?? false),
      );
      assert.equal(
        stillWaiting.sessions!.find(s => s.id === id)!.lifecycle?.turn?.phase,
        'waiting',
      );
      peer.send({ type: 'input', sessionId: id, data: 'fast-turn\r' });
      const settled = await peer.next(
        'sessions',
        e => e.sessions?.some(s => s.id === id && s.lifecycle?.turn?.phase === 'settled') ?? false,
      );
      let turn = settled.sessions!.find(s => s.id === id)!.lifecycle!.turn!;
      assert.equal(settled.sessions!.find(s => s.id === id)!.currentAttention?.priority, 0);
      const completion = settled.sessions!.find(s => s.id === id)!.attention;
      assert.equal(completion?.subject, 'response');
      assert.equal(completion?.turnId, turn.id);
      assert.equal(completion?.unread, true);
      // No model calls: measure real helper/journal/tick/transport batches with a controlled CLI.
      for (let sample = 0; sample < 12; sample++) {
        peer.send({ type: 'input', sessionId: id, data: 'question\r' });
        const sampleQuestion = await peer.next(
          'sessions',
          e =>
            e.sessions?.some(
              s =>
                s.id === id &&
                s.lifecycle?.turn?.phase === 'waiting' &&
                s.lifecycle.turn.id !== turn.id,
            ) ?? false,
        );
        const questionId = sampleQuestion.sessions!.find(s => s.id === id)!.lifecycle!.turn!.id;
        peer.send({ type: 'input', sessionId: id, data: 'fast-turn\r' });
        const sampleEnd = await peer.next(
          'sessions',
          e =>
            e.sessions?.some(
              s =>
                s.id === id &&
                s.lifecycle?.turn?.phase === 'settled' &&
                s.lifecycle.turn.id !== turn.id &&
                s.lifecycle.turn.id !== questionId,
            ) ?? false,
        );
        turn = sampleEnd.sessions!.find(s => s.id === id)!.lifecycle!.turn!;
      }
      peer.send({ type: 'getDiagnostics', sessionId: id, requestId: 'latency' });
      const latency = (
        await peer.next('diagnostics', e => e.requestId === 'latency')
      ).report?.sessions?.find(s => s.sessionId === id)?.publicationLatency;
      assert.ok(latency);
      assert.equal(latency.scope, 'hostReceiptToSnapshotEnqueue');
      assert.ok(latency.connectedBatches >= 24);
      assert.ok(latency.events >= 26);
      assert.ok(latency.p95Ms !== null && latency.p95Ms <= 1000, JSON.stringify(latency));
      console.log('Controlled status publication:', JSON.stringify(latency));
      assert.notEqual(turn.id, oldTurn);
      assert.match(turn.outcome!, /task result not established/);
      const observer = new Peer(pairing);
      try {
        await observer.authenticate();
        const snapshot = await observer.next('sessions');
        const observed = snapshot.sessions!.find(s => s.id === id)!;
        assert.equal(observed.lifecycle?.turn?.id, turn.id);
        assert.equal(observed.lifecycle?.process.running, true);
        assert.equal(observed.attention?.turnId, turn.id);
        peer.send({ type: 'input', sessionId: id, data: 'fast-exit\r' });
        const ended = await observer.next(
          'sessions',
          e =>
            e.sessions?.some(
              s =>
                s.id === id &&
                !s.running &&
                s.lifecycle?.turn?.phase === 'settled' &&
                s.lifecycle.turn.id !== turn.id,
            ) ?? false,
        );
        assert.equal(ended.sessions!.find(s => s.id === id)!.lifecycle?.agent.current, null);
        scoped.send({ type: 'getSession', sessionId: id, requestId: 'revoked' });
        assert.equal(
          (await scoped.next('error', e => e.requestId === 'revoked')).code,
          'scope_revoked',
        );
      } finally {
        await scoped.disconnect();
        await observer.disconnect();
      }
    } finally {
      peer?.socket.terminate();
      await stopFixtureHost(host);
      await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

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
          first.send({
            type: 'input',
            sessionId: id,
            data:
              process.platform === 'win32'
                ? "Write-Output ('NESTED_MARKER=' + $env:NESVO_SESSION)\r"
                : 'printf "NESTED_MARKER=%s\\n" "$NESVO_SESSION"\r',
          });
          await first.output(id, 'NESTED_MARKER=1');

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
if [ "$1" = "--version" ]; then printf '0.0.0-fixture\n'; exit 0; fi
printf 'CLI_PROMPT=%s\n' "$*"
while IFS= read -r input; do
  case "$input" in
    status-blocked*) printf '\033[2J\033[HAllow execution of [Shell]?\r\n1. Allow once\r\n2. No, suggest changes (esc)' ;;
    status-clear*) printf '\033[2J\033[HUnrecognized ordinary output\r\n' ;;
    status-osc*) printf '\033]7501;state=working:app=fixture\007\033]7501;state=blocked:id=child:kind=question\007' ;;
    status-reset*) printf '\033]7501;state=clear\007\033[2J\033[HClear protocol\r\n' ;;
    status-exit*) exit 7 ;;
    *) printf 'CLI_CWD=%s\nCLI_ARGC=0\nCLI_NO_COLOR=%s\n' "$PWD" "${'$'}{NO_COLOR-<unset>}" ;;
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
      String.raw`if(process.argv.includes('--version')) { process.stdout.write('0.0.0-fixture\n'); process.exit(0); }
      process.stdout.write('CLI_PROMPT='+JSON.stringify(process.argv.slice(2))+'\n');
      process.stdin.on('data', data => {
        const command = data.toString();
        if (command.includes('status-blocked')) process.stdout.write('\x1b[2J\x1b[HAllow execution of [Shell]?\r\n1. Allow once\r\n2. No, suggest changes (esc)');
        else if (command.includes('status-clear')) process.stdout.write('\x1b[2J\x1b[HUnrecognized ordinary output\r\n');
        else if (command.includes('status-osc')) process.stdout.write('\x1b]7501;state=working:app=fixture\x07\x1b]7501;state=blocked:id=child:kind=question\x07');
        else if (command.includes('status-reset')) process.stdout.write('\x1b]7501;state=clear\x07\x1b[2J\x1b[HClear protocol\r\n');
        else if (command.includes('status-exit')) process.exit(7);
        else process.stdout.write('CLI_CWD='+process.cwd()+'\nCLI_ARGC='+process.argv.length+'\nCLI_NO_COLOR='+(process.env.NO_COLOR ?? '<unset>')+'\n');
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
      env: { ...env, PATH: bin, NO_COLOR: '1' },
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
    assert.equal(capabilities.directoryBrowser, true);
    assert.deepEqual(capabilities.providerLimits, [
      { id: 'gemini', status: 'unavailable', windows: [] },
    ]);
    peer.send({ type: 'listDirectories', requestId: 'browse-workspace' });
    const directory = await peer.next('directories');
    assert.equal(directory.requestId, 'browse-workspace');
    assert.equal(directory.path, workspace);
    assert.deepEqual(directory.entries, [{ name: 'nested', path: join(workspace, 'nested') }]);
    peer.send({
      type: 'listDirectories',
      path: join(workspace, 'nested'),
      requestId: 'browse-child',
    });
    const childDirectory = await peer.next('directories');
    assert.equal(childDirectory.requestId, 'browse-child');
    assert.equal(childDirectory.parent, workspace);
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
    assert.ok(output.includes('CLI_NO_COLOR=<unset>'), output);
    assert.ok(!output.includes('WRAPPER_MUST_NOT_EXECUTE'));
    peer.send({
      type: 'getDiagnostics',
      sessionId: created.sessionId,
      requestId: 'provider-version',
    });
    const diagnostic = await peer.next('diagnostics', e => e.requestId === 'provider-version');
    assert.equal(
      diagnostic.report?.providerVersions?.find(v => v.program === 'gemini')?.version,
      '0.0.0-fixture',
    );
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
      peer.send({ type: 'input', sessionId: created.sessionId, data: 'status-osc\r' });
      const structured = await observer.next(
        'sessions',
        event =>
          event.sessions?.some(
            s =>
              s.id === created.sessionId &&
              s.status?.confirmedSource === 'osc7501' &&
              s.status.state === 'working',
          ) ?? false,
      );
      assert.equal(
        structured.sessions!.find(s => s.id === created.sessionId)!.status!.source,
        'screen',
      );
      // Child blocker must not overwrite its working parent, including after reconnect.
      const lateObserver = new Peer(pairing);
      await lateObserver.authenticate();
      const late = await lateObserver.next('sessions');
      assert.equal(late.sessions!.find(s => s.id === created.sessionId)!.status!.state, 'working');
      await lateObserver.disconnect();
      assert.ok(
        !peer.events.filter(e => e.type === 'output').some(e => e.data?.includes('\x1b]7501;')),
        'host-owned protocol is absent from live output and replay',
      );
      peer.send({ type: 'input', sessionId: created.sessionId, data: 'status-reset\r' });
      await observer.next(
        'sessions',
        event =>
          event.sessions?.some(s => s.id === created.sessionId && s.status?.state === 'unknown') ??
          false,
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
    // One-shot schedules launch the fixture CLI without any attached controller.
    // No model account, authentication flow, or paid provider is used by this test.
    const scheduledPrompt = 'SCHEDULE_LITERAL & %KEEP% "quoted"';
    peer.send({
      type: 'scheduleSession',
      requestId: 'schedule-run',
      spec: { name: 'Scheduled fixture', program: 'gemini', cwd: outside, prompt: scheduledPrompt },
      at: new Date(Date.now() + 3000).toISOString(),
    });
    const scheduled = await peer.next('scheduled');
    assert.equal(scheduled.requestId, 'schedule-run');
    const launched = await peer.next(
      'sessions',
      event => event.sessions?.some(session => session.name === 'Scheduled fixture') ?? false,
    );
    const scheduledSession = launched.sessions!.find(
      session => session.name === 'Scheduled fixture',
    )!;
    assert.equal(scheduledSession.cwd, outside);
    peer.send({ type: 'subscribe', sessionId: scheduledSession.id });
    await peer.next('subscribed');
    const promptOutput = await peer.output(scheduledSession.id, 'SCHEDULE_LITERAL');
    assert.ok(promptOutput.includes('--prompt-interactive'));
    assert.ok(promptOutput.includes('%KEEP%'));
    peer.send({ type: 'listSchedules' });
    const jobs = await peer.next(
      'schedules',
      event =>
        event.schedules?.some(job => job.id === scheduled.id && job.state === 'started') ?? false,
    );
    assert.equal(jobs.schedules!.find(job => job.id === scheduled.id)!.result, scheduledSession.id);
    peer.send({
      type: 'getDiff',
      sessionId: scheduledSession.id,
      scope: 'unstaged',
      requestId: 'not-a-repository',
    });
    const diff = await peer.next('diff');
    assert.equal(diff.requestId, 'not-a-repository');
    assert.ok(diff.error);
    peer.send({ type: 'close', sessionId: scheduledSession.id });
    await peer.next('sessions', event => event.sessions?.length === 0);
    peer.send({
      type: 'scheduleSession',
      spec: { name: 'Cancelled fixture', program: 'gemini', prompt: 'Must not launch' },
      at: new Date(Date.now() + 120000).toISOString(),
    });
    const cancelled = await peer.next('scheduled');
    peer.send({ type: 'cancelSchedule', id: cancelled.id });
    await peer.next(
      'schedules',
      event =>
        event.schedules?.some(job => job.id === cancelled.id && job.state === 'cancelled') ?? false,
    );
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

test(
  'templates, notification consent and recovery survive host restart without replaying input',
  { timeout: 90000 },
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'nesvo-workflows-'));
    let host: ChildProcess | undefined;
    let peer: Peer | undefined;
    async function start() {
      host = spawn(
        hostBinary(),
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
      let ready = false;
      let failure = '';
      host.stdout?.on('data', data => {
        ready ||= data.toString().includes('Rust host listening');
      });
      host.stderr?.on('data', data => {
        failure += data.toString();
      });
      host.on('error', error => {
        failure += error.message;
      });
      await until(() => {
        if (host?.exitCode !== null || failure) throw new Error(failure);
        return ready || undefined;
      }, 'workflow host');
      peer = new Peer(parsePairing(await readFile(join(fixture, 'pairing.json'), 'utf8')));
      await peer.authenticate();
      await peer.next('sessions');
      return peer;
    }
    try {
      let client = await start();
      client.send({ type: 'getCapabilities' });
      const identity = (await client.next('capabilities')).hostId;
      assert.match(identity!, /^[a-f0-9]{32}$/);
      client.send({
        type: 'registerPush',
        token: 'https://invalid.example',
        enabled: true,
        requestId: 'bad-push',
      });
      await client.next('error', e => e.requestId === 'bad-push');
      // Never send a push: unregister the fixture token before creating a process.
      client.send({ type: 'registerPush', token: 'ExpoPushToken[fixture123456]', enabled: true });
      assert.equal((await client.next('pushRegistered')).enabled, true);
      client.send({ type: 'registerPush', token: 'ExpoPushToken[fixture123456]', enabled: false });
      assert.equal((await client.next('pushRegistered')).enabled, false);
      client.send({
        type: 'saveTemplate',
        name: 'Review recipe',
        spec: {
          name: 'Review',
          program: 'claude',
          prompt: 'Do not execute this fixture prompt',
          worktree: false,
        },
      });
      const template = (await client.next('templates')).templates![0]!;
      client.send({
        type: 'create',
        name: 'Recover me',
        program: 'shell',
        requestId: 'recoverable',
      });
      const id = (await client.next('created', e => e.requestId === 'recoverable')).sessionId!;
      client.send({ type: 'muteSession', sessionId: id, muted: true });
      await client.next('sessions', e => e.sessions?.some(s => s.id === id && s.muted) ?? false);
      await client.disconnect();
      await stopFixtureHost(host!);
      client = await start();
      client.send({ type: 'getCapabilities' });
      assert.equal((await client.next('capabilities')).hostId, identity);
      client.send({ type: 'listTemplates' });
      assert.equal((await client.next('templates')).templates![0]!.id, template.id);
      client.send({ type: 'listRecovery' });
      const saved = (await client.next('recovery')).records!.find(r => r.id === id)!;
      assert.equal(saved.spec.prompt, '');
      assert.equal(saved.spec.muted, true);
      client.send({ type: 'restoreSession', id, requestId: 'restore' });
      const newId = (await client.next('created', e => e.requestId === 'restore')).sessionId!;
      assert.notEqual(newId, id);
      await client.next('sessions', e => e.sessions?.some(s => s.id === newId && s.muted) ?? false);
      client.send({ type: 'restoreSession', id, requestId: 'duplicate' });
      await client.next('error', e => e.requestId === 'duplicate');
      client.send({ type: 'close', sessionId: newId });
      await client.next('sessions', e => e.sessions?.length === 0);
      await client.disconnect();
    } finally {
      peer?.socket.terminate();
      if (host) await stopFixtureHost(host);
      await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
