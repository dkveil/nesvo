import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

function launch(directory) {
  const child = spawn(process.execPath, ['apps/host/dist/main.js'], {
    env: { ...process.env, NESVO_DATA_DIR: directory },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', data => {
    stderr += data;
  });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exited,
    error: () => stderr,
    send: async input => {
      child.stdin.write(
        typeof input === 'string' ? input + '\n' : JSON.stringify(input) + '\n',
      );
      const next = await lines.next();
      assert.equal(next.done, false, stderr);
      return JSON.parse(next.value);
    },
    stop: async () => {
      const id = randomUUID();
      child.stdin.write(JSON.stringify({ id, method: 'shutdown' }) + '\n');
      const next = await lines.next();
      assert.deepEqual(JSON.parse(next.value), { id, type: 'shutdown' });
      assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
    },
  };
}

test(
  'host validates messages, persists identity and closes cleanly across restarts',
  { timeout: 15000 },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'nesvo-host-'));
    const children = [];
    t.after(async () => {
      for (const host of children) {
        if (host.child.exitCode === null) host.child.kill();
        await host.exited;
      }
      await rm(directory, { recursive: true, force: true });
    });
    const host = launch(directory);
    children.push(host);
    assert.deepEqual(await host.send('{broken'), {
      type: 'error',
      id: null,
      code: 'invalid-request',
    });
    assert.deepEqual(
      await host.send({
        id: randomUUID(),
        method: 'execute',
        command: 'unexpected',
      }),
      { type: 'error', id: null, code: 'invalid-request' },
    );
    const id = randomUUID();
    const first = await host.send({ id, method: 'health' });
    assert.equal(first.id, id);
    assert.equal(first.type, 'health');
    assert.equal(first.health.status, 'ready');
    assert.equal(first.health.protocolVersion, 1);
    assert.match(first.health.instanceId, /^[0-9a-f-]{36}$/);
    await host.stop();
    const reopened = launch(directory);
    children.push(reopened);
    const second = await reopened.send({ id: randomUUID(), method: 'health' });
    assert.equal(second.health.instanceId, first.health.instanceId);
    await reopened.stop();
  },
);

test(
  'host refuses a newer database without altering its schema version',
  { timeout: 15000 },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'nesvo-schema-'));
    const path = join(directory, 'nesvo.sqlite');
    const database = new DatabaseSync(path);
    database.exec('PRAGMA user_version = 99');
    database.close();
    const host = launch(directory);
    t.after(async () => {
      if (host.child.exitCode === null) host.child.kill();
      await host.exited;
      await rm(directory, { recursive: true, force: true });
    });
    assert.equal((await host.exited).code, 1, host.error());
    const check = new DatabaseSync(path);
    try {
      assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99);
    } finally {
      check.close();
    }
  },
);
