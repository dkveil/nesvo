import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

const directory = await realpath(
  await mkdtemp(join(tmpdir(), 'nesvo-desktop-')),
);
const pidFile = join(directory, 'processes.json');
const providerPidFile = join(directory, 'provider.json');
const codexPidFile = join(directory, 'codex-provider.json');
const workerPidDirectory = join(directory, 'worker-processes');
const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
const executablePath =
  process.env.NESVO_PACKAGED_EXECUTABLE || requireDesktop('electron');
const env = {
  ...process.env,
  NESVO_SMOKE_TEST: '1',
  NESVO_DATA_DIR: directory,
  NESVO_TEST_PID_FILE: pidFile,
  NESVO_CLAUDE_EXECUTABLE: resolve('apps/host/tests/claude-fixture.mjs'),
  NESVO_FIXTURE_PID_FILE: providerPidFile,
  NESVO_CODEX_EXECUTABLE: resolve('apps/host/tests/codex-fixture.mjs'),
  NESVO_CODEX_FIXTURE_PID_FILE: codexPidFile,
  NESVO_CODEX_FIXTURE_PID_DIR: workerPidDirectory,
  NESVO_CODEX_FIXTURE_STATE_DIR: join(directory, 'codex-state'),
};
delete env.ELECTRON_RUN_AS_NODE;
let application;
let hostPid;
const providerPids = new Set();
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitDead = async pid => {
  for (let attempt = 0; attempt < 60 && alive(pid); attempt++) await delay(100);
  assert.equal(alive(pid), false, `Owned process ${pid} must exit`);
  providerPids.delete(pid);
};
try {
  application = await electron.launch({
    executablePath,
    args: process.env.NESVO_PACKAGED_EXECUTABLE
      ? []
      : [resolve('apps/desktop')],
    env,
    timeout: 30000,
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const conversation = page.getByRole('region', {
    name: 'Conversation',
    exact: true,
  });
  const message = text =>
    conversation.getByRole('article').getByText(text, { exact: true });
  const activityFor = runId =>
    conversation.getByRole('region', {
      name: `Activity for run ${runId}`,
      exact: true,
    });
  const runActivities = (session, runId) =>
    session.activities.filter(activity => activity.runId === runId);
  const checkActivityRows = async (runId, activities) => {
    const region = activityFor(runId);
    const toggle = region.getByLabel('Toggle activity', { exact: true });
    if (!(await toggle.evaluate(node => node.closest('details')?.open)))
      await toggle.click();
    for (const group of await region.getByLabel(/^Toggle .+ activity$/).all()) {
      if (!(await group.evaluate(node => node.closest('details')?.open)))
        await group.click();
    }
    await region
      .locator('[data-activity-id]')
      .first()
      .waitFor({ state: 'visible' });
    const rendered = await region
      .locator('[data-activity-id]')
      .evaluateAll(rows =>
        rows.map(row => ({
          id: row.getAttribute('data-activity-id'),
          kind: row.getAttribute('data-activity-kind'),
          status: row.getAttribute('data-activity-status'),
        })),
      );
    assert.deepEqual(
      rendered.toSorted((left, right) => left.id.localeCompare(right.id)),
      activities
        .map(({ id, kind, status }) => ({ id, kind, status }))
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    );
  };
  const openInbox = async () => {
    await page.getByRole('button', { name: /^Inbox/ }).click();
    await page.getByRole('region', { name: 'Inbox', exact: true }).waitFor();
  };
  const screenshot = async suffix => {
    if (!process.env.NESVO_SCREENSHOT) return;
    await page.evaluate(
      () =>
        new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const encoded = await application.evaluate(async ({ BrowserWindow }) => {
      const image =
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(
          undefined,
          { stayHidden: true, stayAwake: true },
        );
      return image.toPNG().toString('base64');
    });
    await writeFile(
      process.env.NESVO_SCREENSHOT.replace(/\.png$/, suffix + '.png'),
      Buffer.from(encoded, 'base64'),
    );
  };
  const waitState = async (id, status) => {
    const deadline = Date.now() + 20_000;
    let session;
    while (Date.now() < deadline) {
      session = await page.evaluate(
        async id =>
          (await window.nesvo.listSessions()).find(
            session => session.id === id,
          ),
        id,
      );
      if (session?.status === status) return session;
      await delay(100);
    }
    assert.fail(`Session ${id} expected ${status}: ${JSON.stringify(session)}`);
  };
  const send = async text => {
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(text);
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
  };
  const waitReview = async (sessionId, afterVersion = 0) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const reviews = await page.evaluate(() => window.nesvo.listReviews());
      const review = reviews.find(
        review =>
          review.sessionId === sessionId &&
          review.version > afterVersion &&
          review.status === 'pending',
      );
      if (review) return review;
      await delay(100);
    }
    assert.fail(
      `No pending review for session ${sessionId} after version ${afterVersion}`,
    );
  };
  const waitOwned = async (provider = 'Claude Code') => {
    await conversation
      .getByRole('article')
      .getByText(
        provider === 'Codex'
          ? 'Codex fixture is waiting.'
          : 'Fixture is waiting.',
        { exact: true },
      )
      .last()
      .waitFor();
    const pids = JSON.parse(
      await readFile(
        provider === 'Codex' ? codexPidFile : providerPidFile,
        'utf8',
      ),
    );
    providerPids.add(pids.pid);
    providerPids.add(pids.childPid);
    return pids;
  };
  await page.getByRole('button', { name: 'Open context', exact: true }).click();
  const initialContext = page.getByRole('dialog', {
    name: 'Context',
    exact: true,
  });
  await initialContext
    .getByRole('status')
    .filter({ hasText: 'Connected to local host' })
    .waitFor();
  await initialContext
    .getByRole('button', { name: 'Refresh connection', exact: true })
    .click();
  await initialContext
    .getByRole('status')
    .filter({ hasText: 'Connected to local host' })
    .waitFor();
  await page.keyboard.press('Escape');
  await initialContext.waitFor({ state: 'hidden' });
  assert.equal(
    await page
      .getByRole('status')
      .filter({ hasText: 'Connected to local host' })
      .count(),
    0,
  );
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(
    await application.evaluate(
      ({ nativeTheme }) => nativeTheme.shouldUseDarkColors,
    ),
    true,
  );
  const versions = await application.evaluate(() => process.versions);
  hostPid = JSON.parse(await readFile(pidFile, 'utf8')).host;
  assert.equal(typeof hostPid, 'number');
  await page
    .getByRole('button', { name: 'New session', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'New session', exact: true });
  await dialog
    .getByRole('textbox', { name: 'Session name' })
    .fill('Prototype analysis');
  await page.waitForFunction(
    async () => (await window.nesvo.claudeStatus()).status === 'ready',
  );
  await dialog.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'Sonnet', exact: true }).click();
  assert.equal(
    await dialog
      .getByRole('combobox', { name: 'Provider', exact: true })
      .isDisabled(),
    false,
  );
  await screenshot('-new-session');
  await dialog
    .getByRole('button', { name: 'Create session', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Prototype analysis', exact: true, level: 1 })
    .waitFor();
  const first = (await page.evaluate(() => window.nesvo.listSessions()))[0];
  assert.equal(first.model, 'sonnet');
  assert.equal(first.messages.length, 0);
  await screenshot('-empty-session');
  await send('fixture:stream');
  await message('Fixture streamed reply.').waitFor();
  const firstCompleted = await waitState(first.id, 'completed');
  assert.equal(firstCompleted.actualModel, 'fixture-sonnet');
  assert.equal(firstCompleted.messages.at(-1).body, 'Fixture streamed reply.');
  assert.equal(firstCompleted.messages.at(-1).state, 'completed');
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('First session draft');
  await page
    .getByRole('button', { name: 'New session', exact: true })
    .first()
    .click();
  await dialog
    .getByRole('textbox', { name: 'Session name' })
    .fill('Workspace analysis');
  await dialog
    .getByRole('textbox', { name: /Working directory/ })
    .fill(join(directory, 'missing'));
  await dialog
    .getByRole('button', { name: 'Create session', exact: true })
    .click();
  await dialog.getByRole('alert').waitFor();
  await dialog
    .getByRole('textbox', { name: /Working directory/ })
    .fill(directory);
  await dialog
    .getByRole('button', { name: 'Create session', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Workspace analysis', exact: true, level: 1 })
    .waitFor();
  const navigation = page.getByRole('navigation', { name: 'Sessions' });
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .inputValue(),
    'First session draft',
  );
  await page.reload();
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await message('Fixture streamed reply.').waitFor();
  await send('fixture:continue');
  await message('Fixture resumed reply.').waitFor();
  await waitState(first.id, 'completed');
  await screenshot('');
  await send('fixture:hold');
  const stopped = await waitOwned();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await waitState(first.id, 'stopped');
  await Promise.all([waitDead(stopped.pid), waitDead(stopped.childPid)]);
  await send('fixture:fail');
  await page
    .getByRole('alert')
    .filter({ hasText: 'Fixture account limit reached.' })
    .waitFor();
  await waitState(first.id, 'failed');
  await screenshot('-failure');
  await page
    .getByRole('button', { name: 'New session', exact: true })
    .first()
    .click();
  await dialog
    .getByRole('textbox', { name: 'Session name' })
    .fill('Supervised Codex');
  await dialog.getByRole('combobox', { name: 'Provider', exact: true }).click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await page.waitForFunction(
    async () => (await window.nesvo.codexStatus()).status === 'ready',
  );
  await dialog.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page
    .getByRole('option', { name: 'Codex fixture', exact: true })
    .click();
  assert.equal(
    await dialog.getByRole('combobox', { name: /role/i }).count(),
    0,
  );
  assert.equal(
    await dialog
      .getByRole('combobox', { name: 'Access', exact: true })
      .isDisabled(),
    false,
  );
  await dialog.getByRole('combobox', { name: 'Access', exact: true }).click();
  await page
    .getByRole('option', { name: 'Workspace edits', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: 'Create session', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Supervised Codex', exact: true, level: 1 })
    .waitFor();
  const codex = (await page.evaluate(() => window.nesvo.listSessions())).find(
    session => session.title === 'Supervised Codex',
  );
  assert.equal(codex.provider, 'Codex');
  assert.equal(codex.model, 'fixture-codex');
  assert.equal(codex.mode, 'supervised');
  assert.equal(codex.role, 'standalone');
  assert.equal(codex.delegationEnabled, true);
  await send('fixture:stream');
  await message('Codex fixture streamed reply.').waitFor();
  const codexCompleted = await waitState(codex.id, 'completed');
  assert.equal(codexCompleted.actualModel, 'fixture-codex');
  assert.equal(
    codexCompleted.messages.at(-1).body,
    'Codex fixture streamed reply.',
  );
  assert.equal(codexCompleted.messages.at(-1).state, 'completed');
  const completedActivities = runActivities(
    codexCompleted,
    codexCompleted.runId,
  );
  assert.ok(completedActivities.length >= 2);
  assert.deepEqual(
    completedActivities.map(activity => activity.kind).toSorted(),
    ['command', 'read'],
  );
  for (const activity of completedActivities) {
    assert.equal(activity.status, 'completed');
    assert.ok(
      Date.parse(activity.completedAt) >= Date.parse(activity.startedAt),
    );
  }
  await activityFor(codexCompleted.runId)
    .getByText(/^Worked for/)
    .waitFor();
  assert.match(
    await activityFor(codexCompleted.runId)
      .getByLabel('Toggle activity', { exact: true })
      .innerText(),
    /Worked for/,
  );
  await checkActivityRows(codexCompleted.runId, completedActivities);
  const approval = page.getByRole('region', {
    name: 'Operation approval',
    exact: true,
  });
  await send('fixture:approve');
  await approval.waitFor();
  await approval.getByText(/fixture write approved marker/).waitFor();
  const approvalTarget = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === codex.id);
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await page
    .getByRole('heading', { name: 'Prototype analysis', exact: true, level: 1 })
    .waitFor();
  const unrelatedBeforeApproval = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === first.id);
  await openInbox();
  const operationRow = page.getByRole('article', {
    name: `Operation approval: ${codex.title}`,
    exact: true,
  });
  await operationRow.getByText(/fixture write approved marker/).waitFor();
  await screenshot('-approval');
  await operationRow.getByRole('button', { name: 'Deny', exact: true }).click();
  const declinedOperation = await waitState(codex.id, 'completed');
  assert.equal(declinedOperation.runId, approvalTarget.runId);
  assert.equal(
    declinedOperation.messages.at(-1).body,
    'Codex fixture command declined.',
  );
  assert.deepEqual(
    (await page.evaluate(() => window.nesvo.listSessions())).find(
      session => session.id === first.id,
    ),
    unrelatedBeforeApproval,
  );
  await operationRow.waitFor({ state: 'hidden' });
  await navigation.getByRole('button', { name: /^Supervised Codex/ }).click();
  await message('Codex fixture command declined.').waitFor();
  await send('fixture:file');
  await approval.waitFor();
  await approval
    .getByRole('button', { name: 'Allow once', exact: true })
    .click();
  await message('Codex fixture file accepted.').waitFor();
  await waitState(codex.id, 'completed');
  await page.reload();
  await navigation.getByRole('button', { name: /^Supervised Codex/ }).click();
  const restoredActivitySession = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === codex.id);
  assert.deepEqual(
    runActivities(restoredActivitySession, codexCompleted.runId),
    completedActivities,
  );
  await message('Codex fixture file accepted.').waitFor();
  await send('fixture:continue');
  await message('Codex fixture resumed reply.').waitFor();
  const codexResumed = await waitState(codex.id, 'completed');
  assert.equal(
    codexResumed.providerSessionId,
    codexCompleted.providerSessionId,
  );
  assert.equal(
    codexResumed.messages.at(-1).body,
    'Codex fixture resumed reply.',
  );
  await send('fixture:approval-hold');
  await approval.waitFor();
  const codexStopped = await waitOwned('Codex');
  const beforeActivityStop = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === codex.id);
  const runningActivities = runActivities(
    beforeActivityStop,
    beforeActivityStop.runId,
  );
  assert.ok(
    runningActivities.some(
      activity =>
        activity.status === 'running' && activity.completedAt === null,
    ),
  );
  assert.match(
    await activityFor(beforeActivityStop.runId)
      .getByLabel('Toggle activity', { exact: true })
      .innerText(),
    /Working for/,
  );
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const codexStoppedSession = await waitState(codex.id, 'stopped');
  assert.equal(codexStoppedSession.messages.at(-1).state, 'stopped');
  assert.deepEqual(codexStoppedSession.pendingApprovals, []);
  const stoppedActivities = runActivities(
    codexStoppedSession,
    beforeActivityStop.runId,
  );
  for (const running of runningActivities.filter(
    activity => activity.status === 'running',
  )) {
    const stopped = stoppedActivities.find(
      activity => activity.id === running.id,
    );
    assert.equal(stopped.status, 'stopped');
    assert.ok(Date.parse(stopped.completedAt) >= Date.parse(stopped.startedAt));
  }
  assert.ok(
    Date.parse(codexStoppedSession.messages.at(-1).completedAt) >=
      Date.parse(codexStoppedSession.messages.at(-1).createdAt),
  );
  await activityFor(beforeActivityStop.runId)
    .getByText(/^Stopped after/)
    .waitFor();
  const stoppedActivitySummary = await activityFor(beforeActivityStop.runId)
    .getByLabel('Toggle activity', { exact: true })
    .innerText();
  assert.match(stoppedActivitySummary, /Stopped after/);
  await approval.waitFor({ state: 'hidden' });
  await Promise.all([
    waitDead(codexStopped.pid),
    waitDead(codexStopped.childPid),
  ]);
  assert.deepEqual(
    await page.evaluate(
      async id =>
        (await window.nesvo.listSessions()).find(session => session.id === id)
          .pendingApprovals,
      codex.id,
    ),
    [],
  );
  await page.reload();
  await navigation.getByRole('button', { name: /^Supervised Codex/ }).click();
  const restoredStoppedSession = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === codex.id);
  assert.deepEqual(
    runActivities(restoredStoppedSession, beforeActivityStop.runId),
    stoppedActivities,
  );
  assert.equal(
    restoredStoppedSession.messages.at(-1).completedAt,
    codexStoppedSession.messages.at(-1).completedAt,
  );
  await checkActivityRows(beforeActivityStop.runId, stoppedActivities);
  assert.equal(
    await activityFor(beforeActivityStop.runId)
      .getByLabel('Toggle activity', { exact: true })
      .innerText(),
    stoppedActivitySummary,
  );
  await page
    .getByRole('button', { name: 'New session', exact: true })
    .first()
    .click();
  await dialog
    .getByRole('textbox', { name: 'Session name' })
    .fill('Prototype orchestration');
  await dialog.getByRole('combobox', { name: 'Provider', exact: true }).click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page
    .getByRole('option', { name: 'Codex fixture', exact: true })
    .click();
  assert.equal(
    await dialog
      .getByRole('combobox', { name: 'Access', exact: true })
      .isDisabled(),
    false,
  );
  await dialog.getByRole('combobox', { name: 'Access', exact: true }).click();
  await page.getByRole('option', { name: 'Read-only', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'Create session', exact: true })
    .click();
  await page
    .getByRole('heading', {
      name: 'Prototype orchestration',
      exact: true,
      level: 1,
    })
    .waitFor();
  const orchestrator = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.title === 'Prototype orchestration');
  assert.equal(orchestrator.delegationEnabled, true);
  const proposal = title =>
    page
      .getByRole('region', { name: 'Worker proposal', exact: true })
      .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await send('fixture:delegate');
  await proposal('Fixture worker A').waitFor();
  await proposal('Fixture worker B').waitFor();
  assert.equal(
    (await page.evaluate(() => window.nesvo.listSessions())).filter(
      session => session.parentId === orchestrator.id,
    ).length,
    0,
  );
  await screenshot('-delegation');
  const delegationTarget = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === orchestrator.id);
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await page
    .getByRole('heading', { name: 'Prototype analysis', exact: true, level: 1 })
    .waitFor();
  const unrelatedBeforeDelegation = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === first.id);
  await openInbox();
  const workerRow = title =>
    page.getByRole('article', {
      name: `Start worker: ${title}`,
      exact: true,
    });
  await workerRow('Fixture worker A')
    .getByRole('button', { name: 'Approve worker', exact: true })
    .click();
  await workerRow('Fixture worker B')
    .getByRole('button', { name: 'Decline', exact: true })
    .click();
  const firstDelegation = await waitState(orchestrator.id, 'completed');
  assert.equal(firstDelegation.role, 'orchestrator');
  assert.equal(firstDelegation.runId, delegationTarget.runId);
  assert.deepEqual(
    (await page.evaluate(() => window.nesvo.listSessions())).find(
      session => session.id === first.id,
    ),
    unrelatedBeforeDelegation,
  );
  const delegationResult = JSON.parse(
    firstDelegation.messages
      .at(-1)
      .body.slice('Codex delegation results: '.length),
  );
  assert.deepEqual(
    delegationResult.results.map(result => result.status),
    ['completed', 'declined'],
  );
  assert.match(delegationResult.results[0].text, /worker a completed/);
  await navigation
    .getByRole('button', { name: /^Prototype orchestration/ })
    .click();
  await proposal('Fixture worker A')
    .getByRole('button', { name: 'Open worker session', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Fixture worker A', exact: true, level: 1 })
    .waitFor();
  await message('Codex worker a completed its scoped task.').waitFor();
  await page
    .getByRole('button', { name: 'Back to parent session', exact: true })
    .click();
  await page
    .getByRole('heading', {
      name: 'Prototype orchestration',
      exact: true,
      level: 1,
    })
    .waitFor();
  const waitWorkers = async runId => {
    const deadline = Date.now() + 20_000;
    let children = [];
    while (Date.now() < deadline) {
      children = await page.evaluate(
        async ({ id, runId }) =>
          (await window.nesvo.listSessions()).filter(
            session => session.parentId === id && session.parentRunId === runId,
          ),
        { id: orchestrator.id, runId },
      );
      if (
        children.length === 2 &&
        children.every(
          child =>
            child.status === 'running' &&
            child.messages.at(-1).body.includes('is waiting.'),
        )
      )
        break;
      await delay(100);
    }
    assert.equal(children.length, 2);
    for (const child of children) {
      assert.equal(child.status, 'running');
      assert.equal(child.delegationEnabled, false);
      const pids = JSON.parse(
        await readFile(
          join(workerPidDirectory, `${child.providerSessionId}.json`),
          'utf8',
        ),
      );
      assert.ok(alive(pids.pid));
      assert.ok(alive(pids.childPid));
      providerPids.add(pids.pid);
      providerPids.add(pids.childPid);
      child.fixturePids = [pids.pid, pids.childPid];
    }
    return children;
  };
  const launchWorkers = async () => {
    await send('fixture:delegate-two-hold');
    await proposal('Fixture worker A')
      .getByRole('button', { name: 'Approve worker', exact: true })
      .waitFor();
    const current = (
      await page.evaluate(() => window.nesvo.listSessions())
    ).find(session => session.id === orchestrator.id);
    await proposal('Fixture worker A')
      .getByRole('button', { name: 'Approve worker', exact: true })
      .click();
    await proposal('Fixture worker B')
      .getByRole('button', { name: 'Approve worker', exact: true })
      .click();
    return { parent: current, children: await waitWorkers(current.runId) };
  };
  const concurrent = await launchWorkers();
  const childA = concurrent.children.find(
    child => child.title === 'Fixture worker A',
  );
  const childB = concurrent.children.find(
    child => child.title === 'Fixture worker B',
  );
  await screenshot('-workers');
  await proposal('Fixture worker A')
    .getByRole('button', { name: 'Open worker session', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Fixture worker A', exact: true, level: 1 })
    .waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await waitState(childA.id, 'stopped');
  await Promise.all(childA.fixturePids.map(waitDead));
  const sibling = (await page.evaluate(() => window.nesvo.listSessions())).find(
    session => session.id === childB.id,
  );
  assert.equal(sibling.status, 'running');
  for (const pid of childB.fixturePids) assert.ok(alive(pid));
  await page
    .getByRole('button', { name: 'Back to parent session', exact: true })
    .click();
  await page.getByRole('button', { name: 'Stop group', exact: true }).click();
  await waitState(orchestrator.id, 'stopped');
  await waitState(childB.id, 'stopped');
  await Promise.all(childB.fixturePids.map(waitDead));
  await page.reload();
  await navigation
    .getByRole('button', { name: /^Prototype orchestration/ })
    .click();
  const reloadedGroup = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === orchestrator.id);
  assert.equal(reloadedGroup.status, 'stopped');
  assert.ok(
    reloadedGroup.delegations
      .filter(item => item.runId === concurrent.parent.runId)
      .every(item => item.status === 'stopped'),
  );
  const reviewDirectory = join(directory, 'review-workspace');
  await mkdir(reviewDirectory);
  await Promise.all([
    writeFile(join(reviewDirectory, 'tracked.txt'), 'user dirty baseline\n'),
    writeFile(join(reviewDirectory, 'deleted.txt'), 'delete this baseline\n'),
    writeFile(join(reviewDirectory, 'dirty.txt'), 'unrelated operator edits\n'),
  ]);
  await page
    .getByRole('button', { name: 'New session', exact: true })
    .first()
    .click();
  await dialog
    .getByRole('textbox', { name: 'Session name' })
    .fill('Review changes');
  await dialog.getByRole('combobox', { name: 'Provider', exact: true }).click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page
    .getByRole('option', { name: 'Codex fixture', exact: true })
    .click();
  await dialog.getByRole('combobox', { name: 'Access', exact: true }).click();
  await page
    .getByRole('option', { name: 'Workspace edits', exact: true })
    .click();
  await dialog
    .getByRole('textbox', { name: /Working directory/ })
    .fill(reviewDirectory);
  await dialog
    .getByRole('button', { name: 'Create session', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Review changes', exact: true, level: 1 })
    .waitFor();
  const writingSession = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.title === 'Review changes');
  await send('fixture:review-write');
  const initialFiles = await waitState(writingSession.id, 'completed');
  assert.equal(
    initialFiles.messages.at(-1).body,
    'Codex fixture initial files.',
  );
  const initialReview = await waitReview(writingSession.id);
  assert.equal(
    initialReview.diff.status,
    'complete',
    initialReview.diff.detail,
  );
  assert.equal(initialReview.diff.files.length, 3);
  const reviewRow = review =>
    page.getByRole('article', {
      name: `Review result: Review changes, version ${review.version}`,
      exact: true,
    });
  const reviewPanel = review => conversation.locator(`#review-${review.id}`);
  const diffPanel = page.getByRole('region', {
    name: 'Saved result diff',
    exact: true,
  });
  const openSavedDiff = async (review, before, after) => {
    const opener = reviewPanel(review).getByRole('button', {
      name: `View diff for version ${review.version}`,
      exact: true,
    });
    await opener.click();
    await diffPanel.waitFor();
    assert.equal(await diffPanel.getAttribute('data-review-id'), review.id);
    assert.equal(
      await diffPanel.getAttribute('data-review-version'),
      String(review.version),
    );
    await diffPanel
      .getByRole('button', { name: 'View changes in tracked.txt', exact: true })
      .click();
    const viewer = diffPanel.getByTestId('saved-diff-content');
    const removedLine = viewer
      .locator('[data-line][data-line-type="change-deletion"]')
      .filter({ hasText: before });
    const addedLine = viewer
      .locator('[data-line][data-line-type="change-addition"]')
      .filter({ hasText: after });
    await removedLine.waitFor({ state: 'visible' });
    await addedLine.waitFor({ state: 'visible' });
    assert.ok(Number(await removedLine.getAttribute('data-line')) > 0);
    assert.ok(Number(await addedLine.getAttribute('data-line')) > 0);
    await viewer
      .locator('[data-line-number-content]')
      .first()
      .waitFor({ state: 'visible' });
    assert.equal(await viewer.getAttribute('data-file-path'), 'tracked.txt');
    assert.equal(
      await diffPanel
        .getByRole('button', {
          name: 'View changes in tracked.txt',
          exact: true,
        })
        .getAttribute('aria-pressed'),
      'true',
    );
    const savedPatch = diffPanel.getByLabel('Saved patch', { exact: true });
    if (!(await savedPatch.isVisible()))
      await diffPanel.getByText('Raw patch', { exact: true }).click();
    const patch = await savedPatch.innerText();
    assert.ok(patch.includes('tracked.txt'));
    assert.ok(patch.split('\n').includes(`-${before}`));
    assert.ok(patch.split('\n').includes(`+${after}`));
    return { opener, patch };
  };
  const closeSavedDiff = async opener => {
    await page.keyboard.press('Escape');
    await diffPanel.waitFor({ state: 'hidden' });
    const deadline = Date.now() + 2000;
    while (
      !(await opener.evaluate(node => node === document.activeElement)) &&
      Date.now() < deadline
    )
      await delay(25);
    assert.equal(
      await opener.evaluate(node => node === document.activeElement),
      true,
    );
  };
  const openReviewSession = async review => {
    await reviewRow(review)
      .getByRole('button', {
        name: 'Open session: Review changes',
        exact: true,
      })
      .click();
    await page
      .getByRole('heading', { name: 'Review changes', exact: true, level: 1 })
      .waitFor();
    await conversation.locator(`#review-${review.id}[open]`).waitFor();
    assert.notEqual(await reviewPanel(review).getAttribute('open'), null);
    assert.equal(
      await navigation
        .getByRole('button', { name: /^Review changes/ })
        .getAttribute('aria-current'),
      'page',
    );
  };
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await page
    .getByRole('heading', { name: 'Prototype analysis', exact: true, level: 1 })
    .waitFor();
  await openInbox();
  await reviewRow(initialReview).waitFor();
  await screenshot('-inbox');
  await openReviewSession(initialReview);
  const initialDiff = await openSavedDiff(
    initialReview,
    'user dirty baseline',
    'initial agent text',
  );
  assert.doesNotMatch(
    initialDiff.patch,
    /dirty\.txt|unrelated operator edits|\.nesvo-codex/,
  );
  await screenshot('-review');
  await closeSavedDiff(initialDiff.opener);
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await page
    .getByRole('heading', { name: 'Prototype analysis', exact: true, level: 1 })
    .waitFor();
  await openInbox();
  await reviewRow(initialReview)
    .getByRole('button', { name: 'Request changes', exact: true })
    .click();
  assert.equal(
    await reviewRow(initialReview)
      .getByRole('button', { name: 'Send feedback', exact: true })
      .isDisabled(),
    true,
  );
  const feedback = 'fixture:review-correct Please correct the result.';
  await reviewRow(initialReview)
    .getByRole('textbox', { name: 'Feedback', exact: true })
    .fill(feedback);
  await screenshot('-inline-feedback');
  await reviewRow(initialReview)
    .getByRole('button', { name: 'Send feedback', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Review changes', exact: true, level: 1 })
    .waitFor();
  await message('Codex fixture corrected files.').waitFor();
  const correctedFiles = await waitState(writingSession.id, 'completed');
  assert.equal(
    correctedFiles.providerSessionId,
    initialFiles.providerSessionId,
  );
  const correctedReview = await waitReview(
    writingSession.id,
    initialReview.version,
  );
  assert.equal(correctedReview.decision, null);
  await openInbox();
  await openReviewSession(correctedReview);
  if ((await reviewPanel(initialReview).getAttribute('open')) === null) {
    await reviewPanel(initialReview)
      .getByLabel(`Open version ${initialReview.version}`, { exact: true })
      .click();
    await conversation.locator(`#review-${initialReview.id}[open]`).waitFor();
  }
  const staleAccept = reviewPanel(initialReview).getByRole('button', {
    name: 'Accept result',
    exact: true,
  });
  if (await staleAccept.count())
    assert.equal(await staleAccept.isDisabled(), true);
  await reviewPanel(initialReview)
    .getByRole('paragraph')
    .filter({ hasText: feedback })
    .waitFor();
  const historicalDiff = await openSavedDiff(
    initialReview,
    'user dirty baseline',
    'initial agent text',
  );
  assert.doesNotMatch(historicalDiff.patch, /corrected agent text/);
  await closeSavedDiff(historicalDiff.opener);
  const correctedDiff = await openSavedDiff(
    correctedReview,
    'initial agent text',
    'corrected agent text',
  );
  await screenshot('-correction');
  await closeSavedDiff(correctedDiff.opener);
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await page
    .getByRole('heading', { name: 'Prototype analysis', exact: true, level: 1 })
    .waitFor();
  await openInbox();
  await reviewRow(correctedReview)
    .getByRole('button', { name: 'Accept result', exact: true })
    .click();
  await reviewRow(correctedReview).waitFor({ state: 'hidden' });
  assert.equal(
    await readFile(join(reviewDirectory, 'dirty.txt'), 'utf8'),
    'unrelated operator edits\n',
  );
  await page.reload();
  await openInbox();
  await page.getByRole('combobox', { name: 'View', exact: true }).click();
  await page.getByRole('option', { name: 'History', exact: true }).click();
  await reviewRow(correctedReview)
    .getByText(`Result · v${correctedReview.version} · Accepted`, {
      exact: true,
    })
    .waitFor();
  const persistedReview = (
    await page.evaluate(() => window.nesvo.listReviews())
  ).find(review => review.id === correctedReview.id);
  assert.equal(persistedReview.status, 'accepted');
  assert.equal(persistedReview.decision.decision, 'accept');
  await screenshot('-accepted');
  await openReviewSession(correctedReview);
  await reviewPanel(correctedReview)
    .getByText('Accepted', { exact: true })
    .waitFor();
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await page
    .getByRole('button', { name: 'New session', exact: true })
    .first()
    .click();
  await dialog
    .getByRole('textbox', { name: 'Session name' })
    .fill('Cancelled session');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(
    await navigation.getByRole('button', { name: /Cancelled session/ }).count(),
    0,
  );
  await page
    .getByRole('textbox', { name: 'Search sessions' })
    .fill('nonexistent session');
  await page.getByText('No matching sessions.').waitFor();
  await page.getByRole('textbox', { name: 'Search sessions' }).fill('');
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(720, 700),
  );
  await page.getByRole('button', { name: 'Open sessions' }).click();
  const sidebar = page.getByRole('dialog', { name: 'Navigation', exact: true });
  await screenshot('-navigation');
  await sidebar.getByRole('button', { name: /^Workspace analysis/ }).click();
  await sidebar.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Open context' }).click();
  const details = page.getByRole('dialog', {
    name: 'Context',
    exact: true,
  });
  await details.getByText(directory, { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.getByRole('button', { name: 'Open sessions' }).click();
  await sidebar.getByRole('button', { name: /^Review changes/ }).click();
  await sidebar.waitFor({ state: 'hidden' });
  if ((await reviewPanel(correctedReview).getAttribute('open')) === null) {
    await reviewPanel(correctedReview)
      .getByLabel(`Open version ${correctedReview.version}`, { exact: true })
      .click();
  }
  const compactDiff = await openSavedDiff(
    correctedReview,
    'initial agent text',
    'corrected agent text',
  );
  const bounds = await diffPanel.boundingBox();
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewportWidth + 1);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await screenshot('-compact');
  await closeSavedDiff(compactDiff.opener);
  await page.getByRole('button', { name: 'Open sessions' }).click();
  await sidebar
    .getByRole('button', { name: /^Prototype orchestration/ })
    .click();
  await sidebar.waitFor({ state: 'hidden' });
  await launchWorkers();
  assert.deepEqual(errors, []);
  await application.close();
  application = undefined;
  const closedHostPid = hostPid;
  await Promise.all([...providerPids, hostPid].map(waitDead));
  hostPid = undefined;
  console.log(
    JSON.stringify({
      result: 'passed',
      provider: 'Claude Code and Codex delegation fixtures',
      platform: process.platform,
      electron: versions.electron,
      node: versions.node,
      hostPid: closedHostPid,
    }),
  );
} finally {
  await application?.close();
  if (hostPid) await waitDead(hostPid);
  await Promise.all([...providerPids].map(waitDead));
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
