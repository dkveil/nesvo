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
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(
  new URL('./claude-fixture.mjs', import.meta.url),
);
const codexFixturePath = fileURLToPath(
  new URL('./codex-fixture.mjs', import.meta.url),
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

function launch(directory, pidFile) {
  const child = spawn(process.execPath, ['apps/host/dist/main.js'], {
    env: {
      ...process.env,
      NESVO_DATA_DIR: directory,
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
      CLAUDE_CONFIG_DIR: join(directory, 'claude-config'),
      CODEX_HOME: join(directory, 'codex-config'),
      NESVO_TEST_SKILLS_HOME: join(directory, 'skills-home'),
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
    });
    assert.equal(status.type, 'claude-status');
    assert.equal(status.status.status, 'ready');
    assert.equal(status.status.version, '2.1.0');
    assert.deepEqual(
      status.status.models.map(model => model.id),
      ['default', 'opus', 'sonnet', 'haiku'],
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
