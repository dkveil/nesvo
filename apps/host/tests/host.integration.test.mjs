import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const fixturePath = fileURLToPath(
  new URL('./claude-fixture.mjs', import.meta.url),
);
const codexFixturePath = fileURLToPath(
  new URL('./codex-fixture.mjs', import.meta.url),
);
const hungReaderPath = fileURLToPath(
  new URL('./git-head-hang-fixture.mjs', import.meta.url),
);

function bounded(promise, description, timeout = 10_000) {
  let timer;
  const timedOut = new Error();
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut.message =
          typeof description === 'function' ? description() : description;
        reject(timedOut);
      }, timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}

const fixtureEnvironment = (directory, pidFile) => ({
  NESVO_CLAUDE_EXECUTABLE: fixturePath,
  NESVO_FIXTURE_PID_FILE: pidFile,
  NESVO_FIXTURE_SKILL_LOG: pidFile + '.shared',
  NESVO_FIXTURE_USAGE_LOG: pidFile + '.usage',
  NESVO_FIXTURE_USAGE_CONTROL: join(directory, 'usage-control.json'),
  NESVO_CODEX_EXECUTABLE: codexFixturePath,
  NESVO_CODEX_FIXTURE_PID_FILE: pidFile + '.codex',
  NESVO_CODEX_FIXTURE_PID_DIR: pidFile + '.workers',
  NESVO_CODEX_FIXTURE_STATE_DIR: pidFile + '.state',
  NESVO_CODEX_FIXTURE_SKILLS_LOG: pidFile + '.skills',
  NESVO_CODEX_FIXTURE_RUN_LOG: pidFile + '.turns',
  NESVO_CODEX_FIXTURE_CATALOG: pidFile + '.catalog',
  CLAUDE_CONFIG_DIR: join(directory, 'claude-config'),
  CODEX_HOME: join(directory, 'codex-config'),
  NESVO_TEST_SKILLS_HOME: join(directory, 'skills-home'),
});

function launch(directory, pidFile) {
  const child = spawn(process.execPath, ['apps/host/dist/main.js'], {
    env: {
      ...process.env,
      NESVO_DATA_DIR: directory,
      ...fixtureEnvironment(directory, pidFile),
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
  const scheduledEvents = [];
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
      } else if (message.type.startsWith('scheduled-job-') && !message.id) {
        scheduledEvents.push(message);
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
    scheduledEvents,
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
          `Session event timed out: ${stderr}\n${JSON.stringify(observed.slice(-4).map(session => ({ id: session.id, runId: session.runId, provider: session.provider, status: session.status, error: session.error, body: agent(session)?.body, approvals: session.pendingApprovals?.map(approval => ({ id: approval.id, kind: approval.kind, detail: approval.detail.slice(0, 300) })) })))}`,
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
const unreportedUsage = {
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  costUsd: null,
  source: null,
  durationMs: null,
};
const claudeFixtureUsage = {
  inputTokens: 5500,
  outputTokens: 350,
  cachedInputTokens: 4000,
  costUsd: 0.0421,
  source: 'provider-report',
  durationMs: 2310,
};
const codexFixtureUsage = {
  inputTokens: 2500,
  outputTokens: 130,
  cachedInputTokens: 800,
  costUsd: null,
  source: 'provider-report',
  durationMs: 1800,
};
const byId = values =>
  values.toSorted((left, right) => left.id.localeCompare(right.id));
const assertInterruption = (session, reason) => {
  assert.equal(session.status, 'interrupted');
  assert.equal(agent(session).state, 'interrupted');
  assert.equal(session.interruption.runId, session.runId);
  assert.equal(session.interruption.reason, reason);
  assert.ok(Number.isFinite(Date.parse(session.interruption.at)));
  assert.deepEqual(agent(session).interruption, session.interruption);
};

test(
  'host migrates and persists sessions, streams, resumes and owns cancellation',
  { timeout: 120_000 },
  async t => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'nesvo-host-')),
    );
    const workspace = join(directory, 'non-git-workspace');
    const pidFile = join(directory, 'fixture-pids.json');
    const usageControl = join(directory, 'usage-control.json');
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
    await writeFile(usageControl, '{}');
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
      capabilities: ['scheduled-jobs', 'reasoning-effort'],
    });
    assert.equal(status.type, 'claude-status');
    assert.equal(status.status.status, 'ready');
    assert.equal(status.status.version, '2.1.0');
    assert.deepEqual(
      status.status.models.map(model => model.id),
      ['default', 'opus', 'sonnet', 'haiku'],
    );
    assert.equal(status.status.effort.status, 'unsupported');
    assert.match(status.status.effort.reason, /reasoning effort/);
    assert.deepEqual(
      await host.send(
        JSON.stringify({
          id: randomUUID(),
          method: 'read-git-branch',
          input: { directory },
        }),
      ),
      { type: 'error', id: null, code: 'invalid-request' },
    );
    const usageBefore = await host.request('list-sessions');
    const providers = ['Claude Code', 'Codex'];
    const readyUsage = new Map();
    for (const provider of providers) {
      const responses = await Promise.all(
        Array.from({ length: 3 }, () =>
          host.request('provider-usage', { provider }),
        ),
      );
      assert.ok(
        responses.every(response => response.type === 'provider-usage'),
      );
      const usage = responses[0].usage;
      for (const response of responses) assert.deepEqual(response.usage, usage);
      assert.equal(usage.provider, provider);
      assert.equal(usage.status, 'ready', JSON.stringify(usage));
      assert.ok(Number.isFinite(Date.parse(usage.checkedAt)));
      assert.equal(
        usage.source,
        provider === 'Codex' ? 'codex-app-server' : 'claude-control',
      );
      assert.equal(
        usage.account.label,
        provider === 'Codex'
          ? 'fixture@example.invalid'
          : 'claude-fixture@example.invalid',
      );
      assert.equal(usage.account.plan, provider === 'Codex' ? 'plus' : 'max');
      assert.deepEqual(
        usage.windows.map(window => window.usedPercent),
        provider === 'Codex' ? [25, 40] : [23.5, 61.25],
      );
      assert.deepEqual(
        usage.windows.map(window => window.resetsAt),
        ['2030-01-02T03:04:05.000Z', '2030-01-07T03:04:05.000Z'],
      );
      assert.deepEqual(
        usage.windows.map(window => window.windowMinutes),
        [300, 10080],
      );
      assert.equal(
        usage.ordinaryUsageAllowed,
        provider === 'Codex' ? true : null,
      );
      readyUsage.set(provider, usage);
    }
    const readUsageTrace = async () =>
      (await readFile(pidFile + '.usage', 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
    const usageProbes = await readUsageTrace();
    assert.equal(usageProbes.length, 2);
    for (const trace of usageProbes) {
      ownedPids.add(trace.pid);
      assert.deepEqual(
        trace.methods,
        trace.provider === 'Codex'
          ? [
              'initialize',
              'initialized',
              'account/read',
              'account/rateLimits/read',
            ]
          : ['initialize', 'get_usage'],
      );
    }
    await processesGone(
      usageProbes.map(trace => trace.pid),
      ownedPids,
    );
    assert.deepEqual(
      (await host.request('list-sessions')).sessions,
      usageBefore.sessions,
    );
    assert.deepEqual((await host.request('list-reviews')).reviews, []);
    await assert.rejects(readFile(pidFile + '.turns'), { code: 'ENOENT' });
    await writeFile(
      usageControl,
      JSON.stringify({ 'Claude Code': 'unavailable', Codex: 'unavailable' }),
    );
    for (const provider of providers)
      assert.deepEqual(
        (await host.request('provider-usage', { provider })).usage,
        readyUsage.get(provider),
      );
    assert.deepEqual(await readUsageTrace(), usageProbes);
    const create = directory => ({
      title: 'Fixture conversation',
      model: 'sonnet',
      directory,
    });
    const claudeConfig = join(directory, 'claude-config');
    const codexConfig = join(directory, 'codex-config');
    const skillDocument = (name, marker, fields = '') =>
      `---\nname: ${name}\ndescription: Shared fixture instructions.\n${fields}---\n${marker}\n`;
    const seedNativeSkill = async workspace => {
      const path = join(
        workspace,
        '.agents',
        'skills',
        'fixture-project-skill',
        'SKILL.md',
      );
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(
        path,
        skillDocument('Fixture project skill', 'FIXTURE_PROJECT_MARKER'),
      );
      await mkdir(join(workspace, '.git'), { recursive: true });
    };
    const skillsProject = join(directory, 'skills-claude');
    const metadata = [
      [
        join(claudeConfig, 'skills', 'fixture-claude-instructions', 'SKILL.md'),
        skillDocument(
          'Fixture Claude instructions',
          'FIXTURE_CLAUDE_SHARED_MARKER',
        ),
      ],
      [
        join(codexConfig, 'skills', 'fixture-codex-instructions', 'SKILL.md'),
        skillDocument(
          'Fixture Codex instructions',
          'FIXTURE_CODEX_SHARED_MARKER',
        ),
      ],
      [
        join(codexConfig, 'skills', 'fixture-native-disabled', 'SKILL.md'),
        skillDocument(
          'Fixture user skill',
          'Disabled source.',
          'enabled: false\n',
        ),
      ],
      [
        join(claudeConfig, 'skills', 'fixture-hooks', 'SKILL.md'),
        skillDocument(
          'Fixture blocked hooks',
          'Unsupported execution metadata.',
          'hooks: {}\n',
        ),
      ],
      [
        join(
          directory,
          'skills-home',
          '.agents',
          'skills',
          'fixture-shared-context',
          'SKILL.md',
        ),
        skillDocument(
          'Fixture Shared context',
          'Unsupported shared execution metadata.',
          'context: fork\n',
        ),
      ],
      ...['alpha', 'beta'].map(name => [
        join(codexConfig, 'skills', `fixture-twin-${name}`, 'SKILL.md'),
        skillDocument('Fixture twin', `Distinct ${name} source.`),
      ]),
      [
        join(
          skillsProject,
          '.claude',
          'skills',
          'fixture-project-skill',
          'SKILL.md',
        ),
        '---\nname: fixture-project-skill\ndescription: Project inventory fixture.\n---\nMetadata only.\n',
      ],
      [
        join(claudeConfig, 'skills', 'fixture-user-skill', 'SKILL.md'),
        '---\nname: fixture-user-skill\ndescription: User inventory fixture.\nuser-invocable: false\ndisable-model-invocation: true\n---\nMetadata only.\n',
      ],
      [
        join(
          skillsProject,
          '.claude',
          'commands',
          'fixture-project-command.md',
        ),
        '---\ndescription: Project command inventory fixture.\n---\nMetadata only.\n',
      ],
      [
        join(skillsProject, '.claude', 'skills', 'broken', 'SKILL.md'),
        '---\nname: [unterminated\n---\nMetadata only.\n',
      ],
      [
        join(claudeConfig, 'settings.json'),
        '{"permissions":{"defaultMode":"plan"}}\n',
      ],
    ];
    await mkdir(join(skillsProject, '.git'), { recursive: true });
    for (const [path, body] of metadata) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, body);
    }
    await seedNativeSkill(skillsProject);
    const sharedAlias = join(
      directory,
      'skills-home',
      '.agents',
      'skills',
      'claude-alias',
    );
    await mkdir(join(sharedAlias, '..'), { recursive: true });
    await symlink(
      join(metadata[0][0], '..'),
      sharedAlias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await symlink(
      join(claudeConfig, 'skills', 'fixture-hooks'),
      join(sharedAlias, '..', 'hooks-alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const inventorySession = (
      await host.request('create-session', create(skillsProject))
    ).session;
    const claudeInventory = await host.request('discover-skills', {
      sessionId: inventorySession.id,
    });
    assert.equal(
      claudeInventory.type,
      'skills',
      JSON.stringify(claudeInventory),
    );
    assert.equal(claudeInventory.catalog.method, 'library');
    assert.equal(claudeInventory.catalog.provider, 'Claude Code');
    assert.equal(claudeInventory.catalog.status, 'partial');
    assert.equal(claudeInventory.catalog.invocationSupported, true);
    assert.equal(claudeInventory.catalog.sessionId, inventorySession.id);
    const projectSkill = claudeInventory.catalog.skills.find(
      skill => skill.name === 'fixture-project-skill',
    );
    assert.equal(projectSkill.source, 'project');
    assert.equal(projectSkill.enabled, true);
    assert.equal(projectSkill.invocation, 'instructions');
    assert.ok(projectSkill.origins.includes('Claude Code'));
    const userSkill = claudeInventory.catalog.skills.find(
      skill => skill.name === 'fixture-user-skill',
    );
    assert.equal(userSkill.source, 'user');
    assert.equal(userSkill.userInvocable, false);
    assert.equal(userSkill.modelInvocable, false);
    assert.equal(userSkill.invocation, 'blocked');
    const sharedClaude = claudeInventory.catalog.skills.filter(
      skill => skill.name === 'Fixture Claude instructions',
    );
    assert.equal(sharedClaude.length, 1);
    assert.deepEqual(sharedClaude[0].origins, ['Claude Code', 'Shared']);
    const twins = claudeInventory.catalog.skills.filter(
      skill => skill.name === 'Fixture twin',
    );
    assert.equal(twins.length, 2);
    assert.notEqual(twins[0].id, twins[1].id);
    assert.notEqual(twins[0].path, twins[1].path);
    for (const skill of twins) assert.equal(skill.invocation, 'instructions');
    assert.equal(
      claudeInventory.catalog.skills.find(
        skill => skill.name === 'Fixture blocked hooks',
      ).invocation,
      'blocked',
    );
    assert.ok(
      claudeInventory.catalog.skills.some(
        skill =>
          skill.kind === 'command' && skill.name === 'fixture-project-command',
      ),
    );
    assert.ok(claudeInventory.catalog.issues.length > 0);
    assert.deepEqual(
      (await host.request('list-sessions')).sessions.find(
        value => value.id === inventorySession.id,
      ),
      inventorySession,
    );
    for (const [path, body] of metadata)
      assert.equal(await readFile(path, 'utf8'), body);
    assert.equal(
      (await host.request('discover-skills', { sessionId: randomUUID() })).code,
      'not-found',
    );
    for (const extra of [{ provider: 'Codex' }, { directory: skillsProject }]) {
      assert.deepEqual(
        await host.send(
          JSON.stringify({
            id: randomUUID(),
            method: 'discover-skills',
            input: { sessionId: inventorySession.id, ...extra },
          }),
        ),
        { type: 'error', id: null, code: 'invalid-request' },
      );
    }
    const sessionsBeforeDraft = (await host.request('list-sessions')).sessions;
    const draftInventory = await host.request('discover-skills', {
      provider: 'Claude Code',
      directory: skillsProject,
    });
    assert.equal(draftInventory.type, 'skills', JSON.stringify(draftInventory));
    assert.equal(draftInventory.catalog.sessionId, undefined);
    assert.ok(draftInventory.catalog.directory);
    assert.deepEqual(
      draftInventory.catalog.skills.map(skill => [
        skill.id,
        skill.invocation,
        skill.contentHash,
      ]),
      claudeInventory.catalog.skills.map(skill => [
        skill.id,
        skill.invocation,
        skill.contentHash,
      ]),
    );
    assert.deepEqual(
      (await host.request('list-sessions')).sessions,
      sessionsBeforeDraft,
    );
    assert.equal(
      (
        await host.request('discover-skills', {
          provider: 'Claude Code',
          directory: join(directory, 'missing-draft-folder'),
        })
      ).code,
      'invalid-directory',
    );
    assert.deepEqual(
      await host.send(
        JSON.stringify({
          id: randomUUID(),
          method: 'discover-skills',
          input: {
            provider: 'Claude Code',
            directory: skillsProject,
            mode: 'supervised',
          },
        }),
      ),
      { type: 'error', id: null, code: 'invalid-request' },
    );
    const nativeSkillSessions = new Map();
    const nativeSkillCatalogs = new Map();
    const readSkillTraces = async () =>
      (await readFile(pidFile + '.skills', 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
    for (const [variant, expected] of [
      ['codex', 'ready'],
      ['unsupported', 'unsupported'],
      ['malformed', 'unsupported'],
      ['partial', 'partial'],
      ['stale', 'ready'],
      ['hold', null],
    ]) {
      const workspace = join(directory, `skills-${variant}`);
      await mkdir(workspace);
      await seedNativeSkill(workspace);
      const target = (
        await host.request('create-session', {
          ...create(workspace),
          provider: 'Codex',
          model: 'fixture-codex',
        })
      ).session;
      nativeSkillSessions.set(variant, target);
      if (!expected) continue;
      const discovered = await host.request('discover-skills', {
        sessionId: target.id,
      });
      assert.equal(discovered.type, 'skills', JSON.stringify(discovered));
      assert.equal(discovered.catalog.method, 'library');
      assert.equal(discovered.catalog.status, 'partial');
      assert.equal(
        discovered.catalog.invocationSupported,
        expected === 'ready' || expected === 'partial',
      );
      nativeSkillCatalogs.set(variant, discovered.catalog);
      const blockedAlias = discovered.catalog.skills.find(
        skill => skill.name === 'Fixture blocked hooks',
      );
      assert.equal(blockedAlias.invocation, 'blocked');
      assert.deepEqual(blockedAlias.origins, ['Claude Code', 'Shared']);
      const blockedShared = discovered.catalog.skills.find(
        skill => skill.name === 'Fixture Shared context',
      );
      assert.equal(blockedShared.invocation, 'blocked');
      assert.deepEqual(blockedShared.origins, ['Shared']);
      if (expected === 'ready' || expected === 'partial') {
        assert.equal(
          discovered.catalog.skills.find(
            skill => skill.name === 'Fixture project skill',
          ).enabled,
          true,
        );
        assert.equal(
          discovered.catalog.skills.find(
            skill => skill.name === 'Fixture project skill',
          ).source,
          'project',
        );
        assert.equal(
          discovered.catalog.skills.find(
            skill => skill.name === 'Fixture user skill',
          ).enabled,
          false,
        );
        assert.equal(
          discovered.catalog.skills.find(
            skill => skill.name === 'Fixture user skill',
          ).source,
          'user',
        );
      }
      assert.deepEqual(
        (await host.request('list-sessions')).sessions.find(
          value => value.id === target.id,
        ),
        target,
      );
    }
    const traces = (await readFile(pidFile + '.skills', 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    assert.ok(traces.some(trace => trace.method === 'skills/list'));
    assert.ok(
      traces.every(
        trace =>
          !trace.methods.some(method =>
            /^(?:account|model|thread|turn)\//.test(method),
          ),
      ),
    );
    for (const [path, body] of metadata)
      assert.equal(await readFile(path, 'utf8'), body);
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
    const explorerRoot = join(directory, 'explorer-workspace');
    const explorerOutside = join(directory, 'explorer-outside');
    await mkdir(join(explorerRoot, 'notes', 'nested'), { recursive: true });
    await mkdir(join(explorerRoot, 'node_modules'));
    await mkdir(join(explorerRoot, 'many'));
    await mkdir(explorerOutside);
    const previewPath = join(explorerRoot, 'notes', 'nested', 'context.txt');
    const previewText = 'Current workspace preview\nUnicode: zażółć\n';
    await Promise.all([
      writeFile(previewPath, previewText),
      writeFile(join(explorerRoot, 'binary.dat'), Buffer.from([0, 1, 2, 255])),
      writeFile(join(explorerRoot, 'large.txt'), Buffer.alloc(262145, 97)),
      writeFile(join(explorerRoot, '.env.private'), 'private fixture'),
      writeFile(
        join(explorerRoot, 'node_modules', 'hidden.txt'),
        'generated fixture',
      ),
      writeFile(join(explorerOutside, 'outside.txt'), 'outside fixture'),
      ...Array.from({ length: 505 }, (_, index) =>
        writeFile(
          join(explorerRoot, 'many', `match-${index}.txt`),
          'bounded fixture',
        ),
      ),
    ]);
    await symlink(
      explorerOutside,
      join(explorerRoot, 'outside-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await symlink(
      join(explorerRoot, 'notes'),
      join(explorerRoot, 'inside-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const explorer = (
      await host.request('create-session', create(explorerRoot))
    ).session;
    const workspaceRequest = (method, path = '', rest = {}) =>
      host.request(method, {
        sessionId: explorer.id,
        path,
        ...rest,
      });
    const rootListing = await workspaceRequest('list-workspace-directory');
    assert.equal(rootListing.type, 'workspace-directory');
    assert.equal(rootListing.directory.path, '');
    assert.equal(rootListing.directory.truncated, false);
    assert.deepEqual(
      rootListing.directory.entries.map(entry => entry.path),
      ['many', 'notes', 'binary.dat', 'large.txt'],
    );
    const nestedListing = await workspaceRequest(
      'list-workspace-directory',
      'notes/nested',
    );
    assert.deepEqual(nestedListing.directory.entries, [
      {
        name: 'context.txt',
        path: 'notes/nested/context.txt',
        kind: 'file',
        size: Buffer.byteLength(previewText),
      },
    ]);
    const searched = await workspaceRequest('search-workspace-files', '', {
      query: 'CONTEXT',
    });
    assert.equal(searched.type, 'workspace-search');
    assert.deepEqual(
      searched.search.matches.map(entry => entry.path),
      ['notes/nested/context.txt'],
    );
    assert.equal(searched.search.truncated, false);
    const directoriesAreNotFiles = await workspaceRequest(
      'search-workspace-files',
      '',
      { query: 'many' },
    );
    assert.equal(
      directoriesAreNotFiles.search.matches.every(
        entry => entry.kind === 'file',
      ),
      true,
    );
    const preview = await workspaceRequest(
      'read-workspace-file',
      'notes/nested/context.txt',
    );
    assert.equal(preview.type, 'workspace-file');
    assert.equal(preview.file.status, 'text');
    assert.equal(preview.file.text, previewText);
    assert.equal(preview.file.truncated, false);
    assert.equal(
      (await workspaceRequest('read-workspace-file', 'binary.dat')).file.status,
      'binary',
    );
    const oversize = (
      await workspaceRequest('read-workspace-file', 'large.txt')
    ).file;
    assert.equal(oversize.status, 'too-large');
    assert.equal(oversize.text, null);
    assert.equal(oversize.truncated, true);
    const limitedList = (
      await workspaceRequest('list-workspace-directory', 'many')
    ).directory;
    assert.ok(limitedList.entries.length <= 500);
    if (limitedList.entries.length !== 500)
      assert.match(limitedList.detail, /exceeded its time limit/);
    assert.equal(limitedList.truncated, true);
    const limitedSearch = (
      await workspaceRequest('search-workspace-files', 'many', {
        query: 'match',
      })
    ).search;
    assert.ok(limitedSearch.matches.length <= 200);
    if (limitedSearch.matches.length !== 200)
      assert.match(limitedSearch.detail, /exceeded its time limit/);
    assert.equal(limitedSearch.truncated, true);
    const breadthRoot = join(explorerRoot, 'breadth');
    await mkdir(join(breadthRoot, 'a-deep', 'level'), { recursive: true });
    await mkdir(join(breadthRoot, 'z-source'));
    await Promise.all([
      writeFile(
        join(breadthRoot, 'z-source', 'expected.needle'),
        'source sibling',
      ),
      ...Array.from({ length: 205 }, (_, index) =>
        writeFile(
          join(breadthRoot, 'a-deep', 'level', `${index}.needle`),
          'deep fixture',
        ),
      ),
    ]);
    const breadthSearch = (
      await workspaceRequest('search-workspace-files', 'breadth', {
        query: '.needle',
      })
    ).search;
    assert.equal(breadthSearch.truncated, true);
    assert.ok(
      breadthSearch.matches.some(
        entry => entry.path === 'breadth/z-source/expected.needle',
      ),
    );
    for (const unsafe of [
      '../explorer-outside/outside.txt',
      'notes/../../outside.txt',
      'notes\\nested\\context.txt',
      '/outside.txt',
      'C:/outside.txt',
      'NUL.txt',
      'context.txt:stream',
      '.env.private',
      'node_modules/hidden.txt',
      'outside-link/outside.txt',
      'inside-link/nested/context.txt',
    ]) {
      const rejected = await workspaceRequest('read-workspace-file', unsafe);
      assert.equal(rejected.type, 'error', unsafe);
      assert.equal(rejected.code, 'invalid-request', unsafe);
    }
    for (const method of [
      'list-workspace-directory',
      'search-workspace-files',
    ]) {
      assert.equal(
        (
          await workspaceRequest(method, 'outside-link', {
            ...(method === 'search-workspace-files'
              ? { query: 'outside' }
              : {}),
          })
        ).code,
        'invalid-request',
      );
    }
    assert.equal(
      (await workspaceRequest('read-workspace-file', 'missing.txt')).code,
      'not-found',
    );
    assert.equal(
      (
        await workspaceRequest('list-workspace-directory', '', {
          sessionId: randomUUID(),
        })
      ).code,
      'not-found',
    );
    assert.equal(
      (
        await host.send(
          JSON.stringify({
            id: randomUUID(),
            method: 'read-workspace-file',
            input: {
              sessionId: explorer.id,
              path: 'context.txt',
              directory: explorerOutside,
            },
          }),
        )
      ).code,
      'invalid-request',
    );
    assert.equal(await readFile(previewPath, 'utf8'), previewText);
    assert.equal(
      await readFile(join(explorerOutside, 'outside.txt'), 'utf8'),
      'outside fixture',
    );
    const redirectedRoot = join(directory, 'explorer-redirect');
    await mkdir(redirectedRoot);
    const redirected = (
      await host.request('create-session', create(redirectedRoot))
    ).session;
    await rename(redirectedRoot, `${redirectedRoot}-original`);
    await symlink(
      explorerOutside,
      redirectedRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.equal(
      (
        await host.request('read-workspace-file', {
          sessionId: redirected.id,
          path: 'outside.txt',
        })
      ).code,
      'invalid-request',
    );
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
    assert.deepEqual(agent(completed).usage, claudeFixtureUsage);
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
    const beforeDuplicate = (await host.request('list-sessions')).sessions.find(
      value => value.id === session.id,
    );
    const duplicate = launch(directory, pidFile + '.duplicate');
    children.push(duplicate);
    assert.deepEqual(
      await bounded(
        duplicate.exited,
        'Duplicate profile host did not refuse startup',
      ),
      { code: 1, signal: null },
    );
    assert.match(
      duplicate.error(),
      /Another Nesvo host already owns this data directory\./,
    );
    assert.deepEqual(
      (await host.request('list-sessions')).sessions.find(
        value => value.id === session.id,
      ),
      beforeDuplicate,
    );
    assert.equal((await host.request('health')).health.instanceId, instanceId);
    const concurrentSearch = workspaceRequest('search-workspace-files', '', {
      query: 'not-present',
    });
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
        await bounded(
          host.request('stop-run', {
            sessionId: session.id,
            runId: held.started.runId,
          }),
          'Workspace search blocked Stop',
          2000,
        )
      ).session.status,
      'stopping',
    );
    assert.equal((await concurrentSearch).type, 'workspace-search');
    const stopped = await host.event(
      value => value.runId === held.started.runId && value.status === 'stopped',
    );
    assert.equal(agent(stopped).state, 'stopped');
    assert.equal(stopped.interruption ?? null, null);
    assert.equal(agent(stopped).interruption ?? null, null);
    assert.equal(agent(stopped).body, 'Fixture is waiting.');
    assert.ok(agent(stopped).completedAt);
    assert.equal(
      stopped.activities.find(item => item.runId === held.started.runId).status,
      'stopped',
    );
    await processesGone(held.pids, ownedPids);
    if (process.platform === 'linux') {
      const exiting = (await host.request('create-session', create(workspace)))
        .session;
      const exitingRun = (
        await host.request('send-message', {
          sessionId: exiting.id,
          messageId: randomUUID(),
          text: 'fixture:hold-exit',
        })
      ).session;
      assertInterruption(
        await host.event(
          value =>
            value.runId === exitingRun.runId && value.status === 'interrupted',
        ),
        'provider-disconnected',
      );
      const exitingPids = JSON.parse(await readFile(pidFile, 'utf8'));
      ownedPids.add(exitingPids.pid).add(exitingPids.childPid);
      await processesGone([exitingPids.pid, exitingPids.childPid], ownedPids);
    }
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
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 8);
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
    assert.deepEqual(agent(resumed).usage, unreportedUsage);
    assert.equal(resumed.messages[0].usage, null);
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
    assertInterruption(recoveredSession, 'host-restart');
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
    assert.deepEqual(
      recoveredSession.messages.find(
        message =>
          message.runId === running.runId && message.author === 'agent',
      ).usage,
      claudeFixtureUsage,
    );
    assert.deepEqual(
      recoveredSession.messages.find(
        message => message.id === agent(resumed).id,
      ).usage,
      unreportedUsage,
    );
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
    for (const provider of providers) {
      const response = await finalHost.request('provider-usage', { provider });
      assert.equal(response.type, 'provider-usage');
      assert.equal(
        response.usage.status,
        'unavailable',
        JSON.stringify(response),
      );
      assert.deepEqual(response.usage.windows, []);
      assert.ok(response.usage.account);
      assert.ok(response.usage.detail);
    }
    const unavailableProbes = (await readUsageTrace()).slice(
      usageProbes.length,
    );
    assert.equal(unavailableProbes.length, 2);
    for (const trace of unavailableProbes) ownedPids.add(trace.pid);
    await processesGone(
      unavailableProbes.map(trace => trace.pid),
      ownedPids,
    );
    const finalSession = (
      await finalHost.request('list-sessions')
    ).sessions.find(value => value.id === session.id);
    assertInterruption(finalSession, 'host-shutdown');
    assert.equal(finalSession.runId, shutdownRun.started.runId);
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
    assert.deepEqual(codexStatus.status.effort, { status: 'per-model' });
    const codexModel = id =>
      codexStatus.status.models.find(model => model.id === id);
    assert.equal(codexModel('default').efforts, null);
    assert.deepEqual(codexModel('fixture-codex').efforts, {
      options: [
        { id: 'low', description: 'Fixture low effort' },
        { id: 'medium', description: 'Fixture medium effort' },
        { id: 'high', description: 'Fixture high effort' },
      ],
      defaultEffort: 'medium',
    });
    for (const input of [
      { ...create(''), effort: 'high' },
      { ...create(''), provider: 'Codex', model: 'default', effort: 'high' },
      { ...create(''), provider: 'Codex', model: 'fixture-codex', effort: '' },
      {
        ...create(''),
        provider: 'Codex',
        model: 'fixture-codex',
        effort: 'High!',
      },
    ])
      assert.deepEqual(
        await finalHost.send(
          JSON.stringify({
            id: randomUUID(),
            method: 'create-session',
            input,
          }),
        ),
        { type: 'error', id: null, code: 'invalid-request' },
        JSON.stringify(input),
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
    const sendCodex = async (currentHost, target, text, skillId, skillHash) => {
      const response = await currentHost.request('send-message', {
        sessionId: target.id,
        messageId: randomUUID(),
        text,
        ...(skillId ? { skillId } : {}),
        ...(skillHash ? { skillHash } : {}),
      });
      assert.equal(response.type, 'session', JSON.stringify(response));
      return response.session;
    };
    const effortSession = await finalHost.request('create-session', {
      ...create(''),
      provider: 'Codex',
      model: 'fixture-codex',
      mode: 'read-only',
      effort: 'high',
    });
    assert.equal(effortSession.session.effort, 'high');
    const sessionsBeforeUnsupportedEffort = (
      await finalHost.request('list-sessions')
    ).sessions.length;
    const unsupportedEffort = await finalHost.request('create-session', {
      ...create(''),
      provider: 'Codex',
      model: 'fixture-codex',
      effort: 'max',
    });
    assert.equal(unsupportedEffort.code, 'invalid-request');
    assert.match(unsupportedEffort.message, /max reasoning effort/);
    assert.equal(
      (await finalHost.request('list-sessions')).sessions.length,
      sessionsBeforeUnsupportedEffort,
    );
    assert.equal((await createCodex('read-only')).effort, null);
    let effortTarget = effortSession.session;
    for (const text of ['Reason carefully.', 'Continue carefully.']) {
      const run = await sendCodex(finalHost, effortTarget, text);
      effortTarget = await finalHost.event(
        value => value.runId === run.runId && value.status === 'completed',
      );
    }
    assert.equal(effortTarget.effort, 'high');
    assert.deepEqual(
      (await readFile(pidFile + '.turns', 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
        .filter(turn => turn.sessionId === effortTarget.providerSessionId)
        .map(turn => [turn.prompt, turn.effort]),
      [
        ['Reason carefully.', 'high'],
        ['Continue carefully.', 'high'],
      ],
    );
    await writeFile(
      pidFile + '.catalog',
      JSON.stringify({ efforts: ['low', 'medium'] }),
    );
    const withdrawnRun = await sendCodex(
      finalHost,
      effortTarget,
      'Withdrawn effort.',
    );
    const withdrawn = await finalHost.event(
      value => value.runId === withdrawnRun.runId && value.status === 'failed',
    );
    assert.match(
      withdrawn.error,
      /does not report the high reasoning effort.*No provider turn was started/,
    );
    await rm(pidFile + '.catalog');
    assert.equal(
      (await readFile(pidFile + '.turns', 'utf8')).includes(
        'Withdrawn effort.',
      ),
      false,
    );
    const disconnectedTarget = await createCodex('read-only');
    const disconnectedRun = await sendCodex(
      finalHost,
      disconnectedTarget,
      'fixture:disconnect',
    );
    const disconnected = await finalHost.event(
      value =>
        value.runId === disconnectedRun.runId && value.status === 'interrupted',
    );
    assertInterruption(disconnected, 'provider-disconnected');
    assert.equal(agent(disconnected).body, 'Codex fixture disconnected.');
    assert.deepEqual(disconnected.pendingApprovals, []);
    assert.equal(
      (await finalHost.request('list-reviews')).reviews.some(
        value => value.runId === disconnected.runId,
      ),
      false,
    );
    await delay(100);
    assert.deepEqual(
      (await finalHost.request('list-sessions')).sessions.find(
        value => value.id === disconnected.id,
      ),
      disconnected,
    );
    if (process.platform === 'linux') {
      const orphanRun = await sendCodex(
        finalHost,
        await createCodex('read-only'),
        'fixture:hold-disconnect',
      );
      const orphaned = await finalHost.event(
        value =>
          value.runId === orphanRun.runId && value.status === 'interrupted',
      );
      assertInterruption(orphaned, 'provider-disconnected');
      const orphanPids = JSON.parse(await readFile(pidFile + '.codex', 'utf8'));
      assert.equal(orphanPids.sessionId, orphaned.providerSessionId);
      ownedPids.add(orphanPids.pid).add(orphanPids.childPid);
      await processesGone([orphanPids.pid, orphanPids.childPid], ownedPids);
    }
    const explicitResume = await sendCodex(
      finalHost,
      disconnected,
      'fixture:continue',
    );
    const afterDisconnect = await finalHost.event(
      value =>
        value.runId === explicitResume.runId && value.status === 'completed',
    );
    assert.equal(
      afterDisconnect.providerSessionId,
      disconnected.providerSessionId,
    );
    assert.equal(
      afterDisconnect.messages.length,
      disconnected.messages.length + 2,
    );
    assert.equal(afterDisconnect.interruption ?? null, null);
    assert.deepEqual(
      afterDisconnect.messages.find(
        message => message.id === agent(disconnected).id,
      ).interruption,
      disconnected.interruption,
    );
    const readOnly = await createCodex('read-only');
    await seedNativeSkill(readOnly.directory);
    const selectedCatalog = await finalHost.request('discover-skills', {
      sessionId: readOnly.id,
    });
    const selectedSkill = selectedCatalog.catalog.skills.find(
      skill => skill.name === 'Fixture Claude instructions',
    );
    const selectedReference = {
      id: selectedSkill.id,
      name: selectedSkill.name,
      path: selectedSkill.path,
      source: selectedSkill.source,
      origins: selectedSkill.origins,
      delivery: 'native',
      contentHash: selectedSkill.contentHash,
    };
    const selectedInput = {
      sessionId: readOnly.id,
      messageId: randomUUID(),
      text: 'fixture:stream',
      skillId: selectedSkill.id,
      skillHash: selectedSkill.contentHash,
    };
    const selectedResponse = await finalHost.request(
      'send-message',
      selectedInput,
    );
    assert.equal(
      selectedResponse.type,
      'session',
      JSON.stringify(selectedResponse),
    );
    const codexRun = selectedResponse.session;
    assert.equal(
      (await finalHost.request('send-message', selectedInput)).session.runId,
      codexRun.runId,
    );
    for (const skillId of [undefined, 'unknown-skill-id']) {
      const input = { ...selectedInput };
      if (skillId === undefined) delete input.skillId;
      else input.skillId = skillId;
      assert.equal(
        (await finalHost.request('send-message', input)).code,
        'invalid-request',
      );
    }
    for (const skillHash of [undefined, '0'.repeat(64)]) {
      const input = { ...selectedInput };
      if (skillHash === undefined) delete input.skillHash;
      else input.skillHash = skillHash;
      assert.equal(
        (await finalHost.request('send-message', input)).code,
        'invalid-request',
      );
    }
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
    assert.deepEqual(agent(codexCompleted).usage, codexFixtureUsage);
    assert.equal(codexCompleted.actualModel, 'fixture-codex');
    assert.ok(codexCompleted.providerSessionId);
    assert.deepEqual(
      codexCompleted.messages.find(
        message => message.id === selectedInput.messageId,
      ).skill,
      selectedReference,
    );
    assert.ok(
      finalHost.observed.some(
        value =>
          value.runId === codexRun.runId &&
          value.status === 'running' &&
          value.messages.some(
            message =>
              message.id === selectedInput.messageId &&
              message.skill?.id === selectedSkill.id,
          ),
      ),
    );
    const invocationTrace = (await readFile(pidFile + '.skills', 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const selectedTurn = invocationTrace.find(
      trace =>
        trace.directory === readOnly.directory && trace.method === 'turn/start',
    );
    assert.deepEqual(selectedTurn.input, [
      { type: 'text', text: selectedInput.text, text_elements: [] },
      { type: 'skill', name: selectedSkill.name, path: selectedSkill.path },
    ]);
    assert.ok(
      invocationTrace.some(
        trace =>
          trace.pid === selectedTurn.pid &&
          trace.extraRoots?.includes(join(selectedSkill.path, '..')),
      ),
    );
    assert.equal(
      invocationTrace.filter(
        trace =>
          trace.directory === readOnly.directory &&
          trace.method === 'turn/start',
      ).length,
      1,
    );
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
    const portableSkill = claudeInventory.catalog.skills.find(
      skill => skill.name === 'Fixture Codex instructions',
    );
    assert.equal(portableSkill.invocation, 'instructions');
    const portableInput = {
      sessionId: inventorySession.id,
      messageId: randomUUID(),
      text: 'fixture:shared',
      skillId: portableSkill.id,
      skillHash: portableSkill.contentHash,
    };
    const portableRun = await finalHost.request('send-message', portableInput);
    assert.equal(portableRun.type, 'session', JSON.stringify(portableRun));
    const portableCompleted = await finalHost.event(
      value =>
        value.runId === portableRun.session.runId &&
        value.status === 'completed',
    );
    assert.equal(agent(portableCompleted).body, 'Fixture initial reply.');
    assert.equal(
      portableCompleted.messages.at(-2).skill.delivery,
      'instructions',
    );
    assert.deepEqual(portableCompleted.messages.at(-2).skill.origins, [
      'Codex',
    ]);
    assert.equal(
      portableCompleted.messages.at(-2).skill.contentHash,
      portableSkill.contentHash,
    );
    const portableTrace = JSON.parse(
      (await readFile(pidFile + '.shared', 'utf8')).trim(),
    );
    assert.equal(portableTrace.path, portableSkill.path);
    assert.equal(portableTrace.hash, portableSkill.contentHash);
    assert.match(portableTrace.instructions, /FIXTURE_CODEX_SHARED_MARKER/);
    assert.equal(
      (await finalHost.request('send-message', portableInput)).session.runId,
      portableCompleted.runId,
    );
    assert.equal(
      (
        await finalHost.request('send-message', {
          sessionId: inventorySession.id,
          messageId: randomUUID(),
          text: 'fixture:shared',
          skillHash: portableSkill.contentHash,
        })
      ).code,
      'invalid-request',
    );
    const forgedInput = {
      sessionId: readOnly.id,
      messageId: randomUUID(),
      text: 'fixture:stream',
      skillId: selectedSkill.id,
      skillHash: selectedSkill.contentHash,
      skill: {
        ...selectedReference,
        path: join(directory, 'forged', 'SKILL.md'),
      },
    };
    assert.deepEqual(
      await finalHost.send(
        JSON.stringify({
          id: randomUUID(),
          method: 'send-message',
          input: forgedInput,
        }),
      ),
      { type: 'error', id: null, code: 'invalid-request' },
    );
    assert.deepEqual(
      await finalHost.send(
        JSON.stringify({
          id: randomUUID(),
          method: 'send-message',
          input: {
            ...selectedInput,
            messageId: randomUUID(),
            skillBody: 'Injected instructions',
          },
        }),
      ),
      { type: 'error', id: null, code: 'invalid-request' },
    );
    await writeFile(
      join(pidFile + '.state', 'skills-stale.disabled'),
      'disabled',
    );
    const originalSharedSource = await readFile(selectedSkill.path, 'utf8');
    await writeFile(
      selectedSkill.path,
      originalSharedSource + '\nChanged source after selection.\n',
    );
    for (const [variant, skillId, skillHash] of [
      [
        'codex',
        nativeSkillCatalogs
          .get('codex')
          .skills.find(skill => skill.enabled === false).id,
      ],
      ['codex', 'unknown-skill-id'],
      ['codex', selectedSkill.id, '0'.repeat(64)],
      ['codex', selectedSkill.id, selectedSkill.contentHash],
      [
        'codex',
        claudeInventory.catalog.skills.find(
          skill => skill.name === 'Fixture blocked hooks',
        ).id,
        claudeInventory.catalog.skills.find(
          skill => skill.name === 'Fixture blocked hooks',
        ).contentHash,
      ],
      ['codex', userSkill.id, userSkill.contentHash],
      [
        'codex',
        claudeInventory.catalog.skills.find(
          skill => skill.name === 'Fixture Shared context',
        ).id,
        claudeInventory.catalog.skills.find(
          skill => skill.name === 'Fixture Shared context',
        ).contentHash,
      ],
      ['unsupported', selectedSkill.id],
      ['malformed', selectedSkill.id],
      [
        'stale',
        nativeSkillCatalogs
          .get('stale')
          .skills.find(skill => skill.name === 'Fixture project skill').id,
        nativeSkillCatalogs
          .get('stale')
          .skills.find(skill => skill.name === 'Fixture project skill')
          .contentHash,
      ],
    ]) {
      const target = nativeSkillSessions.get(variant);
      const run = await sendCodex(
        finalHost,
        target,
        'fixture:stream',
        skillId,
        skillHash,
      );
      const failed = await finalHost.event(
        value => value.runId === run.runId && value.status === 'failed',
      );
      assert.equal(failed.providerSessionId, null);
      assert.equal(failed.providerInitialized, false);
      assert.equal(failed.messages.at(-2).skillId, skillId);
      assert.equal(failed.messages.at(-2).skill, undefined);
      assert.equal(agent(failed).body, '');
      assert.equal(
        finalHost.observedReviews.some(review => review.runId === run.runId),
        false,
      );
      const rejectedTraces = (await readFile(pidFile + '.skills', 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
        .filter(trace => trace.directory === target.directory);
      assert.ok(rejectedTraces.some(trace => trace.method === 'skills/list'));
      assert.equal(
        rejectedTraces.some(trace => /^(?:thread|turn)\//.test(trace.method)),
        false,
      );
    }
    await writeFile(selectedSkill.path, originalSharedSource);
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
    let discoveryFinished = false;
    const slowDiscovery = finalHost
      .request('discover-skills', {
        sessionId: nativeSkillSessions.get('hold').id,
      })
      .then(response => {
        discoveryFinished = true;
        return response;
      });
    assert.equal((await finalHost.request('health')).health.status, 'ready');
    assert.equal(discoveryFinished, false);
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
    const slowCatalog = await slowDiscovery;
    assert.equal(slowCatalog.type, 'skills', JSON.stringify(slowCatalog));
    assert.equal(slowCatalog.catalog.method, 'library');
    assert.equal(slowCatalog.catalog.status, 'partial');
    assert.equal(
      (await finalHost.request('list-sessions')).sessions.find(
        value => value.id === supervised.id,
      ).status,
      'stopped',
    );
    const beforeSkillStop = (await readSkillTraces()).length;
    const skillStopTarget = nativeSkillSessions.get('hold');
    const stoppedSelection = await sendCodex(
      finalHost,
      skillStopTarget,
      'fixture:stream',
      'pending-skill-id',
    );
    let resolvingSkill;
    const skillDeadline = Date.now() + 5000;
    while (!resolvingSkill && Date.now() < skillDeadline) {
      resolvingSkill = (await readSkillTraces())
        .slice(beforeSkillStop)
        .find(trace => trace.method === 'skills/list');
      if (!resolvingSkill) await delay(30);
    }
    assert.ok(resolvingSkill, 'Selected skill must reach native revalidation');
    ownedPids.add(resolvingSkill.pid);
    assert.equal((await finalHost.request('health')).health.status, 'ready');
    await finalHost.request('stop-run', {
      sessionId: skillStopTarget.id,
      runId: stoppedSelection.runId,
    });
    const cancelledSkill = await finalHost.event(
      value =>
        value.runId === stoppedSelection.runId && value.status === 'stopped',
    );
    await processesGone([resolvingSkill.pid], ownedPids);
    assert.equal(cancelledSkill.providerSessionId, null);
    assert.equal(cancelledSkill.messages.at(-2).skill, undefined);
    assert.equal(
      (await readSkillTraces())
        .filter(trace => trace.pid === resolvingSkill.pid)
        .some(trace => /^(?:thread|turn)\//.test(trace.method)),
      false,
    );
    await delay(100);
    assert.equal(
      (await finalHost.request('list-sessions')).sessions.find(
        value => value.id === skillStopTarget.id,
      ).status,
      'stopped',
    );
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
    assertInterruption(recoveredActivities, 'host-restart');
    assert.equal(recoveredActivities.activities[0].status, 'completed');
    assert.equal(recoveredActivities.activities[1].status, 'interrupted');
    assert.equal(
      recoveredActivities.activities[1].id,
      codexCompleted.activities[1].id,
    );
    assert.ok(recoveredActivities.activities[1].completedAt);
    assert.deepEqual(
      recoveredActivities.messages.find(
        message => message.id === selectedInput.messageId,
      ).skill,
      selectedReference,
    );
    const restoredPortable = (
      await codexReopened.request('list-sessions')
    ).sessions.find(value => value.id === inventorySession.id);
    assert.deepEqual(
      restoredPortable.messages.at(-2).skill,
      portableCompleted.messages.at(-2).skill,
    );
    const portableResume = await codexReopened.request('send-message', {
      ...portableInput,
      messageId: randomUUID(),
      text: 'fixture:shared-resume',
    });
    const portableResumed = await codexReopened.event(
      value =>
        value.runId === portableResume.session.runId &&
        value.status === 'completed',
    );
    assert.equal(agent(portableResumed).body, 'Fixture resumed reply.');
    assert.equal(
      portableResumed.providerSessionId,
      portableCompleted.providerSessionId,
    );
    const resumedTrace = (await readFile(pidFile + '.shared', 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
      .at(-1);
    assert.equal(resumedTrace.resumed, true);
    assert.equal(resumedTrace.hash, portableSkill.contentHash);
    const nativeContinuation = await sendCodex(
      codexReopened,
      readOnly,
      'fixture:continue',
      selectedSkill.id,
      selectedSkill.contentHash,
    );
    const nativeResumed = await codexReopened.event(
      value =>
        value.runId === nativeContinuation.runId &&
        value.status === 'completed',
    );
    assert.equal(agent(nativeResumed).body, 'Codex fixture resumed reply.');
    assert.deepEqual(nativeResumed.messages.at(-2).skill, selectedReference);
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
    assertInterruption(shutdownSession, 'host-shutdown');
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
    assertInterruption(persistedRoot, 'host-shutdown');
    assert.equal(persistedRoot.runId, closingPlan.run.runId);
    assert.equal(persistedRoot.delegationEnabled, true);
    for (const worker of closingWorkers) {
      const restoredWorker = persistedGroup.find(
        value => value.id === worker.child.id,
      );
      assertInterruption(restoredWorker, 'host-shutdown');
      for (const key of [
        'id',
        'runId',
        'providerSessionId',
        'parentId',
        'parentRunId',
        'scope',
        'directory',
      ])
        assert.equal(restoredWorker[key], worker.child[key]);
      const proposal = persistedRoot.delegations.find(
        value => value.childSessionId === restoredWorker.id,
      );
      assert.equal(proposal.runId, closingPlan.run.runId);
      assert.equal(proposal.status, 'interrupted');
    }
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
    const beforeRestartSessions = (await afterGroup.request('list-sessions'))
      .sessions;
    const beforeRestartReviews = (await afterGroup.request('list-reviews'))
      .reviews;
    assert.ok(beforeRestartReviews.some(value => value.status === 'pending'));
    const providerState = async () =>
      Promise.all(
        (await readdir(pidFile + '.state'))
          .sort()
          .map(async name => [
            name,
            await readFile(join(pidFile + '.state', name), 'utf8'),
          ]),
      );
    const beforeRestartProviderState = await providerState();
    await afterGroup.stop();
    const reviewsReopened = open();
    const restoredReviews = (await reviewsReopened.request('list-reviews'))
      .reviews;
    assert.deepEqual(byId(restoredReviews), byId(beforeRestartReviews));
    assert.deepEqual(
      byId((await reviewsReopened.request('list-sessions')).sessions),
      byId(beforeRestartSessions),
    );
    assert.deepEqual(
      (await reviewsReopened.request('decide-review', acceptCorrected)).review,
      acceptedFiles.review,
    );
    assert.deepEqual(
      (await reviewsReopened.request('decide-review', correctionInput)).review,
      beforeRestartReviews.find(value => value.id === initialReview.id),
    );
    await delay(150);
    assert.deepEqual(
      byId((await reviewsReopened.request('list-reviews')).reviews),
      byId(beforeRestartReviews),
    );
    assert.deepEqual(
      byId((await reviewsReopened.request('list-sessions')).sessions),
      byId(beforeRestartSessions),
    );
    assert.deepEqual(await providerState(), beforeRestartProviderState);
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
    const lostClient = await codexHold(reviewsReopened);
    reviewsReopened.child.stdin.end();
    assert.deepEqual(
      await bounded(
        reviewsReopened.exited,
        'Host did not close after client EOF',
      ),
      { code: 0, signal: null },
    );
    await processesGone(lostClient.pids, ownedPids);
    const afterClientLoss = open();
    const recoveredClient = (
      await afterClientLoss.request('list-sessions')
    ).sessions.find(value => value.id === supervised.id);
    assertInterruption(recoveredClient, 'host-shutdown');
    assert.equal(recoveredClient.runId, lostClient.run.runId);
    assert.deepEqual(recoveredClient.pendingApprovals, []);
    assert.equal(
      (
        await afterClientLoss.request(
          'respond-approval',
          decision(lostClient, 'accept'),
        )
      ).code,
      'invalid-request',
    );
    const unfinishedParent = (
      await afterClientLoss.request('create-session', {
        ...create(''),
        provider: 'Codex',
        model: 'fixture-codex',
        mode: 'read-only',
      })
    ).session;
    const unfinishedRun = await sendCodex(
      afterClientLoss,
      unfinishedParent,
      'fixture:delegate',
    );
    const unfinishedPlan = await afterClientLoss.event(
      value =>
        value.id === unfinishedParent.id &&
        value.delegations.filter(
          proposal => proposal.runId === unfinishedRun.runId,
        ).length === 2,
    );
    const approvedProposal = unfinishedPlan.delegations.find(
      proposal =>
        proposal.runId === unfinishedRun.runId &&
        proposal.title === 'Fixture worker A',
    );
    await afterClientLoss.request('decide-delegation', {
      sessionId: unfinishedParent.id,
      runId: unfinishedRun.runId,
      delegationId: approvedProposal.id,
      decision: 'accept',
    });
    const durableChild = await afterClientLoss.event(
      value =>
        value.parentId === unfinishedParent.id &&
        value.parentRunId === unfinishedRun.runId &&
        value.status === 'completed',
    );
    const durableChildReview = await afterClientLoss.review(
      value =>
        value.sessionId === durableChild.id &&
        value.runId === durableChild.runId &&
        value.status === 'pending',
    );
    const crashSnapshot = (
      await afterClientLoss.request('list-sessions')
    ).sessions.find(value => value.id === unfinishedParent.id);
    assert.equal(crashSnapshot.status, 'running');
    assert.equal(
      crashSnapshot.delegations.find(
        proposal => proposal.id === approvedProposal.id,
      ).childRunId,
      durableChild.runId,
    );
    assert.equal(
      (await afterClientLoss.request('list-reviews')).reviews.some(
        review => review.sessionId === unfinishedParent.id,
      ),
      false,
    );
    await afterClientLoss.stop();
    crashSnapshot.delegations.find(
      proposal => proposal.id === approvedProposal.id,
    ).status = 'running';
    const crashDatabase = new DatabaseSync(path);
    try {
      crashDatabase
        .prepare('UPDATE sessions SET document = ? WHERE id = ?')
        .run(JSON.stringify(crashSnapshot), unfinishedParent.id);
    } finally {
      crashDatabase.close();
    }
    const stateBeforeRecovery = await providerState();
    const afterParentCrash = open();
    const crashRecovered = (
      await afterParentCrash.request('list-sessions')
    ).sessions.find(value => value.id === unfinishedParent.id);
    assertInterruption(crashRecovered, 'host-restart');
    const recoveredProposal = crashRecovered.delegations.find(
      proposal => proposal.id === approvedProposal.id,
    );
    assert.equal(recoveredProposal.status, 'completed');
    assert.equal(recoveredProposal.childSessionId, durableChild.id);
    assert.equal(recoveredProposal.childRunId, durableChild.runId);
    assert.equal(
      crashRecovered.delegations.find(
        proposal => proposal.id !== approvedProposal.id,
      ).status,
      'interrupted',
    );
    assert.deepEqual(
      (await afterParentCrash.request('list-sessions')).sessions.find(
        value => value.id === durableChild.id,
      ),
      durableChild,
    );
    assert.equal(
      (await afterParentCrash.request('list-reviews')).reviews.some(
        review => review.sessionId === unfinishedParent.id,
      ),
      false,
    );
    await delay(100);
    assert.deepEqual(await providerState(), stateBeforeRecovery);
    const resumedParentRun = await sendCodex(
      afterParentCrash,
      crashRecovered,
      'fixture:continue',
    );
    const resumedParentReview = await afterParentCrash.review(
      review =>
        review.runId === resumedParentRun.runId && review.status === 'pending',
    );
    assert.deepEqual(resumedParentReview.dependencies, [
      {
        sessionId: durableChild.id,
        reviewId: durableChildReview.id,
        version: durableChildReview.version,
      },
    ]);
    const nextWriteDirectory = join(unfinishedParent.directory, 'write-worker');
    await mkdir(nextWriteDirectory);
    await mkdir(join(unfinishedParent.directory, 'read-worker'));
    await writeFile(
      join(nextWriteDirectory, 'tracked.txt'),
      'new worker baseline\n',
    );
    await writeFile(
      join(nextWriteDirectory, 'deleted.txt'),
      'remove this worker baseline\n',
    );
    const newerRun = await sendCodex(
      afterParentCrash,
      crashRecovered,
      'fixture:delegate-writable-pending',
    );
    const newerPlan = await afterParentCrash.event(
      session =>
        session.id === unfinishedParent.id &&
        session.delegations.filter(
          proposal => proposal.runId === newerRun.runId,
        ).length === 2,
    );
    const writeProposal = newerPlan.delegations.find(
      proposal =>
        proposal.runId === newerRun.runId && proposal.mode === 'supervised',
    );
    await afterParentCrash.request('decide-delegation', {
      sessionId: unfinishedParent.id,
      runId: newerRun.runId,
      delegationId: writeProposal.id,
      decision: 'accept',
    });
    const newerChild = await afterParentCrash.event(
      session =>
        session.parentId === unfinishedParent.id &&
        session.parentRunId === newerRun.runId &&
        session.status === 'completed',
    );
    const newerChildReview = await afterParentCrash.review(
      review =>
        review.runId === newerChild.runId && review.status === 'pending',
    );
    assert.equal(newerChildReview.diff.status, 'complete');
    const newerSnapshot = (
      await afterParentCrash.request('list-sessions')
    ).sessions.find(session => session.id === unfinishedParent.id);
    assert.equal(newerSnapshot.status, 'running');
    assert.equal(
      (await afterParentCrash.request('list-reviews')).reviews.some(
        review => review.runId === newerRun.runId,
      ),
      false,
    );
    await afterParentCrash.stop();
    newerSnapshot.delegations.find(
      proposal => proposal.id === writeProposal.id,
    ).status = 'running';
    const newerCrashDatabase = new DatabaseSync(path);
    try {
      newerCrashDatabase
        .prepare('UPDATE sessions SET document = ? WHERE id = ?')
        .run(JSON.stringify(newerSnapshot), unfinishedParent.id);
    } finally {
      newerCrashDatabase.close();
    }
    const afterNewerCrash = open();
    const newerRecovered = (
      await afterNewerCrash.request('list-sessions')
    ).sessions.find(session => session.id === unfinishedParent.id);
    assertInterruption(newerRecovered, 'host-restart');
    assert.equal(
      newerRecovered.delegations.find(
        proposal => proposal.id === writeProposal.id,
      ).childRunId,
      newerChild.runId,
    );
    assert.equal(
      newerRecovered.delegations.find(
        proposal => proposal.id === writeProposal.id,
      ).status,
      'completed',
    );
    const latestResume = await sendCodex(
      afterNewerCrash,
      newerRecovered,
      'fixture:continue',
    );
    const latestParentReview = await afterNewerCrash.review(
      review =>
        review.runId === latestResume.runId && review.status === 'pending',
    );
    assert.deepEqual(latestParentReview.dependencies, [
      {
        sessionId: newerChild.id,
        reviewId: newerChildReview.id,
        version: newerChildReview.version,
      },
    ]);
    const latestPrompt = (await readFile(pidFile + '.turns', 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
      .filter(turn => turn.sessionId === newerRecovered.providerSessionId)
      .at(-1).prompt;
    assert.ok(latestPrompt.includes(newerChild.id));
    assert.equal(latestPrompt.includes(durableChild.id), false);
    const latestDecision = {
      reviewId: latestParentReview.id,
      version: latestParentReview.version,
      decisionId: randomUUID(),
      decision: 'accept',
      feedback: '',
    };
    await writeFile(
      join(nextWriteDirectory, 'tracked.txt'),
      'external edit to latest worker result\n',
    );
    assert.equal(
      (await afterNewerCrash.request('decide-review', latestDecision)).code,
      'invalid-request',
    );
    await writeFile(
      join(nextWriteDirectory, 'tracked.txt'),
      'initial agent text\n',
    );
    const acceptedLatest = await afterNewerCrash.request('decide-review', {
      ...latestDecision,
      decisionId: randomUUID(),
    });
    assert.equal(acceptedLatest.type, 'review', JSON.stringify(acceptedLatest));
    assert.equal(acceptedLatest.review.status, 'accepted');
    await afterNewerCrash.stop();
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

const loadScheduledJobContracts = async directory => {
  const outfile = join(directory, 'contracts.mjs');
  await promisify(execFile)('bun', [
    'build',
    fileURLToPath(
      new URL('../../../packages/contracts/src/index.ts', import.meta.url),
    ),
    '--target=node',
    '--format=esm',
    `--outfile=${outfile}`,
  ]);
  return import(pathToFileURL(outfile).href);
};

test('scheduled job contracts compute time-zone aware schedules and bounds', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nesvo-scheduled-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contracts = await loadScheduledJobContracts(directory);
  const {
    ScheduleError,
    assertValidSchedule,
    collapseMissed,
    describeSchedule,
    nextOccurrence,
    previewOccurrences,
    saveScheduledJobSchema,
    scheduledJobRunSchema,
    scheduledJobSchema,
    scheduledJobScheduleSchema,
    scheduledJobSessionOriginSchema,
  } = contracts;
  const at = value => new Date(value);
  const next = (schedule, after, timeZone = 'UTC') =>
    nextOccurrence(schedule, at(after), timeZone).toISOString();

  await t.test('daily fires later the same day', () => {
    assert.equal(
      next({ kind: 'daily', time: '09:00' }, '2026-11-10T08:00:00Z'),
      '2026-11-10T09:00:00.000Z',
    );
  });

  await t.test('daily at the exact time moves to the next day', () => {
    assert.equal(
      next({ kind: 'daily', time: '09:00' }, '2026-11-10T09:00:00Z'),
      '2026-11-11T09:00:00.000Z',
    );
  });

  await t.test('weekdays skips the weekend', () => {
    assert.equal(
      next({ kind: 'weekdays', time: '09:00' }, '2026-11-13T10:00:00Z'),
      '2026-11-16T09:00:00.000Z',
    );
  });

  await t.test('weekly lands on the chosen weekday', () => {
    assert.equal(
      next(
        { kind: 'weekly', weekday: 1, time: '07:30' },
        '2026-11-10T12:00:00Z',
      ),
      '2026-11-16T07:30:00.000Z',
    );
  });

  await t.test('interval steps from its anchor', () => {
    const schedule = {
      kind: 'interval',
      minutes: 30,
      anchorAt: '2026-11-10T09:00:00.000Z',
    };
    assert.equal(
      next(schedule, '2026-11-10T08:00:00Z'),
      '2026-11-10T09:00:00.000Z',
    );
    assert.equal(
      next(schedule, '2026-11-10T09:20:00Z'),
      '2026-11-10T09:30:00.000Z',
    );
    assert.equal(
      next(schedule, '2026-11-10T09:30:00Z'),
      '2026-11-10T10:00:00.000Z',
    );
  });

  await t.test('a week of missed occurrences collapses into one run', () => {
    const result = collapseMissed(
      { kind: 'daily', time: '09:00' },
      at('2026-11-03T09:00:00Z'),
      at('2026-11-10T12:00:00Z'),
      'UTC',
    );
    assert.equal(result.scheduledFor.toISOString(), '2026-11-10T09:00:00.000Z');
    assert.equal(result.nextRunAt.toISOString(), '2026-11-11T09:00:00.000Z');
    assert.equal(result.skipped, 7);
    const none = collapseMissed(
      { kind: 'daily', time: '09:00' },
      at('2026-11-10T09:00:00Z'),
      at('2026-11-10T12:00:00Z'),
      'UTC',
    );
    assert.equal(none.skipped, 0);
    assert.equal(none.scheduledFor.toISOString(), '2026-11-10T09:00:00.000Z');
  });

  await t.test('invalid schedules are rejected with a typed error', () => {
    const invalid = [
      { kind: 'daily', time: '25:00' },
      { kind: 'daily', time: '9:00' },
      { kind: 'weekly', weekday: 9, time: '09:00' },
      { kind: 'weekly', time: '09:00' },
      { kind: 'cron' },
      { kind: 'interval', minutes: 29, anchorAt: '2026-11-10T09:00:00Z' },
      { kind: 'interval', minutes: 45.5, anchorAt: '2026-11-10T09:00:00Z' },
      { kind: 'interval', minutes: 60, anchorAt: 'tomorrow-ish' },
      null,
    ];
    for (const schedule of invalid) {
      assert.throws(
        () => assertValidSchedule(schedule),
        error =>
          error instanceof ScheduleError && error.code === 'invalid-schedule',
        JSON.stringify(schedule),
      );
    }
    assert.throws(
      () =>
        nextOccurrence(
          { kind: 'daily', time: '09:00' },
          at('2026-11-10T08:00:00Z'),
          'Mars/Olympus',
        ),
      error =>
        error instanceof ScheduleError && error.code === 'invalid-time-zone',
    );
    assert.throws(
      () =>
        nextOccurrence(
          { kind: 'interval', minutes: 30, anchorAt: '2026-11-10T09:00:00Z' },
          at('2026-11-10T08:00:00Z'),
          'Mars/Olympus',
        ),
      error =>
        error instanceof ScheduleError && error.code === 'invalid-time-zone',
    );
    assert.throws(
      () =>
        collapseMissed(
          { kind: 'daily', time: '09:00' },
          at('2026-11-10T09:00:00Z'),
          new Date(Number.NaN),
          'UTC',
        ),
      error => error instanceof ScheduleError && error.code === 'invalid-date',
    );
    assert.throws(
      () =>
        previewOccurrences(
          { kind: 'daily', time: '09:00' },
          at('2026-11-10T08:00:00Z'),
          'UTC',
          21,
        ),
      error =>
        error instanceof ScheduleError && error.code === 'invalid-schedule',
    );
    assert.throws(
      () =>
        nextOccurrence(
          { kind: 'daily', time: '09:00' },
          new Date(Number.NaN),
          'UTC',
        ),
      error => error instanceof ScheduleError && error.code === 'invalid-date',
    );
  });

  await t.test(
    'the same wall time differs between UTC and Europe/Warsaw',
    () => {
      const schedule = { kind: 'daily', time: '09:00' };
      assert.equal(
        next(schedule, '2026-11-10T00:00:00Z', 'UTC'),
        '2026-11-10T09:00:00.000Z',
      );
      assert.equal(
        next(schedule, '2026-11-10T00:00:00Z', 'Europe/Warsaw'),
        '2026-11-10T08:00:00.000Z',
      );
      assert.equal(
        next(schedule, '2026-07-10T00:00:00Z', 'Europe/Warsaw'),
        '2026-07-10T07:00:00.000Z',
      );
    },
  );

  await t.test(
    'a nonexistent spring-forward time moves to the first valid minute',
    () => {
      const schedule = { kind: 'daily', time: '02:30' };
      const first = next(schedule, '2026-03-28T12:00:00Z', 'Europe/Warsaw');
      assert.equal(first, '2026-03-29T01:00:00.000Z');
      assert.equal(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Warsaw',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(at(first)),
        '03:00',
      );
      assert.equal(
        next(schedule, first, 'Europe/Warsaw'),
        '2026-03-30T00:30:00.000Z',
      );
    },
  );

  await t.test(
    'a repeated fall-back time fires once at the first instance',
    () => {
      const schedule = { kind: 'daily', time: '02:30' };
      const first = next(schedule, '2026-10-24T12:00:00Z', 'Europe/Warsaw');
      assert.equal(first, '2026-10-25T00:30:00.000Z');
      assert.equal(
        next(schedule, first, 'Europe/Warsaw'),
        '2026-10-26T01:30:00.000Z',
      );
      assert.equal(
        next(schedule, '2026-10-25T01:00:00Z', 'Europe/Warsaw'),
        '2026-10-26T01:30:00.000Z',
      );
    },
  );

  await t.test('daily local time is preserved across a DST change', () => {
    const schedule = { kind: 'daily', time: '09:00' };
    assert.deepEqual(
      previewOccurrences(
        schedule,
        at('2026-03-28T09:00:00Z'),
        'Europe/Warsaw',
      ).map(value => value.toISOString()),
      [
        '2026-03-29T07:00:00.000Z',
        '2026-03-30T07:00:00.000Z',
        '2026-03-31T07:00:00.000Z',
      ],
    );
  });

  await t.test('schedules are described in English', () => {
    assert.equal(
      describeSchedule({ kind: 'daily', time: '09:00' }),
      'Every day at 09:00',
    );
    assert.equal(
      describeSchedule({ kind: 'weekdays', time: '09:00' }),
      'Weekdays at 09:00',
    );
    assert.equal(
      describeSchedule({ kind: 'weekly', weekday: 1, time: '07:30' }),
      'Every Monday at 07:30',
    );
    assert.equal(
      describeSchedule({
        kind: 'interval',
        minutes: 30,
        anchorAt: '2026-11-10T09:00:00Z',
      }),
      'Every 30 minutes',
    );
    assert.equal(
      describeSchedule({
        kind: 'interval',
        minutes: 120,
        anchorAt: '2026-11-10T09:00:00Z',
      }),
      'Every 2 hours',
    );
  });

  await t.test(
    'schemas enforce interval, name, prompt, timeout and provider bounds',
    () => {
      const interval = minutes => ({
        kind: 'interval',
        minutes,
        anchorAt: '2026-11-10T09:00:00.000Z',
      });
      assert.equal(
        scheduledJobScheduleSchema.safeParse(interval(29)).success,
        false,
      );
      assert.equal(
        scheduledJobScheduleSchema.safeParse(interval(30)).success,
        true,
      );
      assert.equal(
        scheduledJobScheduleSchema.safeParse({
          kind: 'weekly',
          weekday: 7,
          time: '09:00',
        }).success,
        false,
      );
      const definition = {
        id: randomUUID(),
        expectedRevision: null,
        name: 'Daily summary',
        prompt: '/summarize the repository',
        directory: '',
        provider: 'codex',
        model: 'gpt-5.5',
        effort: 'high',
        mode: 'read-only',
        schedule: { kind: 'daily', time: '09:00' },
        timeZone: 'Europe/Warsaw',
        active: true,
      };
      const parsed = saveScheduledJobSchema.parse(definition);
      assert.equal(parsed.timeoutMinutes, 30);
      const rejected = patch =>
        saveScheduledJobSchema.safeParse({ ...definition, ...patch }).success;
      assert.equal(rejected({ name: 'a'.repeat(80) }), true);
      assert.equal(rejected({ name: 'a'.repeat(81) }), false);
      assert.equal(rejected({ name: '   ' }), false);
      assert.equal(rejected({ prompt: 'a'.repeat(8000) }), true);
      assert.equal(rejected({ prompt: 'a'.repeat(8001) }), false);
      assert.equal(rejected({ timeoutMinutes: 5 }), true);
      assert.equal(rejected({ timeoutMinutes: 120 }), true);
      assert.equal(rejected({ timeoutMinutes: 4 }), false);
      assert.equal(rejected({ timeoutMinutes: 121 }), false);
      assert.equal(rejected({ mode: 'supervised' }), false);
      assert.equal(rejected({ timeZone: 'Mars/Olympus' }), false);
      assert.equal(
        rejected({ provider: 'claude', model: 'sonnet', effort: 'high' }),
        false,
      );
      assert.equal(
        rejected({ provider: 'claude', model: 'sonnet', effort: null }),
        true,
      );
      assert.equal(
        rejected({ provider: 'claude', model: 'gpt-5.5', effort: null }),
        false,
      );
      assert.equal(rejected({ hostId: 'local' }), false);
      assert.equal(rejected({ timeZone: '+02:00' }), false);
      assert.equal(rejected({ prompt: 'run\u0000now' }), false);
      assert.equal(rejected({ prompt: 'line one\nline two' }), true);
      assert.equal(
        saveScheduledJobSchema.parse({
          ...definition,
          timeZone: 'europe/warsaw',
        }).timeZone,
        'Europe/Warsaw',
      );
    },
  );

  await t.test('runs distinguish manual and scheduled triggers', () => {
    const run = {
      id: randomUUID(),
      scheduledJobId: randomUUID(),
      scheduledFor: null,
      trigger: 'manual',
      status: 'running',
      reason: null,
      missedCount: 0,
      sessionId: randomUUID(),
      runId: randomUUID(),
      reviewId: null,
      resetAt: null,
      startedAt: '2026-11-10T09:00:00.000Z',
      finishedAt: null,
    };
    assert.equal(scheduledJobRunSchema.safeParse(run).success, true);
    assert.equal(
      scheduledJobRunSchema.safeParse({ ...run, trigger: 'schedule' }).success,
      false,
    );
    assert.equal(
      scheduledJobRunSchema.safeParse({ ...run, status: 'paused' }).success,
      false,
    );
  });

  await t.test(
    'the session origin is strict and not a public session field',
    () => {
      const origin = {
        kind: 'scheduled-job',
        scheduledJobId: randomUUID(),
        runId: randomUUID(),
      };
      assert.equal(
        scheduledJobSessionOriginSchema.safeParse(origin).success,
        true,
      );
      assert.equal(
        scheduledJobSessionOriginSchema.safeParse({ ...origin, path: '/tmp' })
          .success,
        false,
      );
      assert.equal(scheduledJobSchema.safeParse(origin).success, false);
      assert.equal(
        contracts.createSessionSchema.safeParse({
          title: 'Origin',
          provider: 'Codex',
          model: 'gpt-5.5',
          mode: 'read-only',
          directory: '',
          origin,
        }).success,
        false,
      );
    },
  );
});

const loadScheduledJobHost = async directory => {
  const source = fileURLToPath(new URL('../src/', import.meta.url));
  const outdir = join(directory, 'host-modules');
  const entries = [
    'scheduled-jobs/service.ts',
    'scheduled-jobs/store.ts',
    'sessions/service.ts',
    'sessions/store.ts',
    'review/store.ts',
  ];
  await promisify(execFile)('bun', [
    'build',
    ...entries.map(entry => join(source, entry)),
    '--target=node',
    '--format=esm',
    '--splitting',
    `--root=${source}`,
    `--outdir=${outdir}`,
  ]);
  const modules = await Promise.all(
    entries.map(
      entry =>
        import(pathToFileURL(join(outdir, entry.replace(/\.ts$/, '.js'))).href),
    ),
  );
  return Object.assign({}, ...modules);
};

const createFakeClock = (start, log) => {
  let time = Date.parse(start);
  const timers = new Set();
  return {
    now: () => new Date(time),
    set: value => {
      time = Date.parse(value);
    },
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, at: time + delayMs };
      timers.add(timer);
      log(`timer armed for ${delayMs} ms`);
      return timer;
    },
    clearTimer: timer => timers.delete(timer),
    pending: () => [...timers],
    fire: () => {
      const [timer] = timers;
      assert.ok(timer, 'No timer is armed');
      timers.delete(timer);
      time = Math.max(time, timer.at);
      log('timer fired');
      timer.callback();
    },
  };
};

const waitUntil = async (check, description) => {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, description);
    await delay(20);
  }
};

test(
  'scheduled jobs follow a fake clock without replay, catch-up or busy starts',
  { timeout: 120_000 },
  async t => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'nesvo-scheduler-')),
    );
    const pidFile = join(directory, 'pids.json');
    const previousEnvironment = { ...process.env };
    let database;
    t.after(async () => {
      database?.close();
      for (const key of Object.keys(process.env))
        if (!(key in previousEnvironment)) delete process.env[key];
      Object.assign(process.env, previousEnvironment);
      await rm(directory, { recursive: true, force: true });
    });
    const modules = await loadScheduledJobHost(directory);
    const migrated = launch(directory, pidFile);
    assert.equal((await migrated.request('health')).type, 'health');
    await migrated.stop();
    Object.assign(process.env, fixtureEnvironment(directory, pidFile));
    database = new DatabaseSync(join(directory, 'nesvo.sqlite'));
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250');

    const log = [];
    const clock = createFakeClock('2026-11-16T08:00:00.000Z', line =>
      log.push(`${clock.now().toISOString()} ${line}`),
    );
    const jobs = new modules.ScheduledJobStore(database);
    const sessions = new modules.SessionService(
      new modules.SessionStore(database),
      directory,
      () => undefined,
      new modules.ReviewStore(database),
      () => jobs.interruptActiveRuns(clock.now().toISOString()),
    );
    const launcher = {
      calls: [],
      failure: null,
      launch: async ({ scheduledJob, run }) => {
        launcher.calls.push({ scheduledJobId: scheduledJob.id, runId: run.id });
        log.push(
          `${clock.now().toISOString()} launcher called for ${scheduledJob.name}`,
        );
        if (launcher.failure) throw launcher.failure;
      },
    };
    const describeRun = run =>
      `${jobs.get(run.scheduledJobId)?.name} ${run.trigger} run ${run.status}${run.reason ? `/${run.reason}` : ''}${run.scheduledFor ? ` for ${run.scheduledFor}` : ''} missed=${run.missedCount}`;
    const createScheduler = () =>
      new modules.ScheduledJobService(
        jobs,
        sessions,
        launcher,
        event => {
          if (event.type === 'scheduled-job-run-changed')
            log.push(`${clock.now().toISOString()} ${describeRun(event.run)}`);
        },
        clock,
      );
    const runs = id =>
      database
        .prepare(
          'SELECT trigger_kind AS trigger, status, reason, scheduled_for AS scheduledFor, missed_count AS missedCount FROM scheduled_job_runs WHERE scheduled_job_id = ? ORDER BY recorded_at, id',
        )
        .all(id)
        .map(row => ({ ...row }));
    const lastRun = id => runs(id).at(-1);
    const settle = () => delay(20);
    const definition = (name, schedule, overrides = {}) => ({
      id: randomUUID(),
      expectedRevision: null,
      name,
      prompt: 'Summarize open tasks.',
      directory: '',
      provider: 'claude',
      model: 'sonnet',
      effort: null,
      mode: 'read-only',
      schedule,
      timeZone: 'UTC',
      active: true,
      timeoutMinutes: 30,
      ...overrides,
    });
    const completeStartingRuns = () =>
      database
        .prepare(
          "UPDATE scheduled_job_runs SET status = 'completed', finished_at = ? WHERE status = 'starting'",
        )
        .run(clock.now().toISOString());

    let scheduler = createScheduler();
    scheduler.start();
    const daily = scheduler.save(
      definition('Daily digest', { kind: 'daily', time: '09:00' }),
    );
    assert.equal(daily.nextRunAt, '2026-11-16T09:00:00.000Z');
    assert.deepEqual(
      clock.pending().map(timer => timer.delayMs),
      [3_600_000],
    );
    await scheduler.close();
    assert.equal(clock.pending().length, 0);

    clock.set('2026-11-23T10:00:00.000Z');
    log.push(`${clock.now().toISOString()} host restarted after a week`);
    scheduler = createScheduler();
    scheduler.start();
    assert.deepEqual(runs(daily.id), [
      {
        trigger: 'schedule',
        status: 'skipped',
        reason: 'missed',
        scheduledFor: '2026-11-23T09:00:00.000Z',
        missedCount: 8,
      },
    ]);
    assert.equal(launcher.calls.length, 0);
    assert.equal(jobs.get(daily.id).nextRunAt, '2026-11-24T09:00:00.000Z');

    clock.fire();
    await settle();
    assert.deepEqual(lastRun(daily.id), {
      trigger: 'schedule',
      status: 'starting',
      reason: null,
      scheduledFor: '2026-11-24T09:00:00.000Z',
      missedCount: 0,
    });
    assert.equal(launcher.calls.length, 1);
    scheduler.tick(clock.now());
    scheduler.tick(clock.now());
    assert.equal(runs(daily.id).length, 2);
    const at = clock.now().toISOString();
    assert.equal(
      jobs.insertRun({
        id: randomUUID(),
        scheduledJobId: daily.id,
        scheduledFor: '2026-11-24T09:00:00.000Z',
        trigger: 'schedule',
        status: 'skipped',
        reason: 'missed',
        missedCount: 0,
        sessionId: null,
        runId: null,
        reviewId: null,
        resetAt: null,
        startedAt: null,
        finishedAt: at,
        requestId: null,
        recordedAt: at,
      }),
      false,
    );

    clock.fire();
    await settle();
    assert.equal(lastRun(daily.id).reason, 'overlap');
    assert.equal(launcher.calls.length, 1);
    completeStartingRuns();

    launcher.failure = new modules.SessionError('busy', 'Operator was first.');
    clock.fire();
    await settle();
    assert.deepEqual(
      [lastRun(daily.id).status, lastRun(daily.id).reason],
      ['skipped', 'busy'],
    );
    launcher.failure = new Error('Launch failed.');
    clock.fire();
    await settle();
    assert.deepEqual(
      [lastRun(daily.id).status, lastRun(daily.id).reason],
      ['failed', null],
    );
    launcher.failure = null;
    assert.equal(launcher.calls.length, 3);

    sessions.recordOperatorActivity(new Date('2026-11-28T08:55:00.000Z'));
    clock.fire();
    await settle();
    assert.equal(lastRun(daily.id).reason, 'busy');
    sessions.recordOperatorActivity(new Date('2026-11-29T08:49:00.000Z'));
    clock.fire();
    await settle();
    assert.equal(lastRun(daily.id).status, 'starting');
    assert.equal(launcher.calls.length, 4);
    completeStartingRuns();

    const paused = scheduler.setActive({
      id: daily.id,
      expectedRevision: jobs.get(daily.id).revision,
      active: false,
    });
    assert.equal(paused.nextRunAt, null);
    assert.equal(clock.pending().length, 0);
    const yearly = scheduler.save(
      definition(
        'Yearly review',
        {
          kind: 'interval',
          minutes: 525_600,
          anchorAt: '2027-12-01T09:00:00.000Z',
        },
        {},
      ),
    );
    assert.deepEqual(
      clock.pending().map(timer => timer.delayMs),
      [modules.MAX_TIMER_DELAY_MS],
    );
    clock.fire();
    assert.equal(runs(yearly.id).length, 0);
    assert.deepEqual(
      clock.pending().map(timer => timer.delayMs),
      [modules.MAX_TIMER_DELAY_MS],
    );
    scheduler.setActive({
      id: yearly.id,
      expectedRevision: jobs.get(yearly.id).revision,
      active: false,
    });
    clock.set('2026-12-26T10:00:00.000Z');
    scheduler.tick();
    const resumed = scheduler.setActive({
      id: daily.id,
      expectedRevision: paused.revision,
      active: true,
    });
    assert.equal(resumed.nextRunAt, '2026-12-27T09:00:00.000Z');
    assert.equal(runs(daily.id).length, 7);
    assert.throws(
      () =>
        scheduler.save({
          ...definition('Daily digest', { kind: 'daily', time: '10:00' }),
          id: daily.id,
          expectedRevision: paused.revision,
        }),
      error =>
        error instanceof modules.ScheduledJobError &&
        error.code === 'invalid-request' &&
        /changed elsewhere/.test(error.message),
    );
    assert.equal(jobs.get(daily.id).schedule.time, '09:00');

    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    await Promise.all([
      writeFile(join(workspace, 'tracked.txt'), 'baseline\n'),
      writeFile(join(workspace, 'deleted.txt'), 'delete this baseline\n'),
    ]);
    const held = sessions.create({
      title: 'Operator work',
      provider: 'Claude Code',
      model: 'sonnet',
      mode: 'read-only',
      directory: workspace,
    });
    const holding = sessions.send({
      sessionId: held.id,
      messageId: randomUUID(),
      text: 'fixture:hold',
    });
    assert.equal(sessions.isBusy(), true);
    clock.set('2026-12-27T08:59:00.000Z');
    clock.fire();
    await settle();
    assert.equal(lastRun(daily.id).reason, 'busy');
    const manualRuns = () =>
      database
        .prepare(
          "SELECT count(*) AS total FROM scheduled_job_runs WHERE trigger_kind = 'manual'",
        )
        .get().total;
    assert.throws(
      () => scheduler.runNow({ id: daily.id, requestId: randomUUID() }),
      error =>
        error instanceof modules.ScheduledJobError && error.code === 'busy',
    );
    assert.equal(manualRuns(), 0);
    sessions.stop({ sessionId: held.id, runId: holding.runId });
    await waitUntil(
      () => !sessions.isBusy(),
      'The held fixture run did not stop',
    );

    const writer = sessions.create({
      title: 'Supervised work',
      provider: 'Codex',
      model: 'fixture-codex',
      mode: 'supervised',
      directory: workspace,
    });
    const writing = sessions.send({
      sessionId: writer.id,
      messageId: randomUUID(),
      text: 'fixture:review-write',
    });
    await waitUntil(
      () =>
        sessions
          .listReviews()
          .some(
            review =>
              review.runId === writing.runId && review.status === 'pending',
          ),
      'The supervised fixture run produced no review',
    );
    const review = sessions
      .listReviews()
      .find(item => item.runId === writing.runId);
    assert.equal(review.diff.status, 'complete', review.diff.detail);
    const deciding = sessions.decideReview({
      reviewId: review.id,
      version: review.version,
      decisionId: randomUUID(),
      decision: 'accept',
      feedback: '',
    });
    assert.equal(sessions.isBusy(), true);
    clock.fire();
    await settle();
    assert.equal(lastRun(daily.id).reason, 'busy');
    assert.equal((await deciding).status, 'accepted');
    assert.equal(sessions.isBusy(), false);

    const closing = sessions.close();
    assert.equal(sessions.isBusy(), true);
    clock.fire();
    await settle();
    assert.equal(lastRun(daily.id).reason, 'busy');
    await closing;
    assert.equal(launcher.calls.length, 4);

    let created = jobs.count();
    while (created < modules.MAX_SCHEDULED_JOBS_PER_HOST) {
      scheduler.save(
        definition(
          `Paused job ${created}`,
          { kind: 'daily', time: '12:00' },
          { active: false },
        ),
      );
      created += 1;
    }
    assert.throws(
      () =>
        scheduler.save(
          definition('One too many', { kind: 'daily', time: '12:00' }),
        ),
      error =>
        error instanceof modules.ScheduledJobError &&
        /already has 20 scheduled jobs/.test(error.message),
    );

    const insertHistory = database.prepare(
      "INSERT INTO scheduled_job_runs (id, scheduled_job_id, scheduled_for, trigger_kind, status, reason, missed_count, recorded_at, finished_at) VALUES (?, ?, ?, 'schedule', 'skipped', 'missed', 1, ?, ?)",
    );
    for (let index = 0; index < 110; index += 1) {
      const recorded = new Date(
        Date.parse('2025-01-01T09:00:00.000Z') + index * 86_400_000,
      ).toISOString();
      insertHistory.run(randomUUID(), daily.id, recorded, recorded, recorded);
    }
    jobs.prune(daily.id);
    assert.equal(runs(daily.id).length, modules.SCHEDULED_JOB_RUN_RETENTION);
    assert.equal(lastRun(daily.id).reason, 'busy');

    await scheduler.close();
    assert.equal(clock.pending().length, 0);
    for (const line of log) t.diagnostic(line);
  },
);

test(
  'host serves scheduled job commands, interrupts claimed runs and keeps sessions on delete',
  { timeout: 60_000 },
  async t => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'nesvo-scheduled-host-')),
    );
    const pidFile = join(directory, 'pids.json');
    let host = launch(directory, pidFile);
    t.after(async () => {
      if (host.child.exitCode === null) host.child.kill();
      await host.exited.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    });
    const health = (await host.request('health')).health;
    assert.deepEqual(health.capabilities, [
      'scheduled-jobs',
      'reasoning-effort',
    ]);
    const id = randomUUID();
    const jobInput = {
      id,
      expectedRevision: null,
      name: 'Morning summary',
      prompt: 'Summarize yesterday.',
      directory: '',
      provider: 'claude',
      model: 'sonnet',
      effort: null,
      mode: 'read-only',
      schedule: { kind: 'daily', time: '09:00' },
      timeZone: 'Europe/Warsaw',
      active: true,
    };
    const saved = await host.request('save-scheduled-job', jobInput);
    assert.equal(saved.type, 'scheduled-job', JSON.stringify(saved));
    assert.equal(saved.scheduledJob.revision, 1);
    assert.equal(saved.scheduledJob.timeoutMinutes, 30);
    assert.ok(Date.parse(saved.scheduledJob.nextRunAt) > Date.now());
    await waitUntil(
      () =>
        host.scheduledEvents.some(
          event =>
            event.type === 'scheduled-job-changed' &&
            event.scheduledJob.id === id &&
            event.scheduledJob.revision === 1,
        ),
      'The saved scheduled job was not published',
    );
    assert.equal(
      (await host.request('save-scheduled-job', jobInput)).code,
      'invalid-request',
    );
    assert.equal(
      (
        await host.request('set-scheduled-job-active', {
          id,
          expectedRevision: 2,
          active: false,
        })
      ).code,
      'invalid-request',
    );

    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    const session = (
      await host.request('create-session', {
        title: 'Operator work',
        model: 'sonnet',
        directory: workspace,
      })
    ).session;
    const held = (
      await host.request('send-message', {
        sessionId: session.id,
        messageId: randomUUID(),
        text: 'fixture:hold',
      })
    ).session;
    const busy = await host.request('run-scheduled-job-now', {
      id,
      requestId: randomUUID(),
    });
    assert.equal(busy.code, 'busy', JSON.stringify(busy));
    assert.deepEqual(
      (
        await host.request('list-scheduled-job-runs', {
          scheduledJobId: id,
        })
      ).page,
      { runs: [], nextCursor: null },
    );
    await host.request('stop-run', {
      sessionId: session.id,
      runId: held.runId,
    });
    await host.event(
      value => value.id === session.id && value.status === 'stopped',
    );
    const requestId = randomUUID();
    const manual = await bounded(
      (async () => {
        while (true) {
          const response = await host.request('run-scheduled-job-now', {
            id,
            requestId,
          });
          if (response.code !== 'busy') return response;
          await delay(20);
        }
      })(),
      'The host stayed busy after Stop',
    );
    assert.equal(manual.type, 'scheduled-job-run', JSON.stringify(manual));
    assert.deepEqual(
      [manual.run.trigger, manual.run.status, manual.run.scheduledFor],
      ['manual', 'starting', null],
    );
    assert.equal(
      (await host.request('run-scheduled-job-now', { id, requestId })).run.id,
      manual.run.id,
    );
    const finished = await bounded(
      (async () => {
        while (true) {
          const [run] = (
            await host.request('list-scheduled-job-runs', {
              scheduledJobId: id,
            })
          ).page.runs;
          if (run.status !== 'starting') return run;
          await delay(20);
        }
      })(),
      'The manual run stayed in starting',
    );
    assert.equal(finished.status, 'failed');
    const answered = (
      await host.request('send-message', {
        sessionId: session.id,
        messageId: randomUUID(),
        text: 'Summarize the workspace.',
      })
    ).session;
    await host.review(
      value => value.runId === answered.runId && value.status === 'pending',
    );
    const revision = (await host.request('list-scheduled-jobs', {})).list
      .scheduledJobs[0].revision;
    await host.stop();

    const seeded = new DatabaseSync(join(directory, 'nesvo.sqlite'));
    const claimed = randomUUID();
    try {
      seeded
        .prepare(
          "INSERT INTO scheduled_job_runs (id, scheduled_job_id, scheduled_for, trigger_kind, status, missed_count, recorded_at, started_at) VALUES (?, ?, '2026-01-01T08:00:00.000Z', 'schedule', 'starting', 0, ?, ?)",
        )
        .run(claimed, id, new Date().toISOString(), new Date().toISOString());
      seeded
        .prepare(
          'UPDATE sessions SET scheduled_job_id = ?, scheduled_job_run_id = ? WHERE id = ?',
        )
        .run(id, manual.run.id, session.id);
    } finally {
      seeded.close();
    }

    host = launch(directory, pidFile);
    const recovered = (
      await host.request('list-scheduled-job-runs', { scheduledJobId: id })
    ).page.runs;
    assert.deepEqual(
      recovered.map(run => [run.id, run.status, run.reason]),
      [
        [claimed, 'interrupted', 'restart'],
        [manual.run.id, 'failed', null],
      ],
    );
    assert.equal((await host.request('list-sessions')).sessions.length, 1);
    const deleted = await host.request('delete-scheduled-job', {
      id,
      expectedRevision: revision,
    });
    assert.equal(
      deleted.type,
      'scheduled-job-deleted',
      JSON.stringify(deleted),
    );
    assert.deepEqual(
      (await host.request('list-scheduled-jobs', {})).list.scheduledJobs,
      [],
    );
    assert.equal(
      (await host.request('list-scheduled-job-runs', { scheduledJobId: id }))
        .code,
      'not-found',
    );
    assert.equal((await host.request('list-reviews')).reviews.length, 1);
    await host.stop();

    const check = new DatabaseSync(join(directory, 'nesvo.sqlite'));
    try {
      assert.equal(
        check.prepare('SELECT count(*) AS total FROM scheduled_job_runs').get()
          .total,
        0,
      );
      assert.deepEqual(
        {
          ...check
            .prepare(
              'SELECT scheduled_job_id AS scheduledJobId, scheduled_job_run_id AS runId FROM sessions WHERE id = ?',
            )
            .get(session.id),
        },
        { scheduledJobId: null, runId: null },
      );
    } finally {
      check.close();
    }
  },
);

test(
  'host rolls back a failed version 7 migration',
  { timeout: 15000 },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'nesvo-migration-'));
    const path = join(directory, 'nesvo.sqlite');
    const database = new DatabaseSync(path);
    database.exec(
      'CREATE TABLE scheduled_job_runs (id TEXT PRIMARY KEY); PRAGMA user_version = 6',
    );
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
      assert.equal(check.prepare('PRAGMA user_version').get().user_version, 6);
      assert.deepEqual(
        check
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map(row => row.name),
        ['scheduled_job_runs'],
      );
    } finally {
      check.close();
    }
  },
);

test(
  'Git branch reader isolates, bounds and cancels file reads',
  { timeout: 30_000 },
  async t => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'nesvo-branch-')),
    );
    const tracked = new Set();
    const previousReader = process.env.NESVO_GIT_HEAD_READER ?? null;
    t.after(async () => {
      if (previousReader) process.env.NESVO_GIT_HEAD_READER = previousReader;
      else delete process.env.NESVO_GIT_HEAD_READER;
      for (const pid of tracked) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          tracked.delete(pid);
        }
      }
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const { readGitBranch } = await import('../src/workspace/git-branch.ts');
    const seedHead = async (path, head) => {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'HEAD'), head);
    };
    await seedHead(
      join(directory, 'named', '.git'),
      'ref: refs/heads/feature/ui1c\n',
    );
    await mkdir(join(directory, 'named', 'src', 'deep'), { recursive: true });
    await seedHead(
      join(directory, 'detached', '.git'),
      `${'ab12cd34'.repeat(5)}\n`,
    );
    await seedHead(
      join(directory, 'linked-git', 'worktree'),
      'ref: refs/heads/linked\n',
    );
    await mkdir(join(directory, 'linked'), { recursive: true });
    await writeFile(
      join(directory, 'linked', '.git'),
      'gitdir: ../linked-git/worktree\n',
    );
    await seedHead(join(directory, 'malformed', '.git'), 'ref: refs/heads/\n');
    await mkdir(join(directory, 'plain'), { recursive: true });
    const idle = new AbortController().signal;
    for (const [target, expected] of [
      ['named', { kind: 'branch', name: 'feature/ui1c' }],
      [join('named', 'src', 'deep'), { kind: 'branch', name: 'feature/ui1c' }],
      ['detached', { kind: 'detached', sha: 'ab12cd3' }],
      ['linked', { kind: 'branch', name: 'linked' }],
      ['malformed', { kind: 'none' }],
      ['plain', { kind: 'none' }],
    ])
      assert.deepEqual(
        await readGitBranch(join(directory, target), idle),
        expected,
        target,
      );
    const pidFile = join(directory, 'hung-reader.pid');
    const readerPid = async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const value = await readFile(pidFile, 'utf8').catch(() => '');
        if (value) {
          tracked.add(Number(value));
          return Number(value);
        }
        await delay(20);
      }
      assert.fail('The branch reader did not start.');
    };
    process.env.NESVO_GIT_HEAD_READER = hungReaderPath;
    const started = Date.now();
    await assert.rejects(readGitBranch(directory, idle), /in time/);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 1900 && elapsed < 4000, String(elapsed));
    await processesGone([await readerPid()], tracked);
    await rm(pidFile);
    const controller = new AbortController();
    const pending = readGitBranch(directory, controller.signal);
    const hung = await readerPid();
    assert.equal(alive(hung), true);
    const aborting = Date.now();
    controller.abort();
    await assert.rejects(pending, /in time/);
    assert.ok(Date.now() - aborting < 500, String(Date.now() - aborting));
    await processesGone([hung], tracked);
  },
);

test('Skill YAML limits are enforced on the event stream before construction', async () => {
  const { loadBoundedYaml, YamlLimitError, yamlLimits } =
    await import('../src/skills/yaml-limits.ts');
  const indented = (depth, line) => ' '.repeat(depth * 2) + line;
  const nestings = {
    flowSequence: depth => `${'['.repeat(depth)}1${']'.repeat(depth)}`,
    flowMapping: depth => `${'{a: '.repeat(depth)}1${'}'.repeat(depth)}`,
    emptyFlow: depth => `${'['.repeat(depth)}${']'.repeat(depth)}`,
    blockSequence: depth =>
      `${Array.from({ length: depth }, (_, level) => indented(level, '-')).join('\n')} 1`,
    compactSequence: depth => `${'- '.repeat(depth)}1`,
    blockMapping: depth =>
      `${Array.from({ length: depth }, (_, level) => indented(level, 'k:')).join('\n')} 1`,
  };
  const sequenceOfScalars = count =>
    Array.from({ length: count }, (_, index) => `- v${index}`).join('\n');
  const rejectsWith = (source, kind) =>
    assert.throws(
      () => loadBoundedYaml(source),
      error => error instanceof YamlLimitError && error.kind === kind,
    );

  assert.deepEqual(yamlLimits, { depth: 12, nodes: 512 });
  assert.deepEqual(loadBoundedYaml('name: demo\ntags: [a, b]'), {
    name: 'demo',
    tags: ['a', 'b'],
  });
  assert.equal(loadBoundedYaml(''), undefined);
  assert.deepEqual(loadBoundedYaml('a:\nb: ~\nc: True\nd: 0x1F'), {
    a: null,
    b: null,
    c: true,
    d: 31,
  });

  for (const [name, nest] of Object.entries(nestings)) {
    assert.doesNotThrow(() => loadBoundedYaml(nest(12)), name);
    assert.throws(
      () => loadBoundedYaml(nest(13)),
      error => error instanceof YamlLimitError && error.kind === 'depth',
      name,
    );
  }

  assert.equal(loadBoundedYaml(sequenceOfScalars(511)).length, 511);
  rejectsWith(sequenceOfScalars(512), 'nodes');

  const duplicateKeys = 'a: 1\na: 2\n';
  assert.throws(
    () => loadBoundedYaml(duplicateKeys),
    error =>
      !(error instanceof YamlLimitError) && /duplicat/i.test(error.message),
  );
  rejectsWith(
    `${duplicateKeys}b:\n${sequenceOfScalars(600).replace(/^/gm, '  ')}`,
    'nodes',
  );
  rejectsWith(`${duplicateKeys}b: ${nestings.flowSequence(13)}`, 'depth');

  rejectsWith('a: 1\n---\nb: 2', 'documents');
  assert.throws(() => loadBoundedYaml('a: &x 1\nb: *x'), /alias/i);
});

test(
  'pipeline contracts bound definitions and the host refuses pipeline commands until the engine lands',
  { timeout: 60_000 },
  async t => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'nesvo-pipelines-')),
    );
    const host = launch(directory, join(directory, 'pids.json'));
    t.after(async () => {
      if (host.child.exitCode === null) host.child.kill();
      await host.exited.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    });

    await t.test('the host does not advertise pipelines', async () => {
      const { health } = await host.request('health');
      assert.equal(health.capabilities.includes('pipelines'), false);
    });

    await t.test('every pipeline command answers unavailable', async () => {
      const runId = randomUUID();
      const requests = [
        ['list-pipeline-definitions', { directory }],
        ['validate-pipeline-definitions', { directory }],
        [
          'start-pipeline-task',
          {
            specPath: join(directory, 'task.md'),
            pipelineName: 'default',
            provider: 'Claude Code',
            model: 'sonnet',
            mode: 'read-only',
            directory,
            isolation: 'none',
            gateProvider: 'Claude Code',
            gateModel: 'sonnet',
          },
        ],
        ['run-pipeline-steps', { specPath: 'task.md', directory }],
        ['list-pipeline-runs', { cursor: null, limit: 20 }],
        ['get-pipeline-run', { runId }],
        [
          'decide-pipeline-gate',
          {
            runId,
            stepId: randomUUID(),
            reviewId: randomUUID(),
            version: 1,
            decisionId: randomUUID(),
            decision: 'accept',
            comment: '',
          },
        ],
        [
          'skip-pipeline-step',
          { runId, stepId: randomUUID(), reason: 'Covered by hand.' },
        ],
        ['resume-pipeline-run', { runId }],
        ['stop-pipeline-run', { runId }],
        [
          'save-pipeline-definition',
          {
            directory,
            scope: 'project',
            kind: 'step',
            name: 'unit-tests',
            document: '---\nname: unit-tests\n---\nbun test\n',
          },
        ],
        [
          'delete-pipeline-definition',
          { directory, scope: 'project', kind: 'step', name: 'unit-tests' },
        ],
        ['remove-pipeline-worktree', { runId }],
        [
          'read-pipeline-evidence',
          { runId, stepId: randomUUID(), path: 'log.txt' },
        ],
        [
          'pipeline-metrics',
          { directory: null, since: '2026-11-01T00:00:00.000Z' },
        ],
      ];
      for (const [method, input] of requests) {
        const response = await host.request(method, input);
        assert.deepEqual(
          response,
          {
            type: 'error',
            id: response.id,
            code: 'unavailable',
            message: 'Pipelines are not available on this host yet.',
          },
          method,
        );
      }
    });

    await t.test('isolated sessions answer unavailable', async () => {
      for (const input of [
        {
          title: 'Isolated',
          provider: 'Claude Code',
          model: 'sonnet',
          mode: 'read-only',
          directory,
          isolation: { kind: 'worktree' },
        },
        {
          title: 'Isolated with effort',
          provider: 'Codex',
          model: 'gpt-5.5',
          mode: 'supervised',
          effort: 'high',
          directory,
          isolation: { kind: 'worktree', branch: 'nesvo/isolated' },
        },
      ]) {
        const response = await host.request('create-session', input);
        assert.deepEqual(
          response,
          {
            type: 'error',
            id: response.id,
            code: 'unavailable',
            message: 'Workspace isolation is not available on this host yet.',
          },
          input.title,
        );
      }
      assert.deepEqual((await host.request('list-sessions')).sessions, []);
    });

    await t.test('unknown pipeline request fields are invalid', async () => {
      for (const input of [{ directory, recursive: true }, { directory: 42 }])
        assert.deepEqual(
          await host.send(
            JSON.stringify({
              id: randomUUID(),
              method: 'list-pipeline-definitions',
              input,
            }),
          ),
          { type: 'error', id: null, code: 'invalid-request' },
        );
    });

    await host.stop();
    const {
      agentVerdictJsonSchema,
      agentVerdictSchema,
      decidePipelineGateSchema,
      evidenceSchema,
      parseDurationMs,
      pipelineDefinitionSchema,
      sessionSchema,
      startPipelineTaskSchema,
      stepDefinitionSchema,
      stepResultSchema,
      taskSpecSchema,
    } = await loadScheduledJobContracts(directory);
    const step = {
      name: 'unit-tests',
      type: 'command',
      phase: 'pre-done',
      body: 'bun test',
    };
    const rejects = (schema, value) =>
      assert.equal(
        schema.safeParse(value).success,
        false,
        JSON.stringify(value),
      );

    await t.test('step definitions apply defaults', () => {
      assert.deepEqual(stepDefinitionSchema.parse(step), {
        ...step,
        skill: null,
        timeout: '15m',
        retries: 0,
        on_fail: 'stop',
        needs: [],
      });
      assert.deepEqual(
        stepDefinitionSchema.parse({
          name: 'code-review',
          type: 'agent',
          phase: 'pre-done',
          skill: 'code-review',
          body: '',
          needs: ['browser', 'env:TEST_ACCOUNT'],
        }).needs,
        ['browser', 'env:TEST_ACCOUNT'],
      );
      assert.deepEqual(
        pipelineDefinitionSchema.parse({ name: 'default', steps: ['a'] }),
        { name: 'default', description: '', body: '', steps: ['a'] },
      );
      assert.equal(
        taskSpecSchema.parse({ pipeline: 'default', body: 'Fix it.' }).title,
        undefined,
      );
    });

    await t.test('step refinements reject invalid definitions', () => {
      for (const value of [
        { ...step, type: 'human', retries: 1 },
        { ...step, type: 'human', skill: 'code-review' },
        { ...step, skill: 'code-review' },
        { ...step, type: 'action', skill: 'code-review' },
        { ...step, type: 'agent', body: ' ' },
        { ...step, body: '' },
        { ...step, name: 'Unit Tests' },
        { ...step, timeout: '999ms' },
        { ...step, timeout: '241m' },
        { ...step, timeout: '15 m' },
        { ...step, retries: 6 },
        { ...step, needs: ['env:lower'] },
        { ...step, needs: ['browser', 'browser'] },
        { ...step, effect: 'external' },
      ])
        rejects(stepDefinitionSchema, value);
      rejects(pipelineDefinitionSchema, { name: 'default', steps: [] });
      rejects(pipelineDefinitionSchema, { name: 'default', steps: ['a', 'a'] });
      rejects(taskSpecSchema, { pipeline: 'default', body: '  ' });
    });

    await t.test('durations stay between one second and four hours', () => {
      assert.equal(parseDurationMs('1s'), 1000);
      assert.equal(parseDurationMs('1000ms'), 1000);
      assert.equal(parseDurationMs('15m'), 900_000);
      assert.equal(parseDurationMs('4h'), 14_400_000);
      for (const value of ['999ms', '0s', '5h', '241m', '1d', '-1s', '1.5h'])
        assert.equal(parseDurationMs(value), null, value);
    });

    await t.test('results and verdicts need evidence', () => {
      const result = {
        name: 'unit-tests',
        type: 'command',
        phase: 'pre-done',
        status: 'pass',
        summary: 'All tests passed.',
        evidence: [
          {
            kind: 'log',
            label: 'Output',
            path: 'log.txt',
            text: null,
            url: null,
          },
        ],
        outputs: {},
        startedAt: '2026-11-13T10:00:00.000Z',
        finishedAt: '2026-11-13T10:00:01.000Z',
        durationMs: 1000,
        cost: {
          usd: null,
          inputTokens: null,
          outputTokens: null,
          provider: null,
        },
        attempt: 1,
      };
      assert.equal(stepResultSchema.safeParse(result).success, true);
      rejects(stepResultSchema, { ...result, status: 'done' });
      rejects(stepResultSchema, { ...result, type: 'action' });
      rejects(evidenceSchema, {
        kind: 'log',
        label: 'Empty',
        path: null,
        text: null,
        url: null,
      });
      rejects(evidenceSchema, {
        kind: 'text',
        label: 'Blank',
        path: null,
        text: '',
        url: null,
      });
      const verdict = {
        status: 'pass',
        summary: 'No issues.',
        evidence: [{ reference: 'src/index.ts:12', note: 'Checked.' }],
      };
      assert.equal(agentVerdictSchema.safeParse(verdict).success, true);
      rejects(agentVerdictSchema, { ...verdict, evidence: [] });
      rejects(agentVerdictSchema, { ...verdict, status: 'done' });
      const json = agentVerdictJsonSchema();
      assert.equal(JSON.stringify(json).includes('$ref'), false);
      assert.equal(json.additionalProperties, false);
      assert.deepEqual(json.required, ['status', 'summary', 'evidence']);
      assert.equal(json.properties.evidence.minItems, 1);
    });

    await t.test('commands validate providers and decisions', () => {
      const start = {
        specPath: 'task.md',
        pipelineName: 'default',
        provider: 'Codex',
        model: 'gpt-5.5',
        effort: 'high',
        mode: 'supervised',
        directory,
        isolation: 'worktree',
        gateProvider: 'Claude Code',
        gateModel: 'sonnet',
      };
      assert.equal(startPipelineTaskSchema.safeParse(start).success, true);
      rejects(startPipelineTaskSchema, { ...start, gateModel: 'gpt-5.5' });
      rejects(startPipelineTaskSchema, {
        ...start,
        provider: 'Claude Code',
        model: 'sonnet',
      });
      const decision = {
        runId: randomUUID(),
        stepId: randomUUID(),
        reviewId: randomUUID(),
        version: 1,
        decisionId: randomUUID(),
      };
      assert.equal(
        decidePipelineGateSchema.parse({ ...decision, decision: 'accept' })
          .comment,
        '',
      );
      rejects(decidePipelineGateSchema, { ...decision, decision: 'reject' });
      rejects(decidePipelineGateSchema, { ...decision, decision: 'fix' });
    });

    await t.test(
      'stored sessions without pipeline fields stay readable',
      () => {
        const now = '2026-11-13T10:00:00.000Z';
        const session = sessionSchema.parse({
          id: randomUUID(),
          provider: 'Claude Code',
          providerSessionId: null,
          providerInitialized: false,
          title: 'Older session',
          model: 'sonnet',
          actualModel: null,
          role: 'standalone',
          directory,
          status: 'completed',
          error: null,
          activity: null,
          runId: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          messages: [
            {
              id: randomUUID(),
              runId: randomUUID(),
              author: 'operator',
              body: 'Hello',
              state: 'completed',
              createdAt: now,
            },
          ],
        });
        assert.equal(session.pipelineRunId, null);
        assert.equal(session.pipelineStepId, null);
        assert.equal(session.messages[0].origin, null);
      },
    );
  },
);

const loadPipelineStoreModules = async directory => {
  const source = fileURLToPath(new URL('../src/', import.meta.url));
  const outdir = join(directory, 'pipeline-store-modules');
  const entries = ['pipelines/store.ts', 'sessions/store.ts'];
  await promisify(execFile)('bun', [
    'build',
    ...entries.map(entry => join(source, entry)),
    '--target=node',
    '--format=esm',
    '--splitting',
    `--root=${source}`,
    `--outdir=${outdir}`,
  ]);
  const modules = await Promise.all(
    entries.map(
      entry =>
        import(pathToFileURL(join(outdir, entry.replace(/\.ts$/, '.js'))).href),
    ),
  );
  return Object.assign({}, ...modules);
};

const createVersion7Database = (path, extra = '') => {
  const database = new DatabaseSync(path);
  database.exec(
    `CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE sessions (id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK (json_valid(document)), updated_at TEXT NOT NULL);
     CREATE TABLE reviews (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, document TEXT NOT NULL CHECK (json_valid(document)), updated_at TEXT NOT NULL, UNIQUE(session_id, version));
     ${extra}
     PRAGMA user_version = 7`,
  );
  return database;
};

test(
  'schema version 8 upgrades, rolls back and stores pipeline runs durably',
  { timeout: 120_000 },
  async t => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'nesvo-pipeline-store-')),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const contracts = await loadScheduledJobContracts(directory);
    const { PipelineRunStore, EXTERNAL_ACTION_ATTENTION, SessionStore } =
      await loadPipelineStoreModules(directory);
    const now = '2026-11-13T10:00:00.000Z';
    const at = minute =>
      new Date(Date.parse(now) + minute * 60_000).toISOString();
    const sessionDocument = (id, extra = {}) =>
      contracts.sessionSchema.parse({
        id,
        provider: 'Claude Code',
        providerSessionId: null,
        providerInitialized: false,
        title: 'Pipeline session',
        model: 'sonnet',
        actualModel: null,
        role: 'standalone',
        directory,
        status: 'completed',
        error: null,
        activity: null,
        runId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        messages: [],
        ...extra,
      });
    const stepDefinition = (name, type) => ({
      name,
      type,
      phase: 'pre-done',
      body: 'Run it.',
      source: {
        scope: 'project',
        path: join(directory, `${name}.md`),
        contentHash: 'a'.repeat(64),
      },
    });
    const makeRun = (overrides = {}) =>
      contracts.pipelineRunSchema.parse({
        id: randomUUID(),
        revision: 1,
        pipeline: {
          name: 'default',
          description: '',
          body: '',
          source: {
            scope: 'project',
            path: join(directory, 'default.md'),
            contentHash: 'b'.repeat(64),
          },
          steps: [
            stepDefinition('checks', 'command'),
            stepDefinition('publish', 'action'),
          ],
        },
        specPath: join(directory, 'task.md'),
        specHash: 'c'.repeat(64),
        specTitle: 'Task',
        sessionId: null,
        directory,
        projectRoot: directory,
        isolation: null,
        gateProvider: 'Claude Code',
        gateModel: 'sonnet',
        status: 'implementing',
        phase: 'pre-done',
        currentStepIndex: 0,
        attention: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        ...overrides,
      });
    const makeStep = (run, index, type, overrides = {}) =>
      contracts.pipelineStepRecordSchema.parse({
        id: randomUUID(),
        runId: run.id,
        revision: 1,
        index,
        name: `step-${index}`,
        type,
        phase: 'pre-done',
        state: 'pending',
        attempt: 0,
        result: null,
        sessionId: null,
        reviewId: null,
        reviewVersion: null,
        skip: null,
        updatedAt: now,
        startedAt: null,
        ...overrides,
      });

    const upgradePath = join(directory, 'upgrade');
    const sessionId = randomUUID();
    const reviewId = randomUUID();
    await mkdir(upgradePath);
    const legacy = createVersion7Database(join(upgradePath, 'nesvo.sqlite'));
    legacy
      .prepare(
        'INSERT INTO sessions (id, document, updated_at) VALUES (?, ?, ?)',
      )
      .run(sessionId, JSON.stringify(sessionDocument(sessionId)), now);
    legacy
      .prepare(
        'INSERT INTO reviews (id, session_id, run_id, version, document, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
      )
      .run(reviewId, sessionId, randomUUID(), '{}', now);
    legacy.close();

    await t.test(
      'a version 7 database upgrades and keeps sessions and reviews',
      async () => {
        const host = launch(upgradePath, join(upgradePath, 'pids.json'));
        assert.equal((await host.request('health')).type, 'health');
        await host.stop();
        const upgraded = new DatabaseSync(join(upgradePath, 'nesvo.sqlite'));
        try {
          assert.equal(
            upgraded.prepare('PRAGMA user_version').get().user_version,
            8,
          );
          const tables = upgraded
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map(row => row.name);
          assert.ok(tables.includes('pipeline_runs'));
          assert.ok(tables.includes('pipeline_steps'));
          const columns = upgraded
            .prepare('PRAGMA table_info(sessions)')
            .all()
            .map(column => column.name);
          assert.ok(columns.includes('pipeline_run_id'));
          assert.ok(columns.includes('pipeline_step_id'));
          assert.equal(
            upgraded
              .prepare('SELECT count(*) AS total FROM sessions WHERE id = ?')
              .get(sessionId).total,
            1,
          );
          assert.equal(
            upgraded
              .prepare('SELECT count(*) AS total FROM reviews WHERE id = ?')
              .get(reviewId).total,
            1,
          );
        } finally {
          upgraded.close();
        }
      },
    );

    await t.test('a failed version 8 migration rolls back', async () => {
      const failingPath = join(directory, 'failing');
      await mkdir(failingPath);
      createVersion7Database(
        join(failingPath, 'nesvo.sqlite'),
        'CREATE TABLE pipeline_runs (id TEXT PRIMARY KEY);',
      ).close();
      const host = launch(failingPath, join(failingPath, 'pids.json'));
      assert.equal(
        (await bounded(host.exited, 'Host startup timed out')).code,
        1,
        host.error(),
      );
      const check = new DatabaseSync(join(failingPath, 'nesvo.sqlite'));
      try {
        assert.equal(
          check.prepare('PRAGMA user_version').get().user_version,
          7,
        );
        assert.deepEqual(
          check
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
            )
            .all()
            .map(row => row.name),
          ['metadata', 'pipeline_runs', 'reviews', 'sessions'],
        );
        assert.equal(
          check
            .prepare('PRAGMA table_info(sessions)')
            .all()
            .some(column => column.name === 'pipeline_run_id'),
          false,
        );
      } finally {
        check.close();
      }
    });

    await t.test('a version 9 database is refused', async () => {
      const newerPath = join(directory, 'newer');
      await mkdir(newerPath);
      const newer = new DatabaseSync(join(newerPath, 'nesvo.sqlite'));
      newer.exec('PRAGMA user_version = 9');
      newer.close();
      const host = launch(newerPath, join(newerPath, 'pids.json'));
      assert.equal(
        (await bounded(host.exited, 'Host startup timed out')).code,
        1,
        host.error(),
      );
      const check = new DatabaseSync(join(newerPath, 'nesvo.sqlite'));
      try {
        assert.equal(
          check.prepare('PRAGMA user_version').get().user_version,
          9,
        );
      } finally {
        check.close();
      }
    });

    const database = new DatabaseSync(join(upgradePath, 'nesvo.sqlite'));
    database.exec('PRAGMA foreign_keys = ON');
    t.after(() => database.close());
    const store = new PipelineRunStore(database);
    const sessions = new SessionStore(database);

    await t.test('replaceRun rejects a stale revision', () => {
      const run = makeRun();
      assert.equal(store.insertRun(run), true);
      assert.equal(store.insertRun(run), false);
      const next = { ...run, revision: 2, updatedAt: at(1) };
      assert.equal(store.replaceRun(next, 1), true);
      assert.equal(store.replaceRun({ ...next, revision: 3 }, 1), false);
      assert.equal(store.getRun(run.id).revision, 2);
    });

    await t.test('an attempt row is unique per run and step', () => {
      const run = makeRun();
      store.insertRun(run);
      const first = makeStep(run, 0, 'command', { attempt: 1 });
      assert.equal(store.insertStep(first), true);
      assert.equal(
        store.insertStep(makeStep(run, 0, 'command', { attempt: 1 })),
        false,
      );
      assert.equal(
        store.insertStep(makeStep(run, 0, 'command', { attempt: 2 })),
        true,
      );
      assert.deepEqual(
        store.stepsForRun(run.id).map(step => [step.index, step.attempt]),
        [
          [0, 1],
          [0, 2],
        ],
      );
    });

    await t.test('runs page by update time with a stable cursor', () => {
      const own = [3, 1, 2].map(minute =>
        makeRun({ status: 'passed', updatedAt: at(1000 + minute) }),
      );
      for (const run of own) store.insertRun(run);
      const first = store.listRuns(null, 2);
      assert.deepEqual(
        first.runs.map(run => run.updatedAt),
        [at(1003), at(1002)],
      );
      assert.ok(first.nextCursor);
      const second = store.listRuns(first.nextCursor, 1);
      assert.equal(second.runs[0].updatedAt, at(1001));
      assert.equal(store.listRuns('garbage', 5), undefined);
    });

    await t.test('prune keeps active and resumable runs', () => {
      const root = join(directory, 'prune-project');
      const finished = [1, 2, 3, 4].map(minute =>
        makeRun({
          projectRoot: root,
          status: 'passed',
          createdAt: at(2000 + minute),
          updatedAt: at(2000 + minute),
        }),
      );
      const kept = [
        'planning',
        'awaiting-human',
        'interrupted',
        'needs-attention',
      ].map((status, minute) =>
        makeRun({ projectRoot: root, status, createdAt: at(minute) }),
      );
      for (const run of [...finished, ...kept]) store.insertRun(run);
      const step = makeStep(finished[0], 0, 'command', { attempt: 1 });
      store.insertStep(step);
      store.prune(root, 2);
      const remaining = new Set(
        database
          .prepare('SELECT id FROM pipeline_runs WHERE project_root = ?')
          .all(root)
          .map(row => row.id),
      );
      assert.deepEqual(
        [...remaining].sort(),
        [finished[2].id, finished[3].id, ...kept.map(run => run.id)].sort(),
      );
      assert.equal(store.getStep(step.id), undefined);
      assert.equal(store.activeRunForDirectory(root).status, 'awaiting-human');
    });

    await t.test(
      'interrupt marks active runs and flags external actions',
      () => {
        const statuses = [
          'pending',
          'planning',
          'implementing',
          'checking',
          'fixing',
          'awaiting-human',
          'passed',
          'failed',
        ];
        const runs = Object.fromEntries(
          statuses.map(status => [
            status,
            makeRun({ projectRoot: join(directory, 'interrupt'), status }),
          ]),
        );
        for (const run of Object.values(runs)) {
          store.insertRun(run);
          store.insertStep(
            makeStep(run, 0, 'command', { attempt: 1, state: 'running' }),
          );
        }
        const withAction = makeRun({
          projectRoot: join(directory, 'interrupt'),
          status: 'fixing',
        });
        store.insertRun(withAction);
        store.insertStep(
          makeStep(withAction, 0, 'command', { attempt: 1, state: 'passed' }),
        );
        store.insertStep(
          makeStep(withAction, 1, 'action', { attempt: 1, state: 'running' }),
        );
        const awaiting = makeRun({ status: 'awaiting-human' });
        store.insertRun(awaiting);
        store.insertStep(
          makeStep(awaiting, 0, 'human', {
            attempt: 1,
            state: 'awaiting-human',
          }),
        );
        const interruptedAt = at(5000);
        store.interruptActiveRuns(interruptedAt);
        const statusOf = run => store.getRun(run.id).status;
        assert.deepEqual(
          ['planning', 'implementing', 'checking', 'fixing'].map(status =>
            statusOf(runs[status]),
          ),
          ['interrupted', 'interrupted', 'interrupted', 'interrupted'],
        );
        for (const status of ['pending', 'awaiting-human', 'passed', 'failed'])
          assert.equal(statusOf(runs[status]), status);
        assert.equal(store.getRun(runs.planning.id).revision, 2);
        assert.equal(store.getRun(runs.pending.id).revision, 1);
        assert.equal(
          store.stepsForRun(runs.planning.id)[0].state,
          'interrupted',
        );
        assert.equal(store.stepsForRun(runs.pending.id)[0].state, 'running');
        assert.equal(statusOf(withAction), 'needs-attention');
        assert.equal(
          store.getRun(withAction.id).attention,
          EXTERNAL_ACTION_ATTENTION,
        );
        assert.deepEqual(
          store.stepsForRun(withAction.id).map(step => step.state),
          ['passed', 'uncertain'],
        );
        assert.equal(statusOf(awaiting), 'awaiting-human');
        assert.equal(store.stepsForRun(awaiting.id)[0].state, 'awaiting-human');
      },
    );

    await t.test(
      'startup interrupt joins the session recovery transaction',
      () => {
        const run = makeRun({ projectRoot: join(directory, 'recovery') });
        store.insertRun(run);
        store.insertStep(
          makeStep(run, 0, 'command', { attempt: 1, state: 'running' }),
        );
        assert.throws(() =>
          sessions.recover(() => {
            store.interruptActiveRuns(at(6000));
            throw new Error('abort recovery');
          }),
        );
        assert.equal(store.getRun(run.id).status, 'implementing');
        sessions.recover(() => store.interruptActiveRuns(at(6000)));
        assert.equal(store.getRun(run.id).status, 'interrupted');
        assert.equal(store.stepsForRun(run.id)[0].state, 'interrupted');
      },
    );

    await t.test('beginStep records intent with its start time', () => {
      const run = makeRun();
      store.insertRun(run);
      const step = makeStep(run, 0, 'action');
      store.insertStep(step);
      assert.equal(store.beginStep(step.id, 7, at(10)), undefined);
      const started = store.beginStep(step.id, 1, at(10));
      assert.equal(started.state, 'running');
      assert.equal(started.attempt, 1);
      assert.equal(started.startedAt, at(10));
      assert.equal(started.revision, 2);
      assert.equal(store.getStep(step.id).startedAt, at(10));
      assert.equal(store.beginStep(step.id, 2, at(11)), undefined);
      assert.equal(
        database
          .prepare('SELECT started_at FROM pipeline_steps WHERE id = ?')
          .get(step.id).started_at,
        at(10),
      );
    });

    await t.test(
      'deleting a run nulls the session link and keeps the session',
      () => {
        const run = makeRun();
        store.insertRun(run);
        const step = makeStep(run, 0, 'command', { attempt: 1 });
        store.insertStep(step);
        const session = sessionDocument(randomUUID(), {
          pipelineRunId: run.id,
          pipelineStepId: step.id,
        });
        sessions.save(session);
        const link = () =>
          database
            .prepare(
              'SELECT pipeline_run_id AS runId, pipeline_step_id AS stepId FROM sessions WHERE id = ?',
            )
            .get(session.id);
        assert.deepEqual({ ...link() }, { runId: run.id, stepId: step.id });
        assert.equal(store.linkSession(session.id, run.id, null), true);
        assert.deepEqual({ ...link() }, { runId: run.id, stepId: null });
        database.prepare('DELETE FROM pipeline_runs WHERE id = ?').run(run.id);
        assert.deepEqual({ ...link() }, { runId: null, stepId: null });
        assert.equal(sessions.get(session.id).id, session.id);
        sessions.save(session);
        assert.deepEqual({ ...link() }, { runId: null, stepId: null });
      },
    );
  },
);
