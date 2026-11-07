import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
      .getByRole('textbox', { name: 'Wiadomość', exact: true })
      .fill(text);
    await page
      .getByRole('button', { name: 'Wyślij wiadomość', exact: true })
      .click();
  };
  const waitOwned = async (provider = 'Claude Code') => {
    await page
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
  await page
    .getByRole('status')
    .filter({ hasText: 'Połączono z lokalnym hostem' })
    .waitFor();
  await page.getByRole('button', { name: 'Odśwież połączenie' }).click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Połączono z lokalnym hostem' })
    .waitFor();
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
    .getByRole('button', { name: 'Nowa sesja', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Nowa sesja', exact: true });
  await dialog
    .getByRole('textbox', { name: 'Nazwa sesji' })
    .fill('Analiza prototypu');
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
    .getByRole('button', { name: 'Utwórz sesję', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Analiza prototypu', exact: true })
    .waitFor();
  const first = (await page.evaluate(() => window.nesvo.listSessions()))[0];
  assert.equal(first.model, 'sonnet');
  assert.equal(first.messages.length, 0);
  await send('fixture:stream');
  await page.getByText('Fixture streamed reply.', { exact: true }).waitFor();
  const firstCompleted = await waitState(first.id, 'completed');
  assert.equal(firstCompleted.actualModel, 'fixture-sonnet');
  assert.equal(firstCompleted.messages.at(-1).body, 'Fixture streamed reply.');
  assert.equal(firstCompleted.messages.at(-1).state, 'completed');
  await page
    .getByRole('textbox', { name: 'Wiadomość', exact: true })
    .fill('Szkic pierwszej sesji');
  await page
    .getByRole('button', { name: 'Nowa sesja', exact: true })
    .first()
    .click();
  await dialog
    .getByRole('textbox', { name: 'Nazwa sesji' })
    .fill('Analiza w katalogu');
  await dialog
    .getByRole('textbox', { name: /Katalog pracy/ })
    .fill(join(directory, 'missing'));
  await dialog
    .getByRole('button', { name: 'Utwórz sesję', exact: true })
    .click();
  await dialog.getByRole('alert').waitFor();
  await dialog.getByRole('textbox', { name: /Katalog pracy/ }).fill(directory);
  await dialog
    .getByRole('button', { name: 'Utwórz sesję', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Analiza w katalogu', exact: true })
    .waitFor();
  const navigation = page.getByRole('navigation', { name: 'Sesje' });
  await navigation.getByRole('button', { name: /^Analiza prototypu/ }).click();
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Wiadomość', exact: true })
      .inputValue(),
    'Szkic pierwszej sesji',
  );
  await page.reload();
  await navigation.getByRole('button', { name: /^Analiza prototypu/ }).click();
  await page.getByText('Fixture streamed reply.', { exact: true }).waitFor();
  await send('fixture:continue');
  await page.getByText('Fixture resumed reply.', { exact: true }).waitFor();
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
    .getByRole('button', { name: 'Nowa sesja', exact: true })
    .first()
    .click();
  await dialog
    .getByRole('textbox', { name: 'Nazwa sesji' })
    .fill('Codex nadzorowany');
  await dialog.getByRole('combobox', { name: 'Provider', exact: true }).click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await page.waitForFunction(
    async () => (await window.nesvo.codexStatus()).status === 'ready',
  );
  await dialog.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page
    .getByRole('option', { name: 'Codex fixture', exact: true })
    .click();
  await dialog
    .getByRole('combobox', { name: 'Rola sesji', exact: true })
    .click();
  await page
    .getByRole('option', { name: 'Samodzielna sesja', exact: true })
    .click();
  await dialog
    .getByRole('combobox', { name: 'Tryb pracy', exact: true })
    .click();
  await page
    .getByRole('option', { name: 'Praca nadzorowana', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: 'Utwórz sesję', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Codex nadzorowany', exact: true })
    .waitFor();
  const codex = (await page.evaluate(() => window.nesvo.listSessions())).find(
    session => session.title === 'Codex nadzorowany',
  );
  assert.equal(codex.provider, 'Codex');
  assert.equal(codex.model, 'fixture-codex');
  assert.equal(codex.mode, 'supervised');
  await send('fixture:stream');
  await page
    .getByText('Codex fixture streamed reply.', { exact: true })
    .waitFor();
  const codexCompleted = await waitState(codex.id, 'completed');
  assert.equal(codexCompleted.actualModel, 'fixture-codex');
  assert.equal(
    codexCompleted.messages.at(-1).body,
    'Codex fixture streamed reply.',
  );
  assert.equal(codexCompleted.messages.at(-1).state, 'completed');
  const approval = page.getByRole('region', {
    name: 'Zgoda operatora',
    exact: true,
  });
  await send('fixture:approve');
  await approval.waitFor();
  await approval.getByText(/fixture write approved marker/).waitFor();
  await screenshot('-approval');
  await approval.getByRole('button', { name: 'Odmów', exact: true }).click();
  await page
    .getByText('Codex fixture command declined.', { exact: true })
    .waitFor();
  await waitState(codex.id, 'completed');
  await approval.waitFor({ state: 'hidden' });
  await send('fixture:file');
  await approval.waitFor();
  await approval
    .getByRole('button', { name: 'Zezwól jednorazowo', exact: true })
    .click();
  await page
    .getByText('Codex fixture file accepted.', { exact: true })
    .waitFor();
  await waitState(codex.id, 'completed');
  await page.reload();
  await navigation.getByRole('button', { name: /^Codex nadzorowany/ }).click();
  await page
    .getByText('Codex fixture file accepted.', { exact: true })
    .waitFor();
  await send('fixture:continue');
  await page
    .getByText('Codex fixture resumed reply.', { exact: true })
    .waitFor();
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
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const codexStoppedSession = await waitState(codex.id, 'stopped');
  assert.equal(codexStoppedSession.messages.at(-1).state, 'stopped');
  assert.deepEqual(codexStoppedSession.pendingApprovals, []);
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
  await page
    .getByRole('button', { name: 'Nowa sesja', exact: true })
    .first()
    .click();
  await dialog
    .getByRole('textbox', { name: 'Nazwa sesji' })
    .fill('Orkiestracja prototypu');
  await dialog.getByRole('combobox', { name: 'Provider', exact: true }).click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page
    .getByRole('option', { name: 'Codex fixture', exact: true })
    .click();
  await dialog
    .getByRole('combobox', { name: 'Rola sesji', exact: true })
    .click();
  await page.getByRole('option', { name: 'Orkiestrator', exact: true }).click();
  assert.equal(
    await dialog
      .getByRole('combobox', { name: 'Tryb pracy', exact: true })
      .isDisabled(),
    true,
  );
  await dialog
    .getByRole('button', { name: 'Utwórz sesję', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Orkiestracja prototypu', exact: true })
    .waitFor();
  const orchestrator = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.title === 'Orkiestracja prototypu');
  assert.equal(orchestrator.delegationEnabled, true);
  const proposal = title =>
    page
      .getByRole('region', { name: 'Propozycja workera', exact: true })
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
  await proposal('Fixture worker A')
    .getByRole('button', { name: 'Zatwierdź workera', exact: true })
    .click();
  await proposal('Fixture worker B')
    .getByRole('button', { name: 'Odrzuć propozycję', exact: true })
    .click();
  const firstDelegation = await waitState(orchestrator.id, 'completed');
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
  await proposal('Fixture worker A')
    .getByRole('button', { name: 'Otwórz sesję workera', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Fixture worker A', exact: true })
    .waitFor();
  await page
    .getByText('Codex worker a completed its scoped task.', { exact: true })
    .waitFor();
  await page
    .getByRole('button', { name: 'Wróć do orkiestratora', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Orkiestracja prototypu', exact: true })
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
      .getByRole('button', { name: 'Zatwierdź workera', exact: true })
      .waitFor();
    const current = (
      await page.evaluate(() => window.nesvo.listSessions())
    ).find(session => session.id === orchestrator.id);
    await proposal('Fixture worker A')
      .getByRole('button', { name: 'Zatwierdź workera', exact: true })
      .click();
    await proposal('Fixture worker B')
      .getByRole('button', { name: 'Zatwierdź workera', exact: true })
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
    .getByRole('button', { name: 'Otwórz sesję workera', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Fixture worker A', exact: true })
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
    .getByRole('button', { name: 'Wróć do orkiestratora', exact: true })
    .click();
  await page.getByRole('button', { name: 'Stop grupy', exact: true }).click();
  await waitState(orchestrator.id, 'stopped');
  await waitState(childB.id, 'stopped');
  await Promise.all(childB.fixturePids.map(waitDead));
  await page.reload();
  await navigation
    .getByRole('button', { name: /^Orkiestracja prototypu/ })
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
  await page.getByRole('button', { name: 'Do odbioru', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: 'Zaakceptuj wynik' }).count(),
    0,
  );
  await navigation.getByRole('button', { name: /^Analiza prototypu/ }).click();
  await page
    .getByRole('button', { name: 'Nowa sesja', exact: true })
    .first()
    .click();
  await dialog
    .getByRole('textbox', { name: 'Nazwa sesji' })
    .fill('Anulowana sesja');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(
    await navigation.getByRole('button', { name: /Anulowana sesja/ }).count(),
    0,
  );
  await page
    .getByRole('textbox', { name: 'Szukaj sesji' })
    .fill('nieistniejąca sesja');
  await page.getByText('Brak pasujących sesji.').waitFor();
  await page.getByRole('textbox', { name: 'Szukaj sesji' }).fill('');
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(720, 700),
  );
  await page.getByRole('button', { name: 'Otwórz listę sesji' }).click();
  const sidebar = page.getByRole('dialog', { name: 'Nawigacja', exact: true });
  await screenshot('-navigation');
  await sidebar.getByRole('button', { name: /^Analiza w katalogu/ }).click();
  await sidebar.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Pokaż szczegóły sesji' }).click();
  const details = page.getByRole('dialog', {
    name: 'Kontekst sesji',
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
  await screenshot('-compact');
  await page.getByRole('button', { name: 'Otwórz listę sesji' }).click();
  await sidebar
    .getByRole('button', { name: /^Orkiestracja prototypu/ })
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
