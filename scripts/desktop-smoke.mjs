import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

const directory = await mkdtemp(join(tmpdir(), 'nesvo-desktop-'));
const pidFile = join(directory, 'processes.json');
const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
const executablePath =
  process.env.NESVO_PACKAGED_EXECUTABLE || requireDesktop('electron');
const env = {
  ...process.env,
  NESVO_SMOKE_TEST: '1',
  NESVO_DATA_DIR: directory,
  NESVO_TEST_PID_FILE: pidFile,
};
delete env.ELECTRON_RUN_AS_NODE;
let application;
let hostPid;
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
  page.setDefaultTimeout(15000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const screenshot = async suffix => {
    if (process.env.NESVO_SCREENSHOT) {
      const path = process.env.NESVO_SCREENSHOT.replace(
        /\.png$/,
        suffix + '.png',
      );
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
      await writeFile(path, Buffer.from(encoded, 'base64'));
    }
  };
  await page
    .getByRole('status')
    .filter({ hasText: 'Połączono z lokalnym hostem' })
    .waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Odśwież połączenie' }).click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Połączono z lokalnym hostem' })
    .waitFor();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const versions = await application.evaluate(() => process.versions);
  hostPid = JSON.parse(await readFile(pidFile, 'utf8')).host;
  assert.equal(typeof hostPid, 'number');
  await page
    .getByRole('heading', { name: 'Formularz zgłoszeń', exact: true })
    .waitFor();
  await screenshot('');
  const navigation = page.getByRole('navigation', { name: 'Sesje' });
  await page
    .getByRole('textbox', { name: 'Wiadomość', exact: true })
    .fill('Szkic dla orkiestratora');
  await navigation
    .getByRole('button', { name: /Przegląd dostępności/ })
    .click();
  assert.equal(
    await page
      .getByRole('button', { name: 'Zezwól', exact: true })
      .isDisabled(),
    true,
  );
  await navigation.getByRole('button', { name: /^Formularz zgłoszeń/ }).click();
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Wiadomość', exact: true })
      .inputValue(),
    'Szkic dla orkiestratora',
  );
  await page.getByRole('button', { name: 'Otwórz wynik' }).click();
  await page
    .getByRole('button', { name: /^Formularz zgłoszeń z walidacją/ })
    .click();
  await page.getByRole('heading', { name: 'Zmiany w plikach' }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Zaakceptuj wynik' }).isDisabled(),
    true,
  );
  await screenshot('-review');
  await page.getByRole('button', { name: 'Przejdź do sesji' }).click();
  await page
    .getByRole('heading', { name: 'Formularz i walidacja', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Nowa sesja', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Nowa sesja', exact: true });
  await dialog
    .getByRole('textbox', { name: 'Nazwa sesji' })
    .fill('Plan prototypu');
  await dialog.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'Opus', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Provider', exact: true }).click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  assert.equal(
    await dialog
      .getByRole('combobox', { name: 'Model', exact: true })
      .innerText(),
    'Domyślny model',
  );
  await dialog.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option', { name: 'Codex', exact: true }).click();
  await screenshot('-new-session');
  await dialog.getByRole('button', { name: 'Utwórz w podglądzie' }).click();
  await page
    .getByRole('heading', { name: 'Plan prototypu', exact: true })
    .waitFor();
  await page.getByRole('heading', { name: 'Od czego zaczynamy?' }).waitFor();
  await page
    .getByRole('textbox', { name: 'Wiadomość', exact: true })
    .fill('Lokalna wiadomość testowa');
  await page
    .getByRole('button', { name: 'Dodaj wiadomość do podglądu' })
    .click();
  await page.getByText('Lokalna wiadomość testowa', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Nowa sesja', exact: true }).click();
  await dialog
    .getByRole('textbox', { name: 'Nazwa sesji' })
    .fill('Analiza w katalogu');
  await dialog
    .getByRole('textbox', { name: /Katalog pracy/ })
    .fill('/example/project');
  await dialog.getByRole('button', { name: 'Utwórz w podglądzie' }).click();
  await page
    .getByRole('heading', { name: 'Analiza w katalogu', exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Nowa sesja', exact: true }).click();
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
  await sidebar.getByRole('button', { name: /^Formularz zgłoszeń/ }).click();
  await sidebar.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Pokaż szczegóły sesji' }).click();
  const details = page.getByRole('dialog', {
    name: 'Kontekst sesji',
    exact: true,
  });
  await details.getByRole('button', { name: /Przegląd dostępności/ }).click();
  await details.waitFor({ state: 'hidden' });
  await page
    .getByRole('heading', { name: 'Przegląd dostępności', exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await screenshot('-compact');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'passed',
      platform: process.platform,
      electron: versions.electron,
      node: versions.node,
      hostPid,
    }),
  );
} finally {
  await application?.close();
  if (hostPid) {
    let alive = true;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        process.kill(hostPid, 0);
      } catch {
        alive = false;
        break;
      }
      await delay(100);
    }
    assert.equal(alive, false, 'Host must exit with the desktop');
  }
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
