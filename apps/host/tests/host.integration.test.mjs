import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(
  new URL('./claude-fixture.mjs', import.meta.url),
);
const codexFixturePath = fileURLToPath(
  new URL('./codex-fixture.mjs', import.meta.url),
);

function bounded(promise, description, timeout = 10_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              typeof description === 'function' ? description() : description,
            ),
          ),
        timeout,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function launch(directory, pidFile) {
  const child = spawn(process.execPath, ['apps/host/dist/main.js'], {
    env: {
      ...process.env,
      NESVO_DATA_DIR: directory,
      NESVO_CLAUDE_EXECUTABLE: fixturePath,
      NESVO_FIXTURE_PID_FILE: pidFile,
      NESVO_CODEX_EXECUTABLE: codexFixturePath,
      NESVO_CODEX_FIXTURE_PID_FILE: pidFile + '.codex',
      NESVO_CODEX_FIXTURE_PID_DIR: pidFile + '.workers',
      NESVO_CODEX_FIXTURE_STATE_DIR: pidFile + '.state',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  const pending = new Map();
  const events = [];
  const observed = [];
  const waiters = new Set();
  const reviewEvents = [];
  const reviewWaiters = new Set();
  const observedReviews = [];
  let transportError;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => {
    stderr += data;
  });
  const fail = error => {
    transportError ??= error;
    for (const item of [...pending.values(), ...waiters, ...reviewWaiters])
      item.reject(error);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.type === 'session-changed') {
        observed.push(message.session);
        const waiter = [...waiters].find(item => item.match(message.session));
        if (waiter) {
          waiters.delete(waiter);
          waiter.resolve(message.session);
        } else events.push(message.session);
      } else if (message.type === 'review-changed') {
        observedReviews.push(message.review);
        const waiter = [...reviewWaiters].find(item =>
          item.match(message.review),
        );
        if (waiter) {
          reviewWaiters.delete(waiter);
          waiter.resolve(message.review);
        } else reviewEvents.push(message.review);
      } else {
        const response = pending.get(message.id);
        assert.ok(response, `Uncorrelated response: ${line}`);
        pending.delete(message.id);
        response.resolve(message);
      }
    } catch (error) {
      fail(error);
    }
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  exited.then(
    () => fail(new Error(`Host exited before response/event: ${stderr}`)),
    fail,
  );
  const send = input => {
    if (transportError) return Promise.reject(transportError);
    const id = typeof input === 'string' ? null : input.id;
    assert.equal(pending.has(id), false, 'Request IDs must be unique');
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(
        typeof input === 'string' ? input + '\n' : JSON.stringify(input) + '\n',
      );
    });
    return bounded(
      promise,
      `Host response timed out (${id}): ${stderr}`,
    ).finally(() => pending.delete(id));
  };
  const request = (method, input) =>
    send({ id: randomUUID(), method, ...(input ? { input } : {}) });
  return {
    child,
    exited,
    observed,
    observedReviews,
    request,
    send,
    error: () => stderr,
    review: match => {
      if (transportError) return Promise.reject(transportError);
      const index = reviewEvents.findIndex(match);
      if (index !== -1)
        return Promise.resolve(reviewEvents.splice(index, 1)[0]);
      const waiter = { match };
      const promise = new Promise((resolve, reject) => {
        Object.assign(waiter, { resolve, reject });
        reviewWaiters.add(waiter);
      });
      return bounded(
        promise,
        () =>
          `Review event timed out: ${stderr}\n${JSON.stringify(observedReviews.slice(-4).map(review => ({ id: review.id, sessionId: review.sessionId, runId: review.runId, version: review.version, status: review.status, diff: review.diff.status, summary: review.summary.slice(0, 200) })))}`,
      ).finally(() => reviewWaiters.delete(waiter));
    },
    event: match => {
      if (transportError) return Promise.reject(transportError);
      const index = events.findIndex(match);
      if (index !== -1) return Promise.resolve(events.splice(index, 1)[0]);
      const waiter = { match };
      const promise = new Promise((resolve, reject) => {
        Object.assign(waiter, { resolve, reject });
        waiters.add(waiter);
      });
      return bounded(
        promise,
        () =>
          `Session event timed out: ${stderr}\n${JSON.stringify(observed.slice(-4).map(session => ({ provider: session.provider, status: session.status, error: session.error, body: agent(session)?.body, approvals: session.pendingApprovals?.map(approval => ({ id: approval.id, kind: approval.kind, detail: approval.detail.slice(0, 300) })) })))}`,
      ).finally(() => waiters.delete(waiter));
    },
    stop: async () => {
      assert.equal((await request('shutdown')).type, 'shutdown');
      assert.deepEqual(
        await bounded(exited, `Host shutdown timed out: ${stderr}`),
        { code: 0, signal: null },
        stderr,
      );
    },
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

async function processesGone(pids, tracked) {
  const deadline = Date.now() + 5000;
  while (pids.some(alive) && Date.now() < deadline) await delay(30);
  for (const pid of pids) {
    assert.equal(alive(pid), false, `Owned PID ${pid} leaked`);
    tracked.delete(pid);
  }
}

const agent = session => session.messages.at(-1);

test(
  'host migrates and persists sessions, streams, resumes and owns cancellation',
  { timeout: 120_000 },
  async t => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'nesvo-host-')),
    );
    const workspace = join(directory, 'non-git-workspace');
    const pidFile = join(directory, 'fixture-pids.json');
    const children = [];
    const ownedPids = new Set();
    t.after(async () => {
      for (const host of children) {
        if (host.child.exitCode === null && host.child.signalCode === null) {
          try {
            await host.stop();
          } catch {
            host.child.kill();
          }
        }
        await bounded(host.exited, 'Test host did not exit');
      }
      for (const pid of ownedPids) {
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
      await rm(directory, { recursive: true, force: true });
    });
    if (process.platform !== 'win32') await chmod(fixturePath, 0o755);
    await mkdir(workspace);
    const path = join(directory, 'nesvo.sqlite');
    const instanceId = randomUUID();
    const database = new DatabaseSync(path);
    database.exec(
      'CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1',
    );
    database
      .prepare('INSERT INTO metadata (key, value) VALUES (?, ?)')
      .run('instance_id', instanceId);
    database.close();
    const open = () => {
      const host = launch(directory, pidFile);
      children.push(host);
      return host;
    };
    const host = open();
    assert.deepEqual(await host.send('{broken'), {
      type: 'error',
      id: null,
      code: 'invalid-request',
    });
    assert.deepEqual(
      await host.send(
        JSON.stringify({
          id: randomUUID(),
          method: 'execute',
          command: 'unexpected',
        }),
      ),
      { type: 'error', id: null, code: 'invalid-request' },
    );
    const [health, status] = await Promise.all([
      host.request('health'),
      host.request('claude-status'),
    ]);
    assert.deepEqual(health.health, {
      status: 'ready',
      protocolVersion: 1,
      instanceId,
    });
    assert.equal(status.type, 'claude-status');
    assert.equal(status.status.status, 'ready');
    assert.equal(status.status.version, '2.1.0');
    assert.deepEqual(
      status.status.models.map(model => model.id),
      ['default', 'opus', 'sonnet', 'haiku'],
    );
    const create = directory => ({
      title: 'Fixture conversation',
      model: 'sonnet',
      directory,
    });
    assert.equal(
      (await host.request('create-session', create('relative-folder'))).code,
      'invalid-directory',
    );
    const session = (await host.request('create-session', create(''))).session;
    assert.equal(session.status, 'ready');
    assert.equal(session.providerInitialized, false);
    assert.ok(session.directory.startsWith(join(directory, 'workspaces')));
    const external = (await host.request('create-session', create(workspace)))
      .session;
    assert.equal(external.directory, await realpath(workspace));
    assert.equal(external.role, 'standalone');
    const input = {
      sessionId: session.id,
      messageId: randomUUID(),
      text: 'fixture:stream',
    };
    const running = (await host.request('send-message', input)).session;
    assert.equal(running.status, 'running');
    assert.equal(running.messages.length, 2);
    const repeated = (await host.request('send-message', input)).session;
    assert.equal(repeated.runId, running.runId);
    assert.equal(repeated.messages.length, 2);
    assert.equal(
      (await host.request('send-message', { ...input, text: 'changed' })).code,
      'invalid-request',
    );
    assert.equal(
      (
        await host.request('send-message', {
          sessionId: external.id,
          messageId: randomUUID(),
          text: 'fixture:stream',
        })
      ).code,
      'busy',
    );
    const partial = await host.event(
      value =>
        value.id === session.id &&
        value.status === 'running' &&
        agent(value)?.body === 'Fixture streamed ',
    );
    assert.equal(partial.providerInitialized, true);
    assert.equal(partial.actualModel, 'fixture-sonnet');
    assert.equal(partial.activities.length, 1);
    assert.equal(partial.activities[0].kind, 'read');
    assert.equal(partial.activities[0].status, 'running');
    assert.equal(partial.activities[0].runId, running.runId);
    assert.equal(
      host.observed.some(
        value => value.runId === running.runId && value.status === 'completed',
      ),
      false,
    );
    assert.equal((await host.request('health')).health.status, 'ready');
    const completed = await host.event(
      value => value.runId === running.runId && value.status === 'completed',
    );
    assert.equal(agent(completed).body, 'Fixture streamed reply.');
    assert.equal(agent(completed).state, 'completed');
    assert.equal(completed.error, null);
    assert.ok(agent(completed).completedAt);
    assert.equal(completed.activities[0].status, 'completed');
    assert.ok(completed.activities[0].completedAt);
    assert.deepEqual(completed.activities[0].paths, ['sample.txt']);
    assert.equal(completed.activities[0].output, '');
    assert.equal(
      (await host.request('send-message', input)).session.revision,
      completed.revision,
    );
    const hold = async currentHost => {
      const started = (
        await currentHost.request('send-message', {
          sessionId: session.id,
          messageId: randomUUID(),
          text: 'fixture:hold',
        })
      ).session;
      await currentHost.event(
        value =>
          value.runId === started.runId &&
          agent(value).body === 'Fixture is waiting.',
      );
      const pids = JSON.parse(await readFile(pidFile, 'utf8'));
      assert.equal(pids.sessionId, session.providerSessionId);
      assert.ok(alive(pids.pid));
      assert.ok(alive(pids.childPid));
      ownedPids.add(pids.pid).add(pids.childPid);
      return { started, pids: [pids.pid, pids.childPid] };
    };
    const held = await hold(host);
    assert.equal(
      (
        await host.request('stop-run', {
          sessionId: session.id,
          runId: randomUUID(),
        })
      ).session.status,
      'running',
    );
    assert.equal(
      (
        await host.request('stop-run', {
          sessionId: session.id,
          runId: held.started.runId,
        })
      ).session.status,
      'stopping',
    );
    const stopped = await host.event(
      value => value.runId === held.started.runId && value.status === 'stopped',
    );
    assert.equal(agent(stopped).state, 'stopped');
    assert.equal(agent(stopped).body, 'Fixture is waiting.');
    assert.ok(agent(stopped).completedAt);
    assert.equal(
      stopped.activities.find(item => item.runId === held.started.runId).status,
      'stopped',
    );
    await processesGone(held.pids, ownedPids);
    for (const text of ['fixture:fail', 'fixture:result-fail']) {
      const failedRun = (
        await host.request('send-message', {
          sessionId: external.id,
          messageId: randomUUID(),
          text,
        })
      ).session;
      const failed = await host.event(
        value => value.runId === failedRun.runId && value.status === 'failed',
      );
      assert.equal(agent(failed).state, 'failed');
      assert.equal(
        (await host.request('list-reviews')).reviews.some(
          value => value.runId === failedRun.runId,
        ),
        false,
      );
      assert.match(
        failed.error,
        /Fixture (account limit reached|unsuccessful result)/,
      );
      if (text === 'fixture:result-fail') {
        assert.equal(failed.activities[0].status, 'failed');
        assert.match(failed.activities[0].output, /ENOENT/);
        assert.doesNotMatch(failed.activities[0].output, /fixture-secret/);
      }
      assert.equal(
        host.observed.some(
          value =>
            value.runId === failedRun.runId && value.status === 'completed',
        ),
        false,
      );
    }
    const listed = (await host.request('list-sessions')).sessions;
    assert.equal(
      listed.find(value => value.id === session.id).status,
      'stopped',
    );
    assert.equal(
      listed.find(value => value.id === external.id).status,
      'failed',
    );
    assert.equal(
      host.observed.some(
        value =>
          value.runId === held.started.runId && value.status === 'completed',
      ),
      false,
    );
    await host.stop();
    const migrated = new DatabaseSync(path);
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 6);
    migrated.close();
    const reopened = open();
    assert.equal(
      (await reopened.request('health')).health.instanceId,
      instanceId,
    );
    const restored = (await reopened.request('list-sessions')).sessions.find(
      value => value.id === session.id,
    );
    assert.deepEqual(restored, stopped);
    const continuation = (
      await reopened.request('send-message', {
        sessionId: session.id,
        messageId: randomUUID(),
        text: 'fixture:continue',
      })
    ).session;
    const resumed = await reopened.event(
      value =>
        value.runId === continuation.runId && value.status === 'completed',
    );
    assert.equal(agent(resumed).body, 'Fixture resumed reply.');
    assert.equal(resumed.providerSessionId, session.providerSessionId);
    assert.equal(resumed.messages.length, 6);
    await reopened.stop();
    const recovery = new DatabaseSync(path);
    const interrupted = structuredClone(resumed);
    interrupted.status = 'running';
    interrupted.activity = 'Lost host';
    agent(interrupted).state = 'running';
    delete interrupted.mode;
    delete interrupted.pendingApprovals;
    delete interrupted.parentId;
    delete interrupted.parentRunId;
    delete interrupted.scope;
    delete interrupted.delegationEnabled;
    delete interrupted.delegations;
    delete interrupted.activities;
    delete interrupted.activitiesTruncated;
    delete interrupted.activityTruncatedRunIds;
    for (const message of interrupted.messages) delete message.completedAt;
    recovery
      .prepare('UPDATE sessions SET document = ? WHERE id = ?')
      .run(JSON.stringify(interrupted), session.id);
    const legacyCodexId = randomUUID();
    const legacyCodex = {
      ...interrupted,
      id: legacyCodexId,
      provider: 'Codex',
      providerSessionId: null,
      providerInitialized: false,
      model: 'default',
      actualModel: null,
      role: 'orchestrator',
      title: 'Legacy Codex orchestrator',
      status: 'ready',
      runId: null,
      messages: [],
      activity: null,
      error: null,
    };
    recovery
      .prepare(
        'INSERT INTO sessions (id, document, updated_at) VALUES (?, ?, ?)',
      )
      .run(legacyCodexId, JSON.stringify(legacyCodex), legacyCodex.updatedAt);
    recovery.exec('PRAGMA user_version = 2');
    recovery.close();
    const recovered = open();
    assert.equal(
      (await recovered.request('health')).health.instanceId,
      instanceId,
    );
    const recoveredSession = (
      await recovered.request('list-sessions')
    ).sessions.find(value => value.id === session.id);
    assert.equal(recoveredSession.status, 'interrupted');
    assert.equal(agent(recoveredSession).state, 'interrupted');
    assert.equal(recoveredSession.activity, null);
    assert.ok(recoveredSession.error);
    assert.ok(recoveredSession.revision > resumed.revision);
    assert.equal(recoveredSession.mode, 'read-only');
    assert.deepEqual(recoveredSession.pendingApprovals, []);
    assert.equal(recoveredSession.provider, 'Claude Code');
    assert.equal(recoveredSession.delegationEnabled, false);
    assert.deepEqual(recoveredSession.delegations, []);
    assert.deepEqual(recoveredSession.activities, []);
    assert.equal(recoveredSession.activitiesTruncated, false);
    assert.deepEqual(recoveredSession.activityTruncatedRunIds, []);
    assert.equal(recoveredSession.messages[0].completedAt, null);
    const legacySession = (
      await recovered.request('list-sessions')
    ).sessions.find(value => value.id === legacyCodexId);
    assert.equal(legacySession.role, 'orchestrator');
    assert.equal(legacySession.delegationEnabled, false);
    assert.deepEqual(legacySession.delegations, []);
    const shutdownRun = await hold(recovered);
    await recovered.stop();
    await processesGone(shutdownRun.pids, ownedPids);
    assert.equal(
      recovered.observed.some(
        value =>
          value.runId === shutdownRun.started.runId &&
          value.status === 'completed',
      ),
      false,
    );
    const finalHost = open();
    const finalSession = (
      await finalHost.request('list-sessions')
    ).sessions.find(value => value.id === session.id);
    assert.equal(finalSession.status, 'stopped');
    assert.equal(agent(finalSession).state, 'stopped');
    const codexStatus = await finalHost.request('codex-status');
    assert.equal(codexStatus.type, 'codex-status');
    assert.equal(
      codexStatus.status.status,
      'ready',
      JSON.stringify(codexStatus),
    );
    assert.equal(codexStatus.status.version, '0.156.0');
    assert.ok(
      codexStatus.status.models.some(model => model.id === 'fixture-codex'),
    );
    const createCodex = async mode => {
      const response = await finalHost.request('create-session', {
        ...create(''),
        provider: 'Codex',
        model: 'fixture-codex',
        mode,
      });
      assert.equal(response.type, 'session', JSON.stringify(response));
      assert.equal(response.session.providerSessionId, null);
      assert.equal(response.session.role, 'standalone');
      assert.equal(response.session.mode, mode);
      assert.equal(response.session.delegationEnabled, true);
      assert.deepEqual(response.session.pendingApprovals, []);
      return response.session;
    };
    const sendCodex = async (currentHost, target, text) => {
      const response = await currentHost.request('send-message', {
        sessionId: target.id,
        messageId: randomUUID(),
        text,
      });
      assert.equal(response.type, 'session', JSON.stringify(response));
      return response.session;
    };
    const readOnly = await createCodex('read-only');
    const codexRun = await sendCodex(finalHost, readOnly, 'fixture:stream');
    const codexPartial = await finalHost.event(
      value =>
        value.runId === codexRun.runId &&
        agent(value).body === 'Codex fixture streamed ',
    );
    assert.deepEqual(
      codexPartial.activities.map(item => item.kind),
      ['read', 'command'],
    );
    assert.ok(codexPartial.activities.every(item => item.status === 'running'));
    assert.match(codexPartial.activities[1].output, /count=5/);
    assert.doesNotMatch(
      codexPartial.activities[1].output,
      /fixture-secret|\u001b/,
    );
    assert.equal(
      finalHost.observed.some(
        value => value.runId === codexRun.runId && value.status === 'completed',
      ),
      false,
    );
    assert.equal((await finalHost.request('health')).health.status, 'ready');
    const codexCompleted = await finalHost.event(
      value => value.runId === codexRun.runId && value.status === 'completed',
    );
    assert.equal(agent(codexCompleted).body, 'Codex fixture streamed reply.');
    assert.equal(codexCompleted.actualModel, 'fixture-codex');
    assert.ok(codexCompleted.providerSessionId);
    assert.deepEqual(
      codexCompleted.activities.map(item => item.status),
      ['completed', 'completed'],
    );
    assert.ok(
      codexCompleted.activities.every(
        item => item.startedAt && item.completedAt,
      ),
    );
    assert.deepEqual(
      (await finalHost.request('list-sessions')).sessions.find(
        item => item.id === readOnly.id,
      ).activities,
      codexCompleted.activities,
    );
    const readOnlyReview = await finalHost.review(
      value => value.runId === codexRun.runId && value.status === 'pending',
    );
    assert.equal(readOnlyReview.sessionId, readOnly.id);
    assert.equal(readOnlyReview.summary, 'Codex fixture streamed reply.');
    assert.equal(readOnlyReview.version, 1);
    assert.equal(readOnlyReview.diff.status, 'not-applicable');
    assert.deepEqual(readOnlyReview.diff.files, []);
    const acceptReadOnly = {
      reviewId: readOnlyReview.id,
      version: readOnlyReview.version,
      decisionId: randomUUID(),
      decision: 'accept',
      feedback: '',
    };
    const acceptedReadOnly = await finalHost.request(
      'decide-review',
      acceptReadOnly,
    );
    assert.equal(
      acceptedReadOnly.type,
      'review',
      JSON.stringify(acceptedReadOnly),
    );
    assert.equal(acceptedReadOnly.review.status, 'accepted');
    assert.equal(
      acceptedReadOnly.review.decision.id,
      acceptReadOnly.decisionId,
    );
    assert.deepEqual(
      (await finalHost.request('decide-review', acceptReadOnly)).review,
      acceptedReadOnly.review,
    );
    assert.equal(
      (
        await finalHost.request('decide-review', {
          ...acceptReadOnly,
          version: readOnlyReview.version + 1,
          decisionId: randomUUID(),
        })
      ).code,
      'invalid-request',
    );
    assert.equal(
      (
        await finalHost.request('decide-review', {
          ...acceptReadOnly,
          decision: 'request-changes',
          feedback: 'Different decision with the same ID',
        })
      ).code,
      'invalid-request',
    );
    const unsafeRead = await sendCodex(finalHost, readOnly, 'fixture:approve');
    const rejectedRead = await finalHost.event(
      value => value.runId === unsafeRead.runId && value.status === 'failed',
    );
    assert.deepEqual(rejectedRead.pendingApprovals, []);
    const afterNewRun = (await finalHost.request('list-reviews')).reviews;
    const supersededReadOnly = afterNewRun.find(
      value => value.id === readOnlyReview.id,
    );
    assert.equal(supersededReadOnly.status, 'superseded');
    assert.equal(supersededReadOnly.decision.id, acceptReadOnly.decisionId);
    assert.equal(
      afterNewRun.some(value => value.runId === unsafeRead.runId),
      false,
    );
    await assert.rejects(
      readFile(
        join(
          readOnly.directory,
          `.nesvo-codex-action-${codexCompleted.providerSessionId}-command.json`,
        ),
      ),
      { code: 'ENOENT' },
    );

    const supervised = await createCodex('supervised');
    for (const prompt of [
      'fixture:missing-command',
      'fixture:missing-changes',
      'fixture:oversize-approval',
      'fixture:remote-environment',
    ]) {
      const malformed = await sendCodex(finalHost, supervised, prompt);
      const refused = await finalHost.event(
        value => value.runId === malformed.runId && value.status === 'failed',
      );
      assert.ok(refused.error);
      assert.deepEqual(refused.pendingApprovals, []);
      assert.equal(
        finalHost.observed.some(
          value =>
            value.runId === malformed.runId &&
            value.pendingApprovals.length > 0,
        ),
        false,
      );
      for (const kind of ['command', 'file']) {
        await assert.rejects(
          readFile(
            join(
              supervised.directory,
              `.nesvo-codex-action-${refused.providerSessionId}-${kind}.json`,
            ),
          ),
          { code: 'ENOENT' },
        );
      }
    }
    const requestApproval = async (currentHost, prompt) => {
      const run = await sendCodex(currentHost, supervised, prompt);
      const pending = await currentHost.event(
        value =>
          value.runId === run.runId && value.pendingApprovals.length === 1,
      );
      assert.equal(pending.status, 'running');
      return { run, pending, approval: pending.pendingApprovals[0] };
    };
    const decision = (pending, choice, overrides = {}) => ({
      sessionId: supervised.id,
      runId: pending.run.runId,
      requestId: pending.approval.id,
      decision: choice,
      ...overrides,
    });
    const command = await requestApproval(finalHost, 'fixture:approve');
    assert.equal(command.approval.kind, 'command');
    assert.equal(command.approval.directory, supervised.directory);
    assert.match(command.approval.detail, /fixture write approved marker/);
    for (const overrides of [
      { sessionId: readOnly.id },
      { runId: randomUUID() },
      { requestId: 'stale-request' },
    ]) {
      assert.equal(
        (
          await finalHost.request(
            'respond-approval',
            decision(command, 'accept', overrides),
          )
        ).code,
        'invalid-request',
      );
    }
    await assert.rejects(
      readFile(
        join(
          supervised.directory,
          `.nesvo-codex-action-${command.pending.providerSessionId}-command.json`,
        ),
      ),
      { code: 'ENOENT' },
    );
    assert.equal(
      (
        await finalHost.request(
          'respond-approval',
          decision(command, 'decline'),
        )
      ).type,
      'session',
    );
    const declined = await finalHost.event(
      value =>
        value.runId === command.run.runId && value.status === 'completed',
    );
    assert.equal(agent(declined).body, 'Codex fixture command declined.');
    assert.deepEqual(declined.pendingApprovals, []);
    await assert.rejects(
      readFile(
        join(
          supervised.directory,
          `.nesvo-codex-action-${declined.providerSessionId}-command.json`,
        ),
      ),
      { code: 'ENOENT' },
    );
    for (const [prompt, kind] of [
      ['fixture:file', 'file-change'],
      ['fixture:approve', 'command'],
    ]) {
      const approval = await requestApproval(finalHost, prompt);
      assert.equal(approval.approval.kind, kind);
      assert.equal(
        (
          await finalHost.request(
            'respond-approval',
            decision(approval, 'accept'),
          )
        ).type,
        'session',
      );
      const accepted = await finalHost.event(
        value =>
          value.runId === approval.run.runId && value.status === 'completed',
      );
      const actionKind = kind === 'file-change' ? 'file' : 'command';
      assert.equal(
        agent(accepted).body,
        `Codex fixture ${actionKind} accepted.`,
      );
      assert.deepEqual(accepted.pendingApprovals, []);
      const marker = JSON.parse(
        await readFile(
          join(
            supervised.directory,
            `.nesvo-codex-action-${accepted.providerSessionId}-${actionKind}.json`,
          ),
          'utf8',
        ),
      );
      assert.equal(marker.kind, actionKind);
      assert.equal(marker.decision, 'accept');
      assert.equal(
        (
          await finalHost.request(
            'respond-approval',
            decision(approval, 'accept'),
          )
        ).code,
        'invalid-request',
      );
    }
    const codexHold = async currentHost => {
      const pending = await requestApproval(
        currentHost,
        'fixture:approval-hold',
      );
      const pids = JSON.parse(await readFile(pidFile + '.codex', 'utf8'));
      assert.equal(pids.sessionId, pending.pending.providerSessionId);
      assert.ok(alive(pids.pid));
      assert.ok(alive(pids.childPid));
      ownedPids.add(pids.pid).add(pids.childPid);
      return { ...pending, pids: [pids.pid, pids.childPid] };
    };
    const approvalStopped = await codexHold(finalHost);
    await finalHost.request('stop-run', {
      sessionId: supervised.id,
      runId: approvalStopped.run.runId,
    });
    const stoppedApproval = await finalHost.event(
      value =>
        value.runId === approvalStopped.run.runId && value.status === 'stopped',
    );
    assert.deepEqual(stoppedApproval.pendingApprovals, []);
    assert.equal(
      stoppedApproval.activities.find(
        item => item.runId === approvalStopped.run.runId,
      ).status,
      'stopped',
    );
    await processesGone(approvalStopped.pids, ownedPids);
    assert.equal(
      (
        await finalHost.request(
          'respond-approval',
          decision(approvalStopped, 'accept'),
        )
      ).code,
      'invalid-request',
    );
    await finalHost.stop();
    const activityRecovery = new DatabaseSync(path);
    try {
      const unfinished = structuredClone(codexCompleted);
      unfinished.status = 'running';
      agent(unfinished).state = 'running';
      agent(unfinished).completedAt = null;
      unfinished.activities[1].status = 'running';
      unfinished.activities[1].completedAt = null;
      activityRecovery
        .prepare('UPDATE sessions SET document = ? WHERE id = ?')
        .run(JSON.stringify(unfinished), readOnly.id);
    } finally {
      activityRecovery.close();
    }
    const codexReopened = open();
    const recoveredActivities = (
      await codexReopened.request('list-sessions')
    ).sessions.find(item => item.id === readOnly.id);
    assert.equal(recoveredActivities.status, 'interrupted');
    assert.equal(recoveredActivities.activities[0].status, 'completed');
    assert.equal(recoveredActivities.activities[1].status, 'interrupted');
    assert.equal(
      recoveredActivities.activities[1].id,
      codexCompleted.activities[1].id,
    );
    assert.ok(recoveredActivities.activities[1].completedAt);
    const nativeContinuation = await sendCodex(
      codexReopened,
      readOnly,
      'fixture:continue',
    );
    const nativeResumed = await codexReopened.event(
      value =>
        value.runId === nativeContinuation.runId &&
        value.status === 'completed',
    );
    assert.equal(agent(nativeResumed).body, 'Codex fixture resumed reply.');
    assert.equal(
      nativeResumed.providerSessionId,
      codexCompleted.providerSessionId,
    );
    const boundedActivities = (
      await codexReopened.request('create-session', {
        ...create(''),
        provider: 'Codex',
        model: 'fixture-codex',
        mode: 'read-only',
      })
    ).session;
    const initialActivityRun = await sendCodex(
      codexReopened,
      boundedActivities,
      'fixture:stream',
    );
    await codexReopened.event(
      value =>
        value.runId === initialActivityRun.runId &&
        value.status === 'completed',
    );
    let activityResult;
    for (let index = 0; index < 3; index++) {
      const activityRun = await sendCodex(
        codexReopened,
        boundedActivities,
        'fixture:activities',
      );
      activityResult = await codexReopened.event(
        value =>
          value.runId === activityRun.runId && value.status === 'completed',
      );
      const currentActivities = activityResult.activities.filter(
        item => item.runId === activityRun.runId,
      );
      assert.equal(currentActivities.length, 100);
      assert.match(currentActivities[0].id, /fixture-command-5-/);
      assert.equal(currentActivities.at(-1).status, 'interrupted');
      assert.ok(
        activityResult.activityTruncatedRunIds.includes(activityRun.runId),
      );
      assert.equal(currentActivities[1].status, 'failed');
      assert.match(currentActivities[1].detail, /Exit code: 7/);
      assert.equal(currentActivities[2].truncated, true);
      assert.ok(
        currentActivities.every(
          item => item.output.length <= 4000 && item.detail.length <= 2000,
        ),
      );
      assert.ok(
        currentActivities.every(
          item => !item.output.includes('fixture-secret'),
        ),
      );
    }
    assert.equal(activityResult.activities.length, 300);
    assert.equal(activityResult.activitiesTruncated, true);
    assert.ok(
      activityResult.activityTruncatedRunIds.includes(initialActivityRun.runId),
    );
    assert.equal(
      activityResult.activities.some(
        item => item.runId === initialActivityRun.runId,
      ),
      false,
    );
    const awaitingShutdown = await codexHold(codexReopened);
    await codexReopened.stop();
    await processesGone(awaitingShutdown.pids, ownedPids);
    const checked = open();
    const shutdownSession = (
      await checked.request('list-sessions')
    ).sessions.find(value => value.id === supervised.id);
    assert.equal(shutdownSession.status, 'stopped');
    assert.deepEqual(shutdownSession.pendingApprovals, []);
    const legacyRun = await sendCodex(
      checked,
      legacySession,
      'fixture:continue',
    );
    const legacyCompleted = await checked.event(
      value =>
        value.id === legacySession.id &&
        value.runId === legacyRun.runId &&
        value.status === 'completed',
    );
    assert.equal(legacyCompleted.delegationEnabled, false);
    const legacyResume = await sendCodex(
      checked,
      legacyCompleted,
      'fixture:continue',
    );
    const legacyResumed = await checked.event(
      value =>
        value.id === legacySession.id &&
        value.runId === legacyResume.runId &&
        value.status === 'completed',
    );
    assert.equal(
      legacyResumed.providerSessionId,
      legacyCompleted.providerSessionId,
    );
    assert.equal(legacyResumed.delegationEnabled, false);
    const supervisedPlanRun = await sendCodex(
      checked,
      supervised,
      'fixture:delegate-mixed',
    );
    const supervisedPlan = await checked.event(
      value =>
        value.id === supervised.id &&
        value.runId === supervisedPlanRun.runId &&
        value.delegations.filter(item => item.runId === value.runId).length ===
          2,
    );
    assert.equal(supervisedPlan.role, 'orchestrator');
    assert.equal(supervisedPlan.mode, 'supervised');
    const supervisedProposals = supervisedPlan.delegations.filter(
      item => item.runId === supervisedPlanRun.runId,
    );
    assert.ok(supervisedProposals.every(item => item.mode === 'read-only'));
    for (const [index, proposal] of supervisedProposals.entries()) {
      const decision = await checked.request('decide-delegation', {
        sessionId: supervised.id,
        runId: supervisedPlanRun.runId,
        delegationId: proposal.id,
        decision: index === 0 ? 'accept' : 'decline',
      });
      assert.equal(decision.type, 'session', JSON.stringify(decision));
    }
    const supervisedDelegated = await checked.event(
      value =>
        value.id === supervised.id &&
        value.runId === supervisedPlanRun.runId &&
        value.status === 'completed',
    );
    assert.equal(supervisedDelegated.mode, 'supervised');
    assert.equal(
      supervisedDelegated.providerSessionId,
      supervisedPlanRun.providerSessionId,
    );
    assert.deepEqual(
      JSON.parse(
        agent(supervisedDelegated).body.slice(
          'Codex delegation results: '.length,
        ),
      ).results.map(item => item.status),
      ['completed', 'declined'],
    );
    const supervisedResult = await checked.review(
      value => value.runId === supervisedPlanRun.runId,
    );
    assert.equal(
      supervisedResult.diff.status,
      'complete',
      supervisedResult.diff.detail,
    );
    assert.equal(supervisedResult.dependencies.length, 1);
    const rejectedWriteRun = await sendCodex(
      checked,
      supervised,
      'fixture:delegate-writable',
    );
    const rejectedWritePlan = await checked.event(
      value =>
        value.id === supervised.id &&
        value.runId === rejectedWriteRun.runId &&
        value.status === 'completed',
    );
    const rejectedWriteResult = JSON.parse(
      agent(rejectedWritePlan).body.slice('Codex delegation results: '.length),
    );
    assert.match(
      rejectedWriteResult.error,
      /write access can delegate read-only workers/,
    );
    assert.equal(rejectedWritePlan.mode, 'supervised');
    assert.equal(
      rejectedWritePlan.providerSessionId,
      supervisedPlanRun.providerSessionId,
    );
    assert.equal(
      rejectedWritePlan.delegations.filter(
        item => item.runId === rejectedWriteRun.runId,
      ).length,
      0,
    );
    assert.equal(
      (await checked.request('list-sessions')).sessions.filter(
        value =>
          value.parentId === supervised.id &&
          value.parentRunId === rejectedWriteRun.runId,
      ).length,
      0,
    );
    const rootResponse = await checked.request('create-session', {
      ...create(''),
      provider: 'Codex',
      model: 'fixture-codex',
      role: 'orchestrator',
      mode: 'read-only',
    });
    assert.equal(rootResponse.type, 'session', JSON.stringify(rootResponse));
    const root = rootResponse.session;
    assert.equal(root.role, 'standalone');
    assert.equal(root.delegationEnabled, true);
    assert.equal(root.parentId, null);
    const outside = join(directory, 'outside-delegation');
    await mkdir(outside);
    await symlink(
      outside,
      join(root.directory, 'outside-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const plan = async (currentHost, prompt = 'fixture:delegate') => {
      const run = await sendCodex(currentHost, root, prompt);
      const pending = await currentHost.event(
        value =>
          value.id === root.id &&
          value.runId === run.runId &&
          value.delegations.filter(item => item.runId === run.runId).length > 0,
      );
      const proposals = pending.delegations.filter(
        item => item.runId === run.runId,
      );
      assert.ok(
        proposals.every(
          item => item.status === 'pending' && item.childSessionId === null,
        ),
      );
      return { run, proposals };
    };
    const decide = (currentHost, planned, proposal, decision, overrides = {}) =>
      currentHost.request('decide-delegation', {
        sessionId: root.id,
        runId: planned.run.runId,
        delegationId: proposal.id,
        decision,
        ...overrides,
      });
    const parentResult = async (currentHost, planned) => {
      const completed = await currentHost.event(
        value =>
          value.id === root.id &&
          value.runId === planned.run.runId &&
          value.status === 'completed',
      );
      assert.ok(agent(completed).body.startsWith('Codex delegation results: '));
      return {
        parent: completed,
        result: JSON.parse(
          agent(completed).body.slice('Codex delegation results: '.length),
        ),
      };
    };
    const beforeProposalPids = (await readdir(pidFile + '.workers')).sort();
    const firstPlan = await plan(checked);
    assert.equal(
      (await checked.request('list-sessions')).sessions.find(
        value => value.id === root.id,
      ).role,
      'orchestrator',
    );
    assert.equal(firstPlan.proposals.length, 2);
    assert.equal(
      (await checked.request('list-sessions')).sessions.filter(
        value => value.parentId === root.id,
      ).length,
      0,
    );
    assert.deepEqual(
      (await readdir(pidFile + '.workers')).sort(),
      beforeProposalPids,
    );
    for (const overrides of [
      { sessionId: supervised.id },
      { runId: randomUUID() },
      { delegationId: randomUUID() },
    ]) {
      assert.equal(
        (
          await decide(
            checked,
            firstPlan,
            firstPlan.proposals[0],
            'accept',
            overrides,
          )
        ).code,
        'invalid-request',
      );
    }
    assert.equal(
      (await decide(checked, firstPlan, firstPlan.proposals[0], 'accept')).type,
      'session',
    );
    const firstChild = await checked.event(
      value =>
        value.parentId === root.id &&
        value.parentRunId === firstPlan.run.runId &&
        value.status === 'completed',
    );
    assert.equal(firstChild.title, 'Fixture worker A');
    assert.equal(firstChild.role, 'worker');
    assert.equal(firstChild.delegationEnabled, false);
    assert.equal(firstChild.scope, firstPlan.proposals[0].scope);
    assert.equal(firstChild.messages[0].body, firstPlan.proposals[0].task);
    assert.match(agent(firstChild).body, /worker a completed/);
    const firstChildReview = await checked.review(
      value => value.runId === firstChild.runId && value.status === 'pending',
    );
    assert.equal(
      (
        await checked.request('decide-review', {
          reviewId: firstChildReview.id,
          version: firstChildReview.version,
          decisionId: randomUUID(),
          decision: 'accept',
          feedback: '',
        })
      ).code,
      'busy',
    );
    assert.equal(
      (await decide(checked, firstPlan, firstPlan.proposals[0], 'accept')).code,
      'invalid-request',
    );
    assert.equal(
      (await decide(checked, firstPlan, firstPlan.proposals[1], 'decline'))
        .type,
      'session',
    );
    const firstResults = await parentResult(checked, firstPlan);
    assert.deepEqual(
      firstResults.result.results.map(value => value.status),
      ['completed', 'declined'],
    );
    assert.equal(firstResults.result.results[0].childSessionId, firstChild.id);
    assert.match(firstResults.result.results[0].text, /worker a completed/);
    assert.equal(firstResults.result.results[1].childSessionId, null);
    const parentReview = await checked.review(
      value =>
        value.runId === firstPlan.run.runId && value.status === 'pending',
    );
    assert.deepEqual(parentReview.dependencies, [
      {
        sessionId: firstChild.id,
        reviewId: firstChildReview.id,
        version: firstChildReview.version,
      },
    ]);
    const parentCorrection = await checked.request('decide-review', {
      reviewId: parentReview.id,
      version: parentReview.version,
      decisionId: randomUUID(),
      decision: 'request-changes',
      feedback: 'fixture:continue Refine the summary without new delegation.',
    });
    assert.equal(
      parentCorrection.type,
      'review',
      JSON.stringify(parentCorrection),
    );
    const correctedParent = await checked.event(
      value =>
        value.id === root.id &&
        value.runId !== firstPlan.run.runId &&
        value.status === 'completed',
    );
    assert.equal(
      correctedParent.providerSessionId,
      firstResults.parent.providerSessionId,
    );
    const correctedParentReview = await checked.review(
      value =>
        value.runId === correctedParent.runId && value.status === 'pending',
    );
    assert.deepEqual(
      correctedParentReview.dependencies,
      parentReview.dependencies,
    );
    const parentDecisionId = randomUUID();
    assert.equal(
      (
        await checked.request('decide-review', {
          reviewId: correctedParentReview.id,
          version: correctedParentReview.version,
          decisionId: parentDecisionId,
          decision: 'accept',
          feedback: '',
        })
      ).review.status,
      'accepted',
    );
    const childCorrection = await checked.request('decide-review', {
      reviewId: firstChildReview.id,
      version: firstChildReview.version,
      decisionId: randomUUID(),
      decision: 'request-changes',
      feedback: 'fixture:worker-complete:a Refine the scoped answer.',
    });
    assert.equal(
      childCorrection.type,
      'review',
      JSON.stringify(childCorrection),
    );
    const correctedChild = await checked.event(
      value =>
        value.id === firstChild.id &&
        value.runId !== firstChild.runId &&
        value.status === 'completed',
    );
    assert.equal(
      correctedChild.providerSessionId,
      firstChild.providerSessionId,
    );
    const correctedChildReview = await checked.review(
      value =>
        value.runId === correctedChild.runId && value.status === 'pending',
    );
    assert.ok(correctedChildReview.version > firstChildReview.version);
    const invalidatedParent = (
      await checked.request('list-reviews')
    ).reviews.find(value => value.id === correctedParentReview.id);
    assert.equal(invalidatedParent.status, 'superseded');
    assert.equal(invalidatedParent.decision.id, parentDecisionId);
    assert.equal(
      (
        await checked.request('decide-review', {
          reviewId: correctedParentReview.id,
          version: correctedParentReview.version,
          decisionId: randomUUID(),
          decision: 'accept',
          feedback: '',
        })
      ).code,
      'invalid-request',
    );

    for (const prompt of [
      'fixture:delegate-too-many',
      'fixture:delegate-escape',
      'fixture:delegate-symlink',
      'fixture:delegate-overlap',
    ]) {
      const invalid = await sendCodex(checked, root, prompt);
      const result = await parentResult(checked, { run: invalid });
      assert.ok(result.result.error, JSON.stringify(result));
      assert.equal(
        result.parent.delegations.filter(item => item.runId === invalid.runId)
          .length,
        0,
      );
    }
    const mixed = await plan(checked, 'fixture:delegate-mixed');
    for (const proposal of mixed.proposals)
      assert.equal(
        (await decide(checked, mixed, proposal, 'accept')).type,
        'session',
      );
    const mixedResults = await parentResult(checked, mixed);
    assert.deepEqual(
      mixedResults.result.results.map(value => value.status),
      ['completed', 'failed'],
    );
    const mixedChildren = (
      await checked.request('list-sessions')
    ).sessions.filter(value => value.parentRunId === mixed.run.runId);
    for (const item of mixedResults.result.results) {
      const child = mixedChildren.find(
        value => value.id === item.childSessionId,
      );
      assert.equal(child.parentId, root.id);
      assert.equal(child.status, item.status);
      if (item.status === 'failed') assert.match(item.error, /worker b failed/);
    }
    const recursive = await plan(checked, 'fixture:delegate-recursive');
    await decide(checked, recursive, recursive.proposals[0], 'accept');
    const recursiveResult = await parentResult(checked, recursive);
    assert.equal(recursiveResult.result.results[0].status, 'failed');
    const recursiveChildId = recursiveResult.result.results[0].childSessionId;
    assert.equal(
      (await checked.request('list-sessions')).sessions.some(
        value => value.parentId === recursiveChildId,
      ),
      false,
    );

    await rm(join(root.directory, 'outside-link'));
    await Promise.all([
      writeFile(join(root.directory, 'tracked.txt'), 'worker dirty baseline\n'),
      writeFile(
        join(root.directory, 'deleted.txt'),
        'worker deletion baseline\n',
      ),
      writeFile(
        join(root.directory, 'dirty.txt'),
        'unrelated worker baseline\n',
      ),
    ]);
    const writablePlan = await plan(checked, 'fixture:delegate-writable');
    await decide(checked, writablePlan, writablePlan.proposals[0], 'accept');
    const writableResults = await parentResult(checked, writablePlan);
    const writableChildId = writableResults.result.results[0].childSessionId;
    const writableChildReview = await checked.review(
      value =>
        value.sessionId === writableChildId && value.status === 'pending',
    );
    assert.equal(
      writableChildReview.diff.status,
      'complete',
      writableChildReview.diff.detail,
    );
    const writableParentReview = await checked.review(
      value =>
        value.runId === writablePlan.run.runId && value.status === 'pending',
    );
    assert.equal(writableParentReview.diff.status, 'not-applicable');
    assert.deepEqual(writableParentReview.dependencies, [
      {
        sessionId: writableChildId,
        reviewId: writableChildReview.id,
        version: writableChildReview.version,
      },
    ]);
    await writeFile(
      join(root.directory, 'tracked.txt'),
      'external edit after worker result\n',
    );
    assert.equal(
      (
        await checked.request('decide-review', {
          reviewId: writableParentReview.id,
          version: writableParentReview.version,
          decisionId: randomUUID(),
          decision: 'accept',
          feedback: '',
        })
      ).code,
      'invalid-request',
    );
    assert.notEqual(
      (await checked.request('list-reviews')).reviews.find(
        value => value.id === writableParentReview.id,
      ).status,
      'accepted',
    );

    const runningChildren = async (currentHost, planned) => {
      for (const proposal of planned.proposals)
        assert.equal(
          (await decide(currentHost, planned, proposal, 'accept')).type,
          'session',
        );
      const workers = [];
      for (const label of ['a', 'b']) {
        const child = await currentHost.event(
          value =>
            value.parentId === root.id &&
            value.parentRunId === planned.run.runId &&
            value.status === 'running' &&
            agent(value)?.body.includes(`Codex worker ${label} is waiting.`),
        );
        const pids = JSON.parse(
          await readFile(
            join(pidFile + '.workers', `${child.providerSessionId}.json`),
            'utf8',
          ),
        );
        ownedPids.add(pids.pid).add(pids.childPid);
        assert.ok(alive(pids.pid));
        assert.ok(alive(pids.childPid));
        assert.equal(child.delegationEnabled, false);
        workers.push({ child, pids: [pids.pid, pids.childPid] });
      }
      return workers;
    };
    const concurrent = await plan(checked, 'fixture:delegate-two-hold');
    const workers = await runningChildren(checked, concurrent);
    for (const label of ['a', 'b'])
      await checked.event(
        value =>
          value.parentRunId === concurrent.run.runId &&
          agent(value)?.body.includes(`${label}:2`),
      );
    assert.equal((await checked.request('health')).health.status, 'ready');
    assert.equal(
      (
        await checked.request('send-message', {
          sessionId: supervised.id,
          messageId: randomUUID(),
          text: 'fixture:stream',
        })
      ).code,
      'busy',
    );
    await checked.request('stop-run', {
      sessionId: workers[0].child.id,
      runId: workers[0].child.runId,
    });
    await checked.event(
      value => value.id === workers[0].child.id && value.status === 'stopped',
    );
    await processesGone(workers[0].pids, ownedPids);
    const aliveGroup = (await checked.request('list-sessions')).sessions;
    assert.equal(
      aliveGroup.find(value => value.id === workers[1].child.id).status,
      'running',
    );
    assert.equal(
      aliveGroup.find(value => value.id === root.id).status,
      'running',
    );
    for (const pid of workers[1].pids) assert.ok(alive(pid));
    await checked.request('stop-run', {
      sessionId: root.id,
      runId: concurrent.run.runId,
    });
    const stoppedGroup = await checked.event(
      value =>
        value.id === root.id &&
        value.runId === concurrent.run.runId &&
        value.status === 'stopped',
    );
    assert.ok(
      stoppedGroup.delegations
        .filter(item => item.runId === concurrent.run.runId)
        .every(item => item.status === 'stopped'),
    );
    await processesGone(workers[1].pids, ownedPids);
    const stoppedRevision = stoppedGroup.revision;
    await delay(200);
    const settled = (await checked.request('list-sessions')).sessions.find(
      value => value.id === root.id,
    );
    assert.equal(settled.status, 'stopped');
    assert.equal(
      (await checked.request('list-reviews')).reviews.some(
        value =>
          value.runId === concurrent.run.runId ||
          workers.some(worker => worker.child.runId === value.runId),
      ),
      false,
    );
    assert.ok(settled.revision >= stoppedRevision);
    assert.equal(
      checked.observed.some(
        value =>
          value.id === root.id &&
          value.runId === concurrent.run.runId &&
          value.status === 'completed',
      ),
      false,
    );
    const pendingStop = await plan(checked);
    await checked.request('stop-run', {
      sessionId: root.id,
      runId: pendingStop.run.runId,
    });
    const pendingStopped = await checked.event(
      value =>
        value.id === root.id &&
        value.runId === pendingStop.run.runId &&
        value.status === 'stopped',
    );
    assert.ok(
      pendingStopped.delegations
        .filter(item => item.runId === pendingStop.run.runId)
        .every(item => item.status === 'stopped'),
    );
    assert.equal(
      (await decide(checked, pendingStop, pendingStop.proposals[0], 'accept'))
        .code,
      'invalid-request',
    );
    const closingPlan = await plan(checked, 'fixture:delegate-two-hold');
    const closingWorkers = await runningChildren(checked, closingPlan);
    await checked.stop();
    await processesGone(
      closingWorkers.flatMap(worker => worker.pids),
      ownedPids,
    );
    const afterGroup = open();
    const persistedGroup = (await afterGroup.request('list-sessions')).sessions;
    const persistedRoot = persistedGroup.find(value => value.id === root.id);
    assert.equal(persistedRoot.status, 'stopped');
    assert.equal(persistedRoot.delegationEnabled, true);
    for (const worker of closingWorkers)
      assert.equal(
        persistedGroup.find(value => value.id === worker.child.id).status,
        'stopped',
      );
    const continuedRoot = await sendCodex(afterGroup, root, 'fixture:continue');
    await afterGroup.event(
      value =>
        value.id === root.id &&
        value.runId === continuedRoot.runId &&
        value.status === 'completed',
    );
    assert.equal(
      (await afterGroup.request('list-sessions')).sessions.filter(
        value => value.parentId === root.id,
      ).length,
      persistedGroup.filter(value => value.parentId === root.id).length,
    );
    const historyDatabase = new DatabaseSync(path);
    try {
      const boundedRoot = JSON.parse(
        historyDatabase
          .prepare('SELECT document FROM sessions WHERE id = ?')
          .get(root.id).document,
      );
      boundedRoot.delegations = Array.from({ length: 100 }, () => ({
        ...boundedRoot.delegations[0],
        id: randomUUID(),
        runId: randomUUID(),
        status: 'declined',
        childSessionId: null,
        error: null,
      }));
      historyDatabase
        .prepare('UPDATE sessions SET document = ? WHERE id = ?')
        .run(JSON.stringify(boundedRoot), root.id);
    } finally {
      historyDatabase.close();
    }
    const historyRun = await sendCodex(
      afterGroup,
      root,
      'fixture:delegate-mixed',
    );
    const historyBound = await parentResult(afterGroup, { run: historyRun });
    assert.match(historyBound.result.error, /delegation history limit/);
    assert.equal(historyBound.parent.delegations.length, 100);
    assert.equal(
      historyBound.parent.providerSessionId,
      persistedRoot.providerSessionId,
    );
    const reviewWorkspace = join(directory, 'review-workspace');
    await mkdir(reviewWorkspace);
    await Promise.all([
      writeFile(join(reviewWorkspace, 'tracked.txt'), 'user dirty baseline\n'),
      writeFile(join(reviewWorkspace, 'deleted.txt'), 'delete this baseline\n'),
      writeFile(
        join(reviewWorkspace, 'dirty.txt'),
        'unrelated operator edits\n',
      ),
    ]);
    const writing = (
      await afterGroup.request('create-session', {
        ...create(reviewWorkspace),
        provider: 'Codex',
        model: 'fixture-codex',
        mode: 'supervised',
      })
    ).session;
    const writingRun = await sendCodex(
      afterGroup,
      writing,
      'fixture:review-write',
    );
    const initialFiles = await afterGroup.event(
      value =>
        value.id === writing.id &&
        value.runId === writingRun.runId &&
        value.status === 'completed',
    );
    const initialReview = await afterGroup.review(
      value => value.runId === writingRun.runId && value.status === 'pending',
    );
    assert.equal(initialReview.summary, 'Codex fixture initial files.');
    assert.equal(initialReview.version, 1);
    assert.ok(initialFiles.revision > initialReview.version);
    assert.equal(
      initialReview.diff.status,
      'complete',
      initialReview.diff.detail,
    );
    assert.deepEqual(
      initialReview.diff.files.toSorted((left, right) =>
        left.path.localeCompare(right.path),
      ),
      [
        { path: 'created.txt', kind: 'added' },
        { path: 'deleted.txt', kind: 'deleted' },
        { path: 'tracked.txt', kind: 'modified' },
      ],
    );
    assert.match(initialReview.diff.patch, /-user dirty baseline/);
    assert.match(initialReview.diff.patch, /\+initial agent text/);
    assert.doesNotMatch(
      initialReview.diff.patch,
      /dirty\.txt|unrelated operator edits|\.nesvo-codex/,
    );
    assert.equal(
      await readFile(join(reviewWorkspace, 'dirty.txt'), 'utf8'),
      'unrelated operator edits\n',
    );
    const correctionInput = {
      reviewId: initialReview.id,
      version: initialReview.version,
      decisionId: randomUUID(),
      decision: 'request-changes',
      feedback: 'fixture:review-correct Please correct the result.',
    };
    const correction = await afterGroup.request(
      'decide-review',
      correctionInput,
    );
    assert.equal(correction.type, 'review', JSON.stringify(correction));
    assert.equal(correction.review.decision.id, correctionInput.decisionId);
    assert.deepEqual(
      (await afterGroup.request('decide-review', correctionInput)).review,
      correction.review,
    );
    const correctedFiles = await afterGroup.event(
      value =>
        value.id === writing.id &&
        value.runId !== writingRun.runId &&
        value.status === 'completed',
    );
    assert.equal(
      correctedFiles.providerSessionId,
      initialFiles.providerSessionId,
    );
    assert.equal(
      correctedFiles.messages.length,
      initialFiles.messages.length + 2,
    );
    assert.match(correctedFiles.messages.at(-2).body, /fixture:review-correct/);
    const correctedReview = await afterGroup.review(
      value =>
        value.runId === correctedFiles.runId && value.status === 'pending',
    );
    assert.ok(correctedReview.version > initialReview.version);
    assert.equal(correctedReview.summary, 'Codex fixture corrected files.');
    assert.equal(correctedReview.decision, null);
    assert.match(correctedReview.diff.patch, /-initial agent text/);
    assert.match(correctedReview.diff.patch, /\+corrected agent text/);
    assert.equal(
      (
        await afterGroup.request('decide-review', {
          reviewId: initialReview.id,
          version: initialReview.version,
          decisionId: randomUUID(),
          decision: 'accept',
          feedback: '',
        })
      ).code,
      'invalid-request',
    );
    const acceptCorrected = {
      reviewId: correctedReview.id,
      version: correctedReview.version,
      decisionId: randomUUID(),
      decision: 'accept',
      feedback: '',
    };
    const acceptedFiles = await afterGroup.request(
      'decide-review',
      acceptCorrected,
    );
    assert.equal(acceptedFiles.type, 'review', JSON.stringify(acceptedFiles));
    assert.equal(acceptedFiles.review.status, 'accepted');
    assert.deepEqual(
      (await afterGroup.request('decide-review', acceptCorrected)).review,
      acceptedFiles.review,
    );
    await afterGroup.stop();
    const reviewsReopened = open();
    const restoredReviews = (await reviewsReopened.request('list-reviews'))
      .reviews;
    assert.deepEqual(
      restoredReviews.find(value => value.id === correctedReview.id),
      acceptedFiles.review,
    );
    assert.equal(
      restoredReviews.find(value => value.id === initialReview.id).decision
        .feedback,
      correctionInput.feedback,
    );
    const refreshRun = await sendCodex(
      reviewsReopened,
      writing,
      'fixture:continue',
    );
    await reviewsReopened.event(
      value =>
        value.id === writing.id &&
        value.runId === refreshRun.runId &&
        value.status === 'completed',
    );
    const refreshed = await reviewsReopened.review(
      value => value.runId === refreshRun.runId && value.status === 'pending',
    );
    assert.ok(refreshed.version > correctedReview.version);
    assert.equal(
      (await reviewsReopened.request('list-reviews')).reviews.find(
        value => value.id === correctedReview.id,
      ).status,
      'superseded',
    );
    await writeFile(
      join(reviewWorkspace, 'tracked.txt'),
      'external edit after the result\n',
    );
    assert.equal(
      (
        await reviewsReopened.request('decide-review', {
          reviewId: refreshed.id,
          version: refreshed.version,
          decisionId: randomUUID(),
          decision: 'accept',
          feedback: '',
        })
      ).code,
      'invalid-request',
    );
    assert.notEqual(
      (await reviewsReopened.request('list-reviews')).reviews.find(
        value => value.id === refreshed.id,
      ).status,
      'accepted',
    );
    const binaryRun = await sendCodex(
      reviewsReopened,
      writing,
      'fixture:review-binary',
    );
    await reviewsReopened.event(
      value =>
        value.id === writing.id &&
        value.runId === binaryRun.runId &&
        value.status === 'completed',
    );
    const binaryReview = await reviewsReopened.review(
      value => value.runId === binaryRun.runId && value.status === 'pending',
    );
    assert.equal(binaryReview.diff.status, 'unavailable');
    assert.equal(
      (
        await reviewsReopened.request('decide-review', {
          reviewId: binaryReview.id,
          version: binaryReview.version,
          decisionId: randomUUID(),
          decision: 'accept',
          feedback: '',
        })
      ).code,
      'invalid-request',
    );
    await reviewsReopened.stop();
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
    const host = launch(directory, join(directory, 'unused-pids.json'));
    t.after(async () => {
      if (host.child.exitCode === null) host.child.kill();
      await host.exited;
      await rm(directory, { recursive: true, force: true });
    });
    assert.equal(
      (await bounded(host.exited, 'Host startup timed out')).code,
      1,
      host.error(),
    );
    const check = new DatabaseSync(path);
    try {
      assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99);
    } finally {
      check.close();
    }
  },
);
