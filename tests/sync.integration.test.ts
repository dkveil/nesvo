import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import type { Pairing, SessionGroup, TerminalSession } from '../src/connection/types';
import { decodeFrame, encodeFrame, keyBytes, parsePairing } from '../src/connection/wire';

type Event = {
  type: string;
  requestId?: string;
  clientNonce?: string;
  clientId?: number;
  protocolVersion?: number;
  revision?: number;
  groups?: SessionGroup[];
  sessions?: TerminalSession[];
  sessionId?: string;
  groupId?: string;
  controllerId?: number | null;
  leaseId?: string;
  cols?: number;
  rows?: number;
  data?: string;
  replay?: boolean;
  code?: string;
  message?: string;
};

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

class Peer {
  readonly socket: WebSocket;
  readonly events: Event[] = [];
  readonly leases = new Map<string, string>();
  readonly nonce = randomBytes(32).toString('hex');
  private challenge = '';
  private incoming = 0;
  private outgoing = 0;
  private error?: Error;
  clientId?: number;
  closed = false;

  constructor(private pairing: Pairing) {
    this.socket = new WebSocket(pairing.url);
    this.socket.on('error', (error) => {
      this.error = error;
    });
    this.socket.on('close', () => {
      this.closed = true;
      this.leases.clear();
    });
    this.socket.on('message', (data) => {
      try {
        if (!this.challenge) {
          this.challenge = JSON.parse(data.toString()).challenge;
          return;
        }
        const event = decodeFrame(
          data.toString(),
          keyBytes(pairing.key),
          this.challenge,
          'host-to-client',
          ++this.incoming,
        ) as Event;
        this.events.push(event);
        if (event.type === 'control' && event.sessionId) {
          if (event.controllerId === this.clientId && event.leaseId)
            this.leases.set(event.sessionId, event.leaseId);
          else this.leases.delete(event.sessionId);
        }
        // A viewer must never answer terminal queries. The controller answers ConPTY's startup DSR.
        if (event.type === 'output' && event.sessionId && event.data?.includes('\x1b[6n')) {
          const leaseId = this.leases.get(event.sessionId);
          if (leaseId)
            this.send({ type: 'input', sessionId: event.sessionId, leaseId, data: '\x1b[1;1R' });
        }
      } catch (error) {
        this.error = error as Error;
      }
    });
  }

  async connect() {
    await until(() => this.challenge || undefined, 'challenge');
    this.send({ type: 'auth', clientNonce: this.nonce });
    const event = await this.next('connected');
    assert.equal(event.clientNonce, this.nonce);
    assert.equal(event.protocolVersion, 2);
    assert.equal(typeof event.clientId, 'number');
    this.clientId = event.clientId;
    return this.next('sessions');
  }

  send(command: unknown) {
    this.socket.send(
      encodeFrame(
        command,
        keyBytes(this.pairing.key),
        this.challenge,
        'client-to-host',
        ++this.outgoing,
        randomBytes,
      ),
    );
  }

  next(type: string, matches: (event: Event) => boolean = () => true): Promise<Event> {
    return until(() => {
      if (this.error) throw this.error;
      const index = this.events.findIndex((event) => event.type === type && matches(event));
      if (index >= 0) return this.events.splice(index, 1)[0];
      return undefined;
    }, type);
  }

  async snapshot(revision?: number) {
    this.events.splice(
      0,
      this.events.length,
      ...this.events.filter((event) => event.type !== 'sessions'),
    );
    this.send({ type: 'list' });
    return this.next('sessions', (event) => revision === undefined || event.revision === revision);
  }

  async request(command: Record<string, unknown>, response: string) {
    const requestId = randomBytes(8).toString('hex');
    this.send({ ...command, requestId });
    return this.next(response, (event) => event.requestId === requestId);
  }

  async acquire(sessionId: string, cols = 90, rows = 28, takeOver = false) {
    this.discardControl(sessionId);
    this.send({ type: 'acquireControl', sessionId, cols, rows, takeOver });
    const event = await this.next(
      'control',
      (item) =>
        item.sessionId === sessionId &&
        item.controllerId === this.clientId &&
        Boolean(item.leaseId),
    );
    assert.ok(event.leaseId);
    return event.leaseId;
  }

  discardControl(sessionId: string) {
    this.events.splice(
      0,
      this.events.length,
      ...this.events.filter((event) => event.type !== 'control' || event.sessionId !== sessionId),
    );
  }

  async output(sessionId: string, marker: string) {
    return until(
      () => {
        if (this.error) throw this.error;
        const output = this.events
          .filter((event) => event.type === 'output' && event.sessionId === sessionId)
          .map((event) => event.data ?? '')
          .join('');
        return output.includes(marker) ? output : undefined;
      },
      `real shell output ${marker}`,
      25000,
    );
  }

  async disconnect() {
    this.socket.close();
    await until(() => this.closed || undefined, 'client disconnect');
  }
}

test(
  'v2 synchronizes hierarchy, observers, leases and durable metadata across clients',
  { timeout: 150000 },
  async (suite) => {
    const fixture = await mkdtemp(join(tmpdir(), 'pocket-sync-'));
    const binary = resolve(
      'host/target/debug',
      `nesvo-host${process.platform === 'win32' ? '.exe' : ''}`,
    );
    const peers: Peer[] = [];
    let host: ChildProcess | undefined;
    let pairing: Pairing;
    async function start() {
      let stdout = '';
      let stderr = '';
      let failure: Error | undefined;
      host = spawn(
        binary,
        ['--port', '0', '--pairing-dir', fixture, '--workspace', process.cwd()],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      host.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      host.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      host.on('error', (error) => {
        failure = error;
      });
      await until(() => {
        if (failure) throw failure;
        if (host?.exitCode !== null) throw new Error(`Host exited: ${stderr}`);
        return stdout.includes('Rust host listening') || undefined;
      }, 'host startup');
      pairing = parsePairing(await readFile(join(fixture, 'pairing.json'), 'utf8'));
    }
    async function stop() {
      if (!host || host.exitCode !== null) return;
      const process = host;
      await new Promise<void>((resolveExit) => {
        process.once('exit', () => resolveExit());
        process.kill();
      });
    }
    async function connect() {
      const peer = new Peer(pairing);
      peers.push(peer);
      await peer.connect();
      return peer;
    }
    let parentId = '';
    let childId = '';
    let sessionId = '';
    let revision = 0;
    try {
      await start();
      const mobile = await connect();
      const desktop = await connect();

      await suite.test(
        'hierarchy changes are synchronized and stale writers cannot overwrite them',
        async () => {
          const parent = await mobile.request(
            { type: 'createGroup', name: 'Workspace', parentId: null, expectedRevision: revision },
            'groupCreated',
          );
          assert.ok(parent.groupId);
          parentId = parent.groupId;
          revision = parent.revision!;
          const synced = await desktop.next('sessions', (event) => event.revision === revision);
          assert.equal(synced.groups?.find((group) => group.id === parentId)?.name, 'Workspace');
          const child = await desktop.request(
            { type: 'createGroup', name: 'Mobile', parentId, expectedRevision: revision },
            'groupCreated',
          );
          childId = child.groupId!;
          revision = child.revision!;
          const childSnapshot = await mobile.next(
            'sessions',
            (event) => event.revision === revision,
          );
          assert.equal(
            childSnapshot.groups?.find((group) => group.id === childId)?.parentId,
            parentId,
          );
          const stale = await mobile.request(
            { type: 'createGroup', name: 'Stale', parentId: null, expectedRevision: 0 },
            'error',
          );
          assert.equal(stale.code, 'revision_conflict');
          assert.equal(stale.revision, revision);
          for (const command of [
            { type: 'updateGroup', groupId: parentId, name: 'Cycle', parentId: childId, order: 0 },
            { type: 'createGroup', name: 'Orphan', parentId: 'missing' },
            { type: 'deleteGroup', groupId: parentId },
            { type: 'createGroup', name: '\n', parentId: null },
          ]) {
            const rejected = await desktop.request(
              { ...command, expectedRevision: revision },
              'error',
            );
            assert.ok(rejected.message);
          }
          assert.equal(
            (await mobile.snapshot()).revision,
            revision,
            'invalid mutations must not increment revision',
          );
        },
      );

      await suite.test('same-name creation is correlated and session moves propagate', async () => {
        const created = await mobile.request(
          { type: 'create', name: 'Same name', groupId: childId },
          'created',
        );
        sessionId = created.sessionId!;
        const second = await desktop.request({ type: 'create', name: 'Same name' }, 'created');
        assert.notEqual(second.sessionId, sessionId);
        const snapshot = await desktop.snapshot();
        assert.equal(
          snapshot.sessions?.find((session) => session.id === sessionId)?.groupId,
          childId,
        );
        const moved = await desktop.request(
          {
            type: 'moveSession',
            sessionId: second.sessionId,
            groupId: parentId,
            expectedRevision: revision,
          },
          'updated',
        );
        revision = moved.revision!;
        const sync = await mobile.next('sessions', (event) => event.revision === revision);
        assert.equal(
          sync.sessions?.find((session) => session.id === second.sessionId)?.groupId,
          parentId,
        );
        const busy = await mobile.request(
          { type: 'deleteGroup', groupId: childId, expectedRevision: revision },
          'error',
        );
        assert.ok(busy.message);
        desktop.send({ type: 'close', sessionId: second.sessionId });
        await mobile.next('sessions', (event) => event.sessions?.length === 1);
      });

      await suite.test(
        'both observe output; only the current lease can input or resize',
        async () => {
          mobile.send({ type: 'subscribe', sessionId });
          desktop.send({ type: 'subscribe', sessionId });
          await mobile.next('subscribed');
          const passive = await desktop.next('subscribed');
          const firstLease = await mobile.acquire(sessionId, 92, 29);
          const controller = await desktop.next(
            'control',
            (event) => event.controllerId === mobile.clientId,
          );
          assert.equal(controller.leaseId, undefined, 'lease must not leak to other clients');
          assert.equal(controller.cols, 92);
          const command =
            process.platform === 'win32'
              ? "$syncValue = 'SHARED' + '_VARIABLE'; Write-Output ('BOTH_' + 'OBSERVE')\r"
              : "syncValue='SHARED''_VARIABLE'; printf 'BOTH_%s\\n' OBSERVE\r";
          mobile.send({ type: 'input', sessionId, leaseId: firstLease, data: command });
          await Promise.all([
            mobile.output(sessionId, 'BOTH_OBSERVE'),
            desktop.output(sessionId, 'BOTH_OBSERVE'),
          ]);
          assert.ok(passive.cols);
          for (const command of [
            { type: 'input', sessionId, data: 'invalid\r' },
            { type: 'resize', sessionId, cols: 20, rows: 5 },
            { type: 'acquireControl', sessionId, cols: 80, rows: 24 },
          ])
            assert.ok((await desktop.request(command, 'error')).message);
          assert.ok(
            (await mobile.request({ type: 'input', sessionId, data: 'missing lease\r' }, 'error'))
              .message,
          );
          assert.equal(
            (await desktop.snapshot()).sessions?.find((session) => session.id === sessionId)?.cols,
            92,
          );
          const secondLease = await desktop.acquire(sessionId, 100, 32, true);
          assert.notEqual(secondLease, firstLease);
          await mobile.next(
            'control',
            (event) => event.sessionId === sessionId && event.controllerId === desktop.clientId,
          );
          assert.ok(
            (
              await mobile.request(
                { type: 'input', sessionId, leaseId: firstLease, data: 'old lease\r' },
                'error',
              )
            ).message,
          );
          desktop.send({
            type: 'input',
            sessionId,
            leaseId: secondLease,
            data:
              process.platform === 'win32'
                ? 'Write-Output $syncValue\r'
                : 'printf "%s\\n" "$syncValue"\r',
          });
          await Promise.all([
            mobile.output(sessionId, 'SHARED_VARIABLE'),
            desktop.output(sessionId, 'SHARED_VARIABLE'),
          ]);
          desktop.send({ type: 'resize', sessionId, leaseId: secondLease, cols: 110, rows: 35 });
          await mobile.next('control', (event) => event.cols === 110 && event.rows === 35);
          mobile.discardControl(sessionId);
          desktop.send({ type: 'releaseControl', sessionId, leaseId: secondLease });
          await mobile.next(
            'control',
            (event) => event.sessionId === sessionId && event.controllerId === null,
          );
          const fresh = await desktop.acquire(sessionId);
          assert.notEqual(fresh, secondLease);
          assert.ok(
            (
              await desktop.request(
                { type: 'resize', sessionId, leaseId: secondLease, cols: 80, rows: 24 },
                'error',
              )
            ).message,
          );
          mobile.discardControl(sessionId);
          await desktop.disconnect();
          await mobile.next(
            'control',
            (event) => event.sessionId === sessionId && event.controllerId === null,
          );
          const resumed = await mobile.acquire(sessionId);
          mobile.send({
            type: 'input',
            sessionId,
            leaseId: resumed,
            data:
              process.platform === 'win32'
                ? "Write-Output ('AFTER_' + 'DETACH')\r"
                : "printf 'AFTER_%s\\n' DETACH\r",
          });
          await mobile.output(sessionId, 'AFTER_DETACH');
        },
      );

      await suite.test(
        'one client observes multiple sessions without losing the first subscription',
        async () => {
          const second = await mobile.request({ type: 'create', name: 'Second pane' }, 'created');
          const secondId = second.sessionId!;
          const viewer = await connect();
          viewer.send({ type: 'subscribe', sessionId });
          viewer.send({ type: 'subscribe', sessionId: secondId });
          await viewer.next('subscribed', (event) => event.sessionId === sessionId);
          await viewer.next('subscribed', (event) => event.sessionId === secondId);
          const secondLease = await mobile.acquire(secondId);
          for (const [id, leaseId, marker] of [
            [sessionId, mobile.leases.get(sessionId), 'ONE'],
            [secondId, secondLease, 'TWO'],
          ]) {
            mobile.send({
              type: 'input',
              sessionId: id,
              leaseId,
              data:
                process.platform === 'win32'
                  ? `Write-Output ('PANE_' + '${marker}')\r`
                  : `printf 'PANE_%s\\n' ${marker}\r`,
            });
            await viewer.output(id!, `PANE_${marker}`);
          }
          viewer.send({ type: 'unsubscribe', sessionId: secondId });
          await viewer.next('unsubscribed');
          viewer.events.length = 0;
          mobile.send({
            type: 'input',
            sessionId: secondId,
            leaseId: secondLease,
            data:
              process.platform === 'win32'
                ? "Write-Output ('PRIVATE_' + 'PANE')\r"
                : "printf 'PRIVATE_%s\\n' PANE\r",
          });
          await mobile.output(secondId, 'PRIVATE_PANE');
          assert.equal(
            viewer.events.some((event) => event.type === 'output' && event.sessionId === secondId),
            false,
          );
          mobile.send({ type: 'close', sessionId: secondId });
          mobile.send({ type: 'close', sessionId });
          await mobile.next('sessions', (event) => event.sessions?.length === 0);
          await viewer.disconnect();
        },
      );

      await suite.test(
        'groups and revision survive restart, while closed shells are not resurrected',
        async () => {
          await mobile.disconnect();
          await stop();
          await start();
          const reloaded = await connect();
          const snapshot = await reloaded.snapshot(revision);
          assert.equal(snapshot.groups?.find((group) => group.id === childId)?.parentId, parentId);
          assert.deepEqual(snapshot.sessions, []);
          const renamed = await reloaded.request(
            {
              type: 'updateGroup',
              groupId: childId,
              name: 'iPhone',
              parentId,
              order: 2,
              expectedRevision: revision,
            },
            'updated',
          );
          revision = renamed.revision!;
          const removed = await reloaded.request(
            { type: 'deleteGroup', groupId: childId, expectedRevision: revision },
            'updated',
          );
          revision = removed.revision!;
          const remaining = await reloaded.snapshot(revision);
          assert.deepEqual(
            remaining.groups?.map((group) => group.id),
            [parentId],
          );
        },
      );
    } finally {
      for (const peer of peers) peer.socket.terminate();
      await stop();
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
