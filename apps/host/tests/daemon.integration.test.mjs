import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const claudeFixture = fileURLToPath(
  new URL('./claude-fixture.mjs', import.meta.url),
);
const codexFixture = fileURLToPath(
  new URL('./codex-fixture.mjs', import.meta.url),
);

function bounded(operation, description, milliseconds = 10_000) {
  let timer;
  const failure = new Error(description);
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function channel(readable, writable, closed, description) {
  const messages = [];
  const received = [];
  const pending = new Map();
  const waiters = new Set();
  let failure;
  const fail = error => {
    failure ??= error;
    for (const item of [...pending.values(), ...waiters]) item.reject(failure);
  };
  const lines = createInterface({ input: readable });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      received.push(message);
      const response = message.id && pending.get(message.id);
      if (response) response.resolve(message);
      else {
        const waiter = [...waiters].find(item => item.match(message));
        if (waiter) {
          waiters.delete(waiter);
          waiter.resolve(message);
        } else messages.push(message);
      }
    } catch (error) {
      fail(error);
    }
  });
  closed.then(() => fail(new Error(`${description} closed`)), fail);
  return {
    received,
    raw: value =>
      writable.write(
        typeof value === 'string' ? value + '\n' : JSON.stringify(value) + '\n',
      ),
    request: (method, input, id = randomUUID()) => {
      if (failure) return Promise.reject(failure);
      assert.equal(pending.has(id), false);
      const operation = new Promise((resolve, reject) =>
        pending.set(id, { resolve, reject }),
      );
      writable.write(
        JSON.stringify({ id, method, ...(input ? { input } : {}) }) + '\n',
        error => {
          if (error) pending.get(id)?.reject(error);
        },
      );
      return bounded(operation, `${description}: ${method} timed out`).finally(
        () => pending.delete(id),
      );
    },
    next: match => {
      const index = messages.findIndex(match);
      if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
      if (failure) return Promise.reject(failure);
      const waiter = { match };
      const operation = new Promise((resolve, reject) => {
        Object.assign(waiter, { resolve, reject });
        waiters.add(waiter);
      });
      return bounded(operation, `${description}: event timed out`).finally(() =>
        waiters.delete(waiter),
      );
    },
  };
}

function launch(command, env) {
  const child = spawn(process.execPath, [entry, command], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', value => {
    stderr = (stderr + value).slice(-8000);
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exited,
    error: () => stderr,
    ...channel(child.stdout, child.stdin, exited, command),
  };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

test(
  'daemon retains work and decision identity across reconnecting Unix clients',
  {
    skip: process.platform !== 'linux',
    timeout: 120_000,
  },
  async t => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'nsvd-')));
    const data = join(directory, 'data');
    const runtime = join(directory, 'run');
    const socketPath = join(runtime, 'host.sock');
    const pidFile = join(directory, 'provider.json');
    const turnsFile = join(directory, 'turns.jsonl');
    const processes = [];
    const clients = new Set();
    const auxiliaryServers = [];
    const ownedPids = new Set();
    const env = {
      NESVO_DATA_DIR: data,
      NESVO_RUNTIME_DIR: runtime,
      NESVO_CLAUDE_EXECUTABLE: claudeFixture,
      NESVO_CODEX_EXECUTABLE: codexFixture,
      NESVO_FIXTURE_PID_FILE: join(directory, 'claude.json'),
      NESVO_CODEX_FIXTURE_PID_FILE: pidFile,
      NESVO_CODEX_FIXTURE_PID_DIR: join(directory, 'workers'),
      NESVO_CODEX_FIXTURE_STATE_DIR: join(directory, 'state'),
      NESVO_CODEX_FIXTURE_RUN_LOG: turnsFile,
      CLAUDE_CONFIG_DIR: join(directory, 'claude-config'),
      CODEX_HOME: join(directory, 'codex-config'),
      NESVO_TEST_SKILLS_HOME: join(directory, 'skills-home'),
    };
    const privateDirectory = async path => {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    };
    await privateDirectory(data);
    await privateDirectory(runtime);
    t.after(async () => {
      for (const client of clients) client.socket.destroy();
      await Promise.all(
        auxiliaryServers.map(
          server => new Promise(resolve => server.close(resolve)),
        ),
      );
      for (const server of processes.toReversed()) {
        if (server.child.exitCode === null && server.child.signalCode === null)
          server.child.kill('SIGTERM');
        try {
          await bounded(server.exited, 'Owned daemon did not exit', 15_000);
        } catch {
          server.child.kill('SIGKILL');
          await server.exited;
        }
      }
      for (const pid of ownedPids) {
        try {
          const variables = await readFile(`/proc/${pid}/environ`);
          if (
            variables.toString().split('\0').includes(`NESVO_DATA_DIR=${data}`)
          )
            process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
        }
      }
      await rm(directory, { recursive: true, force: true });
    });
    const start = (extra = {}, command = 'daemon') => {
      const server = launch(command, { ...env, ...extra });
      processes.push(server);
      return server;
    };
    const open = async () => {
      const socket = createConnection({ path: socketPath });
      const connected = new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      const closed = new Promise(resolve => socket.once('close', resolve));
      socket.on('error', () => {});
      const client = {
        socket,
        closed,
        ...channel(socket, socket, closed, 'Unix client'),
      };
      clients.add(client);
      await bounded(connected, 'Client could not connect');
      return client;
    };
    const connect = async expectedInstanceId => {
      const client = await open();
      client.raw({
        type: 'connect',
        protocolVersion: 1,
        ...(expectedInstanceId ? { expectedInstanceId } : {}),
      });
      const greeting = await client.next(
        message =>
          message.type === 'connected' || message.type === 'connection-error',
      );
      assert.equal(greeting.type, 'connected', JSON.stringify(greeting));
      client.health = greeting.health;
      return client;
    };
    const disconnect = async client => {
      client.socket.destroy();
      await bounded(client.closed, 'Client did not detach');
      clients.delete(client);
    };
    const disconnectAll = async () => {
      await Promise.all([...clients].map(disconnect));
    };
    const readTurns = async () =>
      (await readFile(turnsFile, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    const session = async (client, id) =>
      (await client.request('list-sessions')).sessions.find(
        value => value.id === id,
      );
    const waitSession = async (client, id, predicate) => {
      const deadline = Date.now() + 10_000;
      let current;
      while (Date.now() < deadline) {
        current = await session(client, id);
        if (current && predicate(current)) return current;
        await delay(30);
      }
      assert.fail(`Session did not settle: ${JSON.stringify(current)}`);
    };
    const create = async (client, mode = 'read-only') => {
      const response = await client.request('create-session', {
        title: 'Daemon fixture session',
        provider: 'Codex',
        model: 'fixture-codex',
        mode,
        directory: '',
      });
      assert.equal(response.type, 'session', JSON.stringify(response));
      return response.session;
    };
    const send = async (client, target, text, messageId = randomUUID()) => {
      const input = { sessionId: target.id, messageId, text };
      const response = await client.request('send-message', input);
      assert.equal(response.type, 'session', JSON.stringify(response));
      return { input, session: response.session };
    };
    const recordPids = async () => {
      const pids = JSON.parse(await readFile(pidFile, 'utf8'));
      for (const pid of [pids.pid, pids.childPid]) {
        assert.ok(alive(pid));
        ownedPids.add(pid);
      }
      return pids;
    };
    const gone = async pids => {
      const deadline = Date.now() + 5000;
      while (pids.some(alive) && Date.now() < deadline) await delay(30);
      for (const pid of pids) {
        assert.equal(alive(pid), false, `Owned provider ${pid} leaked`);
        ownedPids.delete(pid);
      }
    };
    const owner = start();
    const ready = await owner.next(message => message.type === 'daemon-ready');
    assert.equal(ready.health.status, 'ready');
    assert.equal(ready.health.protocolVersion, 1);
    const instanceId = ready.health.instanceId;
    assert.equal((await lstat(runtime)).mode & 0o777, 0o700);
    const originalSocket = await lstat(socketPath);
    assert.ok(originalSocket.isSocket());
    let first = await connect(instanceId);
    let second = await connect(instanceId);
    const collision = randomUUID();
    const responses = await Promise.all([
      first.request('health', undefined, collision),
      second.request('list-sessions', undefined, collision),
    ]);
    assert.equal(responses[0].type, 'health');
    assert.equal(responses[1].type, 'sessions');
    assert.equal(responses[0].id, collision);
    assert.equal(responses[1].id, collision);
    for (const [hello, code] of [
      [{ type: 'connect', protocolVersion: 2 }, 'incompatible-protocol'],
      [
        {
          type: 'connect',
          protocolVersion: 1,
          expectedInstanceId: randomUUID(),
        },
        'identity-mismatch',
      ],
      [
        { type: 'connect', protocolVersion: 1, directory: data },
        'invalid-handshake',
      ],
    ]) {
      const invalid = await open();
      invalid.raw(hello);
      assert.equal(
        (await invalid.next(message => message.type === 'connection-error'))
          .code,
        code,
      );
      await bounded(invalid.closed, 'Invalid handshake stayed open');
      clients.delete(invalid);
    }
    const otherErrors = second.received.filter(
      message => message.type === 'error',
    ).length;
    first.raw({ id: randomUUID(), method: 'unknown-method' });
    assert.deepEqual(
      await first.next(
        message => message.type === 'error' && message.id === null,
      ),
      { type: 'error', id: null, code: 'invalid-request' },
    );
    assert.equal(
      (await second.request('health')).health.instanceId,
      instanceId,
    );
    assert.equal(
      second.received.filter(message => message.type === 'error').length,
      otherErrors,
    );
    const oversize = await connect(instanceId);
    oversize.raw('x'.repeat(1024 * 1024 + 1));
    assert.equal(
      (await oversize.next(message => message.type === 'connection-error'))
        .code,
      'invalid-frame',
    );
    await bounded(oversize.closed, 'Oversized client stayed open');
    clients.delete(oversize);
    const truncated = await connect(instanceId);
    truncated.socket.end('{"id":');
    assert.equal(
      (await truncated.next(message => message.type === 'connection-error'))
        .code,
      'invalid-frame',
    );
    await bounded(truncated.closed, 'Truncated client stayed open');
    clients.delete(truncated);
    const duplicated = await connect(instanceId);
    const duplicateId = randomUUID();
    const duplicateRequest = JSON.stringify({
      id: duplicateId,
      method: 'codex-status',
    });
    duplicated.raw(duplicateRequest + '\n' + duplicateRequest);
    assert.equal(
      (await duplicated.next(message => message.type === 'connection-error'))
        .code,
      'invalid-frame',
    );
    await bounded(duplicated.closed, 'Duplicate request client stayed open');
    clients.delete(duplicated);
    const extras = [];
    for (let index = 0; index < 6; index++)
      extras.push(await connect(instanceId));
    const excess = await open();
    assert.equal(
      (await excess.next(message => message.type === 'connection-error')).code,
      'busy',
    );
    await bounded(excess.closed, 'Excess client stayed open');
    clients.delete(excess);
    await Promise.all(extras.map(disconnect));
    const otherRuntime = join(directory, 'other-run');
    const otherData = join(directory, 'other-data');
    await privateDirectory(otherRuntime);
    await privateDirectory(otherData);
    for (const extra of [
      { NESVO_RUNTIME_DIR: otherRuntime },
      { NESVO_DATA_DIR: otherData },
    ]) {
      const duplicate = start(extra);
      assert.equal(
        (
          await bounded(
            duplicate.exited,
            'Second daemon did not refuse ownership',
          )
        ).code,
        1,
        duplicate.error(),
      );
      assert.equal(
        duplicate.received.some(message => message.type === 'daemon-ready'),
        false,
      );
      assert.equal(
        (await first.request('health')).health.instanceId,
        instanceId,
      );
      assert.equal((await lstat(socketPath)).ino, originalSocket.ino);
    }
    const unsafeRuntime = join(directory, 'unsafe-run');
    await mkdir(unsafeRuntime, { mode: 0o755 });
    await chmod(unsafeRuntime, 0o755);
    const unsafe = start({
      NESVO_DATA_DIR: otherData,
      NESVO_RUNTIME_DIR: unsafeRuntime,
    });
    assert.equal(
      (await bounded(unsafe.exited, 'Unsafe runtime was not refused')).code,
      1,
      unsafe.error(),
    );
    assert.equal((await lstat(unsafeRuntime)).mode & 0o777, 0o755);
    const foreignRuntime = join(directory, 'foreign-run');
    await privateDirectory(foreignRuntime);
    const foreignPath = join(foreignRuntime, 'host.sock');
    const foreignServer = createServer(socket => socket.destroy());
    auxiliaryServers.push(foreignServer);
    await new Promise((resolve, reject) => {
      foreignServer.once('error', reject);
      foreignServer.listen(foreignPath, resolve);
    });
    const foreignIdentity = await lstat(foreignPath);
    const foreignCollision = start({
      NESVO_DATA_DIR: otherData,
      NESVO_RUNTIME_DIR: foreignRuntime,
    });
    assert.equal(
      (
        await bounded(
          foreignCollision.exited,
          'Live foreign socket was not refused',
        )
      ).code,
      1,
      foreignCollision.error(),
    );
    assert.equal((await lstat(foreignPath)).ino, foreignIdentity.ino);
    assert.equal((await first.request('health')).health.instanceId, instanceId);
    assert.equal((await first.request('shutdown')).code, 'invalid-request');
    const bridge = start({ NESVO_EXPECTED_INSTANCE_ID: instanceId }, 'connect');
    assert.equal(
      (await bridge.next(message => message.type === 'connected')).health
        .instanceId,
      instanceId,
    );
    assert.equal(
      (await bridge.request('health')).health.instanceId,
      instanceId,
    );
    bridge.child.stdin.end();
    assert.deepEqual(
      await bounded(bridge.exited, 'Bridge EOF did not detach'),
      { code: 0, signal: null },
    );
    assert.equal((await first.request('health')).health.instanceId, instanceId);

    const parent = await create(first);
    const planned = await send(first, parent, 'fixture:delegate-two-hold');
    const plan = (
      await first.next(
        message =>
          message.type === 'session-changed' &&
          message.session.runId === planned.session.runId &&
          message.session.delegations.length === 2,
      )
    ).session;
    const approved = plan.delegations[0];
    const pending = plan.delegations[1];
    assert.equal(
      (
        await first.request('decide-delegation', {
          sessionId: parent.id,
          runId: plan.runId,
          delegationId: approved.id,
          decision: 'accept',
        })
      ).type,
      'session',
    );
    const worker = (
      await first.next(
        message =>
          message.type === 'session-changed' &&
          message.session.parentId === parent.id &&
          message.session.messages.at(-1)?.body.includes('is waiting.'),
      )
    ).session;
    const workerPids = await recordPids();
    assert.equal(worker.providerSessionId, workerPids.sessionId);
    assert.equal(
      (await second.request('list-sessions')).sessions.find(
        value => value.id === worker.id,
      ).parentRunId,
      plan.runId,
    );
    const activeTurns = await readTurns();
    await disconnectAll();
    await delay(120);
    assert.ok(alive(owner.child.pid));
    assert.ok(alive(workerPids.pid));
    assert.ok(alive(workerPids.childPid));
    first = await connect(instanceId);
    const reconnectedWorker = await session(first, worker.id);
    for (const key of [
      'id',
      'runId',
      'providerSessionId',
      'parentId',
      'parentRunId',
    ])
      assert.equal(reconnectedWorker[key], worker[key]);
    assert.equal(reconnectedWorker.status, 'running');
    assert.equal(reconnectedWorker.messages.length, worker.messages.length);
    assert.equal(
      (await session(first, parent.id)).delegations.find(
        value => value.id === pending.id,
      ).status,
      'pending',
    );
    assert.equal(
      (await first.request('send-message', planned.input)).session.runId,
      plan.runId,
    );
    assert.deepEqual(await readTurns(), activeTurns);
    await first.request('stop-run', {
      sessionId: worker.id,
      runId: worker.runId,
    });
    await waitSession(first, worker.id, value => value.status === 'stopped');
    await gone([workerPids.pid, workerPids.childPid]);
    await first.request('decide-delegation', {
      sessionId: parent.id,
      runId: plan.runId,
      delegationId: pending.id,
      decision: 'decline',
    });
    await waitSession(first, parent.id, value => value.status === 'completed');
    const parentReview = (await first.request('list-reviews')).reviews.find(
      value => value.runId === plan.runId,
    );
    assert.equal(parentReview.status, 'pending');
    const decision = {
      reviewId: parentReview.id,
      version: parentReview.version,
      decisionId: randomUUID(),
      decision: 'accept',
      feedback: '',
    };
    const accepted = await first.request('decide-review', decision);
    assert.equal(accepted.review.status, 'accepted');
    await disconnectAll();
    first = await connect(instanceId);
    assert.deepEqual(
      (await first.request('decide-review', decision)).review,
      accepted.review,
    );
    assert.deepEqual(await readTurns(), activeTurns);

    const operationTarget = await create(first, 'supervised');
    const operation = await send(
      first,
      operationTarget,
      'fixture:approval-hold',
    );
    const awaiting = (
      await first.next(
        message =>
          message.type === 'session-changed' &&
          message.session.runId === operation.session.runId &&
          message.session.pendingApprovals.length === 1,
      )
    ).session;
    const approval = awaiting.pendingApprovals[0];
    const operationPids = await recordPids();
    const markerPath = join(
      operationTarget.directory,
      `.nesvo-codex-action-${awaiting.providerSessionId}-command.json`,
    );
    await assert.rejects(readFile(markerPath), { code: 'ENOENT' });
    await disconnectAll();
    first = await connect(instanceId);
    assert.deepEqual(
      (await session(first, operationTarget.id)).pendingApprovals,
      awaiting.pendingApprovals,
    );
    assert.ok(alive(operationPids.pid));
    assert.ok(alive(operationPids.childPid));
    const approve = {
      sessionId: operationTarget.id,
      runId: awaiting.runId,
      requestId: approval.id,
      decision: 'accept',
    };
    await first.request('respond-approval', approve);
    const operated = await waitSession(
      first,
      operationTarget.id,
      value => value.status === 'completed',
    );
    assert.equal(
      operated.messages.at(-1).body,
      'Codex fixture command accepted.',
    );
    await gone([operationPids.pid, operationPids.childPid]);
    const marker = await readFile(markerPath, 'utf8');
    assert.equal(approval.id, `codex-string-${JSON.parse(marker).requestId}`);
    assert.equal(
      (await first.request('respond-approval', approve)).code,
      'invalid-request',
    );
    assert.equal(await readFile(markerPath, 'utf8'), marker);

    const offlineTarget = await create(first);
    const offlineRun = await send(first, offlineTarget, 'fixture:stream');
    await disconnectAll();
    await delay(450);
    first = await connect(instanceId);
    const offlineCompleted = await waitSession(
      first,
      offlineTarget.id,
      value => value.status === 'completed',
    );
    assert.equal(offlineCompleted.runId, offlineRun.session.runId);
    assert.equal(
      offlineCompleted.messages.at(-1).body,
      'Codex fixture streamed reply.',
    );
    const offlineReview = (await first.request('list-reviews')).reviews.find(
      value => value.runId === offlineCompleted.runId,
    );
    assert.equal(offlineReview.status, 'pending');
    const completedTurns = await readTurns();
    assert.equal(
      (await first.request('send-message', offlineRun.input)).session.runId,
      offlineCompleted.runId,
    );
    assert.deepEqual(await readTurns(), completedTurns);

    const closingRun = await send(
      first,
      operationTarget,
      'fixture:approval-hold',
    );
    const closingApproval = (
      await first.next(
        message =>
          message.type === 'session-changed' &&
          message.session.runId === closingRun.session.runId &&
          message.session.pendingApprovals.length === 1,
      )
    ).session;
    const closingPids = await recordPids();
    const beforeShutdownTurns = await readTurns();
    const lostBridge = start(
      { NESVO_EXPECTED_INSTANCE_ID: instanceId },
      'connect',
    );
    assert.equal(
      (await lostBridge.next(message => message.type === 'connected')).health
        .instanceId,
      instanceId,
    );
    await disconnectAll();
    owner.child.kill('SIGTERM');
    assert.deepEqual(
      await bounded(owner.exited, 'Daemon did not shut down'),
      { code: 0, signal: null },
      owner.error(),
    );
    assert.deepEqual(
      await bounded(lostBridge.exited, 'Bridge did not report lost daemon'),
      { code: 1, signal: null },
    );
    await gone([closingPids.pid, closingPids.childPid]);
    const restarted = start();
    assert.equal(
      (await restarted.next(message => message.type === 'daemon-ready')).health
        .instanceId,
      instanceId,
    );
    first = await connect(instanceId);
    const interrupted = await session(first, operationTarget.id);
    assert.equal(interrupted.runId, closingRun.session.runId);
    assert.equal(
      interrupted.providerSessionId,
      closingApproval.providerSessionId,
    );
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.interruption.reason, 'host-shutdown');
    assert.deepEqual(interrupted.pendingApprovals, []);
    const restoredReviews = (await first.request('list-reviews')).reviews;
    assert.deepEqual(
      restoredReviews.find(value => value.id === parentReview.id),
      accepted.review,
    );
    assert.deepEqual(
      restoredReviews.find(value => value.id === offlineReview.id),
      offlineReview,
    );
    await delay(150);
    assert.deepEqual(await readTurns(), beforeShutdownTurns);
    assert.equal((await first.request('shutdown')).code, 'invalid-request');
    await disconnectAll();
    restarted.child.kill('SIGINT');
    assert.deepEqual(
      await bounded(restarted.exited, 'Restarted daemon did not shut down'),
      { code: 0, signal: null },
      restarted.error(),
    );
    t.diagnostic(
      JSON.stringify({
        instanceId,
        parentSessionId: parent.id,
        parentRunId: plan.runId,
        workerSessionId: worker.id,
        workerRunId: worker.runId,
        approvalId: approval.id,
        acceptedReviewId: parentReview.id,
        pendingReviewId: offlineReview.id,
        detachedWorkerContinued: true,
        approvalReconnected: true,
        offlineCompletionPersisted: true,
        bridgeEofPreservedDaemon: true,
        daemonShutdownInterruptedRun: true,
      }),
    );
  },
);
