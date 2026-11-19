import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

const directory = await realpath(
  await mkdtemp(join(tmpdir(), 'nesvo-d87-desktop-')),
);
const cwd = join(directory, 'workspace');
const screenshots = process.env.NESVO_D87_SCREENSHOTS;
const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
const env = {
  ...process.env,
  NESVO_TEST_MODE: '1',
  NESVO_SMOKE_TEST: '1',
  NESVO_DATA_DIR: join(directory, 'data'),
  NESVO_WORKFLOWS_HOME: join(directory, 'workflows'),
  NESVO_TEST_SKILLS_HOME: join(directory, 'skills'),
  NESVO_TEST_PID_FILE: join(directory, 'processes.json'),
  NESVO_CLAUDE_EXECUTABLE: resolve('apps/host/tests/claude-fixture.mjs'),
  NESVO_CODEX_EXECUTABLE: resolve('apps/host/tests/codex-fixture.mjs'),
  NESVO_FIXTURE_PID_FILE: join(directory, 'claude.json'),
  NESVO_CODEX_FIXTURE_PID_FILE: join(directory, 'codex.json'),
  NESVO_CODEX_FIXTURE_STATE_DIR: join(directory, 'codex-state'),
  CLAUDE_CONFIG_DIR: join(directory, 'claude-config'),
  CODEX_HOME: join(directory, 'codex-config'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NESVO_WORK_LAPTOP_MODE;

let application;
let page;
const failures = [];

const open = async () => {
  application = await electron.launch({
    executablePath: requireDesktop('electron'),
    args: [
      resolve('apps/desktop'),
      '--remote-debugging-port=9248',
      '--force-device-scale-factor=1',
    ],
    env,
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => failures.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(
    async () =>
      !!window.nesvo &&
      (await window.nesvo.listComputers()).some(
        computer => computer.id === 'local' && computer.status === 'connected',
      ),
  );
};

const api = (method, input) =>
  page.evaluate(({ method, input }) => window.nesvo[method](input), {
    method,
    input,
  });
const session = id => api('getSession', { sessionId: id, limit: 200 });
const send = (id, text) =>
  api('sendMessage', { sessionId: id, text, messageId: randomUUID() });

const waitFor = async (label, read, test) => {
  const stop = Date.now() + 30_000;
  let value;
  do {
    value = await read();
    if (test(value)) return value;
    await delay(100);
  } while (Date.now() < stop);
  assert.fail(`Timed out: ${label}`);
};
const settle = (id, runId) =>
  waitFor(
    'completed run',
    () => session(id),
    value => value.runId === runId && value.status === 'completed',
  );
const choose = async title => {
  await page
    .getByRole('button', { name: new RegExp('^' + title + ' ?') })
    .first()
    .click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
};
const openFlows = async () => {
  const flows = page.getByRole('region', { name: 'Flows', exact: true });
  if (!(await flows.isVisible())) {
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    await page
      .getByRole('region', { name: 'Workflows', exact: true })
      .getByRole('button', { name: 'Flows', exact: true })
      .click();
  }
  await flows.waitFor();
  return flows;
};
const capture = async name => {
  if (!screenshots) return;
  for (const [width, height] of [
    [1280, 800],
    [1920, 1080],
  ]) {
    await application.evaluate(
      async ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setContentSize(size[0], size[1]);
      },
      [width, height],
    );
    await page.evaluate(
      () =>
        new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const result = await application.evaluate(async ({ BrowserWindow }) => {
      const image =
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(
          undefined,
          { stayHidden: true, stayAwake: true },
        );
      return image.toPNG().toString('base64');
    });
    const png = Buffer.from(result, 'base64');
    assert.deepEqual(
      [png.readUInt32BE(16), png.readUInt32BE(20)],
      [width, height],
    );
    await writeFile(
      join(screenshots, `d87-${width}x${height}-${name}.png`),
      png,
    );
  }
};

async function verifyWorkflowLayout(flows) {
  const workflows = env.NESVO_WORKFLOWS_HOME;
  for (const folder of ['steps', 'workflows'])
    await mkdir(join(workflows, folder), { recursive: true });
  await writeFile(
    join(workflows, 'steps', 'prepare.md'),
    '---\nname: prepare\ntype: command\nphase: pre-done\n---\necho ok\n',
  );
  await writeFile(
    join(workflows, 'steps', 'approve.md'),
    '---\nname: approve\ntype: human\nphase: pre-done\n---\nApprove the release.\n',
  );
  await writeFile(
    join(workflows, 'steps', 'publish.md'),
    '---\nname: publish\ntype: command\nphase: pre-done\n---\necho ready\n',
  );
  await writeFile(
    join(workflows, 'workflows', 'release-check.md'),
    '---\nname: release-check\nsteps: [prepare, approve, publish]\n---\n',
  );
  const start = async (project, title, prompt) => {
    const projectDir = join(directory, project);
    await mkdir(join(projectDir, '.agents', 'tasks'), { recursive: true });
    const specPath = join('.agents', 'tasks', title + '.md');
    await writeFile(
      join(projectDir, specPath),
      `---\nworkflow: release-check\ntitle: ${title}\n---\n${prompt}\n`,
    );
    await page.evaluate(
      input => window.nesvo.workflows.startTask('local', input),
      {
        specPath,
        workflowName: 'release-check',
        provider: 'Claude Code',
        model: 'default',
        mode: 'read-only',
        directory: projectDir,
        isolation: 'none',
        gateProvider: 'Claude Code',
        gateModel: 'default',
      },
    );
  };
  await start('Storefront', 'Validate receipts', 'fixture:hold-exit');
  const storefront = flows.getByRole('region', {
    name: 'Storefront',
    exact: true,
  });
  const release = storefront.getByRole('region', {
    name: 'release-check',
    exact: true,
  });
  await release
    .getByRole('button', { name: /Open Validate receipts, Interrupted/ })
    .waitFor();
  await start('Storefront', 'Review checkout', 'Check the checkout changes.');
  await release
    .locator('[data-flow-step="approve"]')
    .getByRole('button', { name: /Open Review checkout, Waiting for you/ })
    .waitFor();
  await release.getByText(/Waiting for a decision in Inbox/).waitFor();
  await start('Docs', 'Review release notes', 'Check the release notes.');
  const docs = flows.getByRole('region', {
    name: 'Docs',
    exact: true,
  });
  await docs
    .locator('[data-flow-step="approve"]')
    .getByRole('button', { name: /Open Review release notes, Waiting for you/ })
    .waitFor();
  assert.equal(await release.count(), 1);
  assert.equal(
    await flows
      .getByRole('region', { name: 'release-check', exact: true })
      .count(),
    2,
  );

  const between = release.getByText('Between steps', { exact: true });
  const firstStep = release.locator('[data-flow-step="prepare"]');
  await firstStep.getByText('Command', { exact: true }).waitFor();
  assert.equal(await flows.getByText(/\b0 (sessions|agents)\b/).count(), 0);

  const toolbar = flows.getByRole('toolbar', { name: 'Flows zoom controls' });
  assert.equal(await toolbar.count(), 1);
  const graphWidths = () =>
    flows
      .locator('[data-flow-step="prepare"]')
      .evaluateAll(nodes =>
        nodes.map(node => node.getBoundingClientRect().width),
      );
  const initial = await graphWidths();
  await toolbar.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await waitFor(
    'shared graph zoom',
    graphWidths,
    widths =>
      widths.length === initial.length &&
      widths.every((width, index) => width > initial[index]),
  );
  await toolbar
    .getByRole('button', { name: 'Fit graphs', exact: true })
    .click();
  await waitFor(
    'shared graph fit',
    graphWidths,
    widths =>
      widths.length === initial.length &&
      widths.every((width, index) => Math.abs(width - initial[index]) < 1),
  );
  const left = async locator => (await locator.boundingBox()).x;
  assert.ok(Math.abs((await left(between)) - (await left(firstStep))) < 1);
  await flows.locator('[data-slot="panel-body"]').evaluate(element => {
    element.scrollTop = 0;
  });
  await capture('flows-layout');
}

try {
  await mkdir(cwd, { recursive: true });
  await mkdir(env.CODEX_HOME, { recursive: true });
  await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });
  const inboxRules = join(directory, 'inbox-rules');
  await mkdir(inboxRules);
  await writeFile(
    join(inboxRules, 'child-review.md'),
    [
      '---',
      'name: child-review',
      'trigger: result-to-review',
      'action: route',
      'route: both',
      'kinds: [child]',
      '---',
      '',
    ].join('\n'),
  );
  if (screenshots) await mkdir(screenshots, { recursive: true });
  await open();
  const initialPolicy = await waitFor(
    'session control available',
    () => api('readSessionControlPolicy', 'local').catch(() => null),
    value => !!value,
  );
  await api('setColorScheme', 'dark');
  const coordinator = await api('createSession', {
    title: 'Release notes',
    directory: cwd,
    provider: 'Claude Code',
    model: 'default',
  });
  const first = await send(
    coordinator.id,
    'fixture:say We can keep the release notes short and check the changes in the sample project.',
  );
  await settle(coordinator.id, first.runId);
  await choose(coordinator.title);
  await page
    .getByText(
      'We can keep the release notes short and check the changes in the sample project.',
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.locator('[data-coordinator-wake]').count(), 0);
  assert.equal(
    await page.getByRole('region', { name: 'Child sessions' }).count(),
    0,
  );
  await capture('ordinary');
  const emptyFlows = await openFlows();
  await emptyFlows.getByText('No live flows', { exact: true }).waitFor();
  await choose(coordinator.title);

  await api('saveSessionControlPolicy', {
    ...initialPolicy,
    enabled: true,
    childModes: ['read-only', 'supervised'],
  });
  const start = await send(
    coordinator.id,
    'fixture:nesvo ' +
      JSON.stringify([
        {
          tool: 'session_create',
          arguments: {
            title: 'Draft review',
            provider: 'Codex',
            model: 'fixture-codex',
            prompt: 'fixture:steer-write',
            mode: 'supervised',
          },
        },
      ]),
  );
  const delegated = await settle(coordinator.id, start.runId);
  const childId = delegated.turnChildren.find(
    turn => turn.runId === start.runId,
  ).sessionIds[0];
  const child = await waitFor(
    'child input ready',
    () => session(childId),
    value =>
      value.status === 'running' &&
      value.messages.at(-1)?.body.includes('Waiting for feedback.'),
  );
  const childCard = page.getByRole('region', { name: 'Child sessions' });
  await childCard.getByText(child.title, { exact: true }).waitFor();
  await page.getByText('Waiting for children', { exact: true }).waitFor();
  await capture('coordinator-waiting');

  const flows = await openFlows();
  const tree = flows.getByRole('region', {
    name: 'Ad hoc orchestration',
    exact: true,
  });
  const waiting = tree.getByText('Waiting for children', { exact: true });
  await waiting.waitFor();
  const setWake = async enabled => {
    const { revision } = await api('readCoordinatorWake', {
      sessionId: coordinator.id,
    });
    return api('setCoordinatorWake', {
      sessionId: coordinator.id,
      enabled,
      expectedRevision: revision,
      actionId: randomUUID(),
    });
  };
  await setWake(false);
  await waiting.waitFor({ state: 'hidden' });
  await setWake(true);
  await waiting.waitFor();
  await tree
    .getByRole('button', { name: 'Open Draft review, Running', exact: true })
    .click();
  await page.getByRole('heading', { name: child.title, exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Keep the examples for the next release.');
  await page.getByRole('button', { name: 'Steer', exact: true }).click();
  await page.getByText('Steered', { exact: true }).waitFor();
  const finished = await settle(child.id, child.runId);
  assert.equal(
    finished.messages.filter(message => message.origin === 'steering').length,
    1,
  );
  await capture('steered');

  await choose(coordinator.title);
  await page.getByRole('article', { name: 'Nesvo', exact: true }).waitFor();
  const woken = await waitFor(
    'one persisted wake',
    () => session(coordinator.id),
    value =>
      value.messages.filter(message => message.origin === 'coordinator-wake')
        .length === 1 && value.status === 'completed',
  );
  assert.equal(woken.providerSessionId, delegated.providerSessionId);
  assert.deepEqual(
    woken.turnChildren.find(turn => turn.runId === start.runId).childRuns,
    [{ sessionId: child.id, runId: child.runId }],
  );
  await childCard.getByText('Needs a decision', { exact: true }).waitFor();
  await capture('nesvo-wake');
  await page
    .getByRole('button', { name: 'Inspect Draft review', exact: true })
    .first()
    .click();
  const drawer = page.getByRole('dialog', { name: 'Child work', exact: true });
  await drawer
    .getByText('Keep the examples for the next release.', { exact: true })
    .waitFor();
  await drawer
    .getByRole('button', { name: 'Saved result v1', exact: true })
    .waitFor();
  await capture('child-transcript');
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('aria-label') ===
      'Inspect Draft review',
  );

  const firstReview = (await api('listReviews')).find(
    item => item.sessionId === child.id && item.runId === child.runId,
  );
  assert.equal(firstReview.diff.status, 'complete');
  assert.ok(firstReview.diff.files.some(file => file.path === 'notes.md'));
  assert.equal(firstReview.route, 'both');
  await page
    .getByRole('region', { name: 'Decisions from child sessions' })
    .getByText('Draft review', { exact: true })
    .waitFor();
  await openFlows();
  await tree
    .getByRole('button', {
      name: 'Open Draft review, Waiting for you',
      exact: true,
    })
    .waitFor();
  await tree
    .getByRole('button', { name: 'Open Inbox for Draft review', exact: true })
    .click();
  const inboxResult = page.getByRole('article', {
    name: 'Review result: Draft review, version 1',
    exact: true,
  });
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute('aria-label') ===
      'Review result: Draft review, version 1',
  );
  await inboxResult
    .getByRole('button', { name: 'Request changes', exact: true })
    .click();
  await inboxResult
    .getByRole('textbox', { name: 'Feedback', exact: true })
    .fill('Use the shorter wording in the summary.');
  await inboxResult
    .getByRole('button', { name: 'Send feedback', exact: true })
    .click();
  await inboxResult.waitFor({ state: 'hidden' });
  await waitFor(
    'child correction',
    () => session(child.id),
    value => value.runId !== child.runId && value.status === 'completed',
  );
  assert.equal(
    (await api('listReviews')).find(item => item.id === firstReview.id).decision
      ?.decision,
    'request-changes',
  );
  await waitFor(
    'pending correction update',
    () => api('readCoordinatorWake', { sessionId: coordinator.id }),
    value => value.pending > 0,
  );
  const hold = await send(coordinator.id, 'fixture:hold');
  await choose(coordinator.title);
  await page
    .getByRole('region', { name: 'Decisions from child sessions' })
    .getByRole('article', {
      name: 'Review result: Draft review, version 1',
      exact: true,
    })
    .waitFor({ state: 'hidden' });
  await page
    .getByRole('button', { name: 'Inspect Draft review', exact: true })
    .first()
    .click();
  await drawer
    .getByRole('button', { name: 'Saved result v1', exact: true })
    .click();
  const savedDiff = page.getByRole('region', {
    name: 'Saved result diff',
    exact: true,
  });
  await savedDiff
    .getByRole('button', { name: 'View changes in notes.md', exact: true })
    .waitFor();
  await savedDiff
    .getByRole('button', { name: 'Close diff', exact: true })
    .click();
  await choose(coordinator.title);

  await page.reload();
  await page.getByRole('article', { name: 'Nesvo', exact: true }).waitFor();
  assert.equal(
    (await session(coordinator.id)).messages.filter(
      message => message.origin === 'coordinator-wake',
    ).length,
    1,
  );
  await application.close();
  application = null;
  await open();
  const recoveredFlows = await openFlows();
  const recoveredTree = recoveredFlows.getByRole('region', {
    name: 'Ad hoc orchestration',
    exact: true,
  });
  await recoveredTree.getByText('Continue required', { exact: true }).waitFor();
  await recoveredTree
    .getByRole('button', {
      name: 'Open Release notes, Continue after restart',
      exact: true,
    })
    .click();
  await page.getByText('Continue after restart', { exact: true }).waitFor();
  const recovered = await session(coordinator.id);
  assert.equal(recovered.runId, hold.runId);
  assert.equal(recovered.status, 'interrupted');
  const offlineWake = await api('readCoordinatorWake', {
    sessionId: coordinator.id,
  });
  const offlineSessions = (await api('listSessions'))
    .filter(
      item => item.id === coordinator.id || item.parentId === coordinator.id,
    )
    .map(({ hostId: _hostId, ...item }) => item);
  await capture('continue-after-restart');
  await page
    .locator('[data-coordinator-wake]')
    .getByRole('button', { name: 'Continue', exact: true })
    .click();
  const continued = await waitFor(
    'explicit restart delivery',
    () => session(coordinator.id),
    value => value.runId !== hold.runId && value.status === 'completed',
  );
  assert.equal(continued.providerSessionId, woken.providerSessionId);
  assert.equal(
    continued.messages.filter(message => message.origin === 'coordinator-wake')
      .length,
    2,
  );

  await api('saveSessionControlPolicy', {
    ...initialPolicy,
    enabled: true,
    nested: true,
  });
  const nested = await api('createSession', {
    title: 'Release coordination',
    directory: cwd,
    provider: 'Claude Code',
    model: 'default',
  });
  const spawnChild = (title, prompt) =>
    'fixture:nesvo ' +
    JSON.stringify([{ tool: 'session_create', arguments: { title, prompt } }]);
  const nestedStart = await send(
    nested.id,
    spawnChild('Documentation', spawnChild('Verify examples', 'fixture:hold')),
  );
  await settle(nested.id, nestedStart.runId);
  const nestedFlows = await openFlows();
  const documentation = nestedFlows.getByRole('list', {
    name: 'Children of Release coordination',
    exact: true,
  });
  const examples = documentation.getByRole('list', {
    name: 'Children of Documentation',
    exact: true,
  });
  await examples
    .getByRole('button', { name: 'Open Verify examples, Running', exact: true })
    .waitFor();
  await capture('flows');
  await verifyWorkflowLayout(nestedFlows);
  await application.close();
  application = null;
  const computerId = randomUUID();
  const instanceId = randomUUID();
  await writeFile(
    join(env.NESVO_DATA_DIR, 'computers.json'),
    JSON.stringify({
      version: 1,
      computers: [
        {
          id: computerId,
          instanceId,
          input: {
            name: 'Offline fixture',
            hostname: '127.0.0.1',
            port: 1,
            entryPath: '/srv/nesvo/main.js',
            runtimeDirectory: '/srv/nesvo',
          },
        },
      ],
    }),
  );
  await writeFile(
    join(env.NESVO_DATA_DIR, 'computer-cache.json'),
    JSON.stringify({
      version: 2,
      computers: [
        {
          id: computerId,
          instanceId,
          lastSyncedAt: new Date().toISOString(),
          sessions: offlineSessions,
          recent: [],
          reviews: [],
          coordinatorWake: [offlineWake],
        },
      ],
    }),
  );
  await open();
  const offlineFlows = await openFlows();
  const offlineTree = offlineFlows.getByRole('region', {
    name: 'Offline fixture orchestration',
    exact: true,
  });
  await offlineTree
    .getByText('Offline fixture · Offline', { exact: true })
    .waitFor();
  await offlineTree.getByText('Continue required', { exact: true }).waitFor();
  assert.deepEqual(failures, []);
  console.log(
    'D87 desktop fixture passed: ordinary, children, steering, wake, drawer, reload, restart, orchestration flows and shared workflow layout.',
  );
} finally {
  await application?.close().catch(() => undefined);
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
}
