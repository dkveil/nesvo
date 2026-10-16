import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Run the Expo web preview first. These are real UI captures with fictional
// demo data, not screenshots of a native iPhone build or a paired computer.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = resolve(root, 'docs/assets');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});

try {
  // A fresh context has no saved credentials, cookies or connection state.
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.APP_URL || 'http://localhost:8082', { waitUntil: 'networkidle' });
  await page.getByText('Tryb demo · sesje poniżej są przykładowe', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Otwórz sesję/ }).count(), 3);
  await page.evaluate(() => document.fonts.ready);
  await mkdir(assets, { recursive: true });
  await page.screenshot({ path: resolve(assets, 'mobile-sessions.png'), animations: 'disabled' });

  await page.getByRole('button', { name: 'Zarządzaj grupami', exact: true }).click();
  await page
    .getByText('Grupy przykładowe · zmiany pozostają w tym podglądzie.', { exact: true })
    .waitFor();

  // Exercise the public controls to illustrate nesting. All changes disappear
  // with this isolated demo context; no host is connected or modified.
  async function addGroup(name, parent) {
    await page
      .getByRole('button', {
        name: parent ? `Dodaj podgrupę do ${parent}` : 'Dodaj grupę',
        exact: true,
      })
      .click();
    await page.getByLabel('Nazwa grupy', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Utwórz grupę', exact: true }).click();
    await page.getByRole('button', { name: `Pokaż grupę ${name}`, exact: true }).waitFor();
  }
  await addGroup('Backend', 'Workspace');
  await addGroup('Host Rust', 'Backend');
  await addGroup('Projekty poboczne');
  await addGroup('Strona internetowa', 'Projekty poboczne');
  await addGroup('Eksperymenty', 'Projekty poboczne');
  await page
    .getByText('Grupy przykładowe · zmiany pozostają w tym podglądzie.', { exact: true })
    .scrollIntoViewIfNeeded();
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve(assets, 'mobile-groups.png'), animations: 'disabled' });
  console.log(
    'Captured demo web UI: docs/assets/mobile-sessions.png and docs/assets/mobile-groups.png',
  );
} finally {
  await browser.close();
}
