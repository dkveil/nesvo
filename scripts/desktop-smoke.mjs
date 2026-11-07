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
  const waitState = async (id, status) =>
    page.waitForFunction(
      async ({ id, status }) =>
        (await window.nesvo.listSessions()).find(session => session.id === id)
          ?.status === status,
      { id, status },
    );
  const send = async text => {
    await page
      .getByRole('textbox', { name: 'Wiadomość', exact: true })
      .fill(text);
    await page
      .getByRole('button', { name: 'Wyślij wiadomość', exact: true })
      .click();
  };
  const waitOwned = async () => {
    await page
      .getByText('Fixture is waiting.', { exact: true })
      .last()
      .waitFor();
    const pids = JSON.parse(await readFile(providerPidFile, 'utf8'));
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
    true,
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
  await waitState(first.id, 'completed');
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
  await send('fixture:hold');
  await waitOwned();
  assert.deepEqual(errors, []);
  await application.close();
  application = undefined;
  await Promise.all([...providerPids, hostPid].map(waitDead));
  console.log(
    JSON.stringify({
      result: 'passed',
      provider: 'fixture',
      platform: process.platform,
      electron: versions.electron,
      node: versions.node,
      hostPid,
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
