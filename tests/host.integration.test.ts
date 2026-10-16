import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { decodeFrame, encodeFrame, keyBytes, parsePairing } from '../src/connection/wire';
import type { Pairing } from '../src/connection/types';

type Event = { type: string; sessionId?: string; data?: string; replay?: boolean; message?: string; clientNonce?: string; sessions?: { id: string; name: string; running: boolean }[] };

async function until<T>(read: () => T | undefined | Promise<T | undefined>, label: string, timeout = 10000): Promise<T> {
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
    this.socket.on('error', (error) => { this.error = error; });
    this.socket.on('close', (code) => { this.closeCode = code; this.closed = true; });
    this.socket.on('message', (data) => {
      try {
        const text = data.toString();
        if (!this.challenge) { this.challenge = JSON.parse(text).challenge; return; }
        const event = decodeFrame(text, keyBytes(this.pairing.key), this.challenge, 'host-to-client', ++this.incoming) as Event;
        this.events.push(event);
        // ConPTY asks the attached terminal for its initial cursor position.
        if (event.type === 'output' && event.data?.includes('\x1b[6n')) this.send({ type: 'input', sessionId: event.sessionId, data: '\x1b[1;1R' });
      } catch (error) { this.error = error as Error; }
    });
  }

  async hello(): Promise<void> { await until(() => this.challenge || undefined, 'host challenge'); }

  async authenticate(): Promise<void> {
    await this.hello();
    this.authFrame = this.send({ type: 'auth', clientNonce: this.nonce });
    const ready = await this.next('connected');
    assert.equal(ready.clientNonce, this.nonce, 'host proves freshness with client nonce');
  }

  send(command: unknown): string {
    const frame = encodeFrame(command, keyBytes(this.pairing.key), this.challenge, 'client-to-host', ++this.outgoing, randomBytes);
    this.socket.send(frame);
    return frame;
  }

  next(type: string, predicate: (event: Event) => boolean = () => true): Promise<Event> {
    return until(() => {
      if (this.error) throw this.error;
      const index = this.events.findIndex((event) => event.type === type && predicate(event));
      if (index >= 0) return this.events.splice(index, 1)[0];
      const failure = this.events.find((event) => event.type === 'error');
      if (failure && type !== 'error') throw new Error(`Host error: ${failure.message}`);
      return undefined;
    }, type);
  }

  async output(id: string, marker: string): Promise<string> {
    let seen = '';
    try { return await until(() => {
      if (this.error) throw this.error;
      const text = this.events.filter((event) => event.type === 'output' && event.sessionId === id).map((event) => event.data).join('');
      seen = text;
      return text.includes(marker) ? text : undefined;
    }, `shell output: ${marker}`, 20000); }
    catch (error) { throw new Error(`${String(error)}; terminal tail: ${JSON.stringify(seen.slice(-3500))}`); }
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.socket.close();
    await until(() => this.closed || undefined, 'socket closed');
  }
}

test('Rust host interoperates with TweetNaCl and preserves real PTYs securely', { timeout: 120000 }, async (suite) => {
  const fixture = await mkdtemp(join(tmpdir(), 'pocket-host-test-'));
  const binary = resolve('host/target/debug', process.platform === 'win32' ? 'pocket-sessions-host.exe' : 'pocket-sessions-host');
  const host: ChildProcess = spawn(binary, ['--port', '0', '--pairing-dir', fixture, '--workspace', process.cwd()], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  host.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  host.on('error', (error) => { stderr += error.message; });
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
      try { return parsePairing(await readFile(join(fixture, 'pairing.json'), 'utf8')); }
      catch { return undefined; }
    }, 'private pairing file');
    assert.match(await readFile(join(fixture, 'pairing.svg'), 'utf8'), /<svg/);

    await suite.test('wrong secret is rejected before any session is created', async () => {
      const invalid = peer(randomBytes(32).toString('hex'));
      await invalid.hello();
      invalid.send({ type: 'auth', clientNonce: invalid.nonce });
      await until(() => invalid.closed || undefined, 'wrong key closes connection');
      assert.equal(invalid.closeCode, 4003);
      assert.equal(invalid.events.length, 0);
    });

    await suite.test('recorded authentication cannot be reused on another connection or sequence', async () => {
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
    });

    await suite.test('untrusted browser origins are rejected', async () => {
      const rejected = await new Promise<number>((resolveStatus, reject) => {
        const socket = new WebSocket(pairing.url, { origin: 'https://untrusted.invalid' });
        socket.on('unexpected-response', (_request, response) => { resolveStatus(response.statusCode ?? 0); socket.terminate(); });
        socket.on('error', () => {});
        socket.on('open', () => { socket.close(); reject(new Error('Untrusted origin accepted')); });
      });
      assert.equal(rejected, 403);
    });

    await suite.test('real shell survives disconnect, replays output, resizes and closes', async () => {
      const first = peer();
      await first.authenticate();
      const empty = await first.next('sessions');
      assert.deepEqual(empty.sessions, []);
      first.send({ type: 'create', name: 'Integration shell' });
      const created = await first.next('sessions', (event) => event.sessions?.some((session) => session.name === 'Integration shell') ?? false);
      const id = created.sessions![0].id;
      first.send({ type: 'attach', sessionId: id, cols: 90, rows: 30 });
      await first.next('attached');
      const initialCommand = process.platform === 'win32'
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
      assert.ok(second.events.some((event) => event.type === 'output' && event.replay));
      second.send({ type: 'input', sessionId: id, data: process.platform === 'win32' ? 'Write-Output $pocketValue\r' : 'printf "%s\\n" "$pocketValue"\r' });
      await second.output(id, 'PERSIST_OK');
      second.send({ type: 'resize', sessionId: id, cols: 100, rows: 32 });
      second.send({ type: 'resize', sessionId: id, cols: 0, rows: 24 });
      assert.match((await second.next('error')).message!, /Terminal size/);
      second.send({ type: 'create', name: 'Second session' });
      const multiple = await second.next('sessions', (event) => event.sessions?.length === 2);
      assert.equal(multiple.sessions?.length, 2);
      for (const session of multiple.sessions!) second.send({ type: 'close', sessionId: session.id });
      await second.next('sessions', (event) => event.sessions?.length === 0);
      await second.disconnect();
    });
  } finally {
    for (const client of peers) client.socket.terminate();
    host.kill();
    await delay(200);
    // Only this mkdtemp fixture is removed; it contains ephemeral pairing credentials.
    await rm(fixture, { recursive: true, force: true });
  }
});
