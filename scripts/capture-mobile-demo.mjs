import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Run the Expo web preview first. These are real UI captures with fictional
// demo data, not screenshots of a native iPhone build or a paired computer.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = resolve(root, 'artifacts');
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
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.APP_URL || 'http://localhost:8082', { waitUntil: 'networkidle' });
  await page.getByText('Demo mode · the sessions below are samples', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Open session/ }).count(), 7);
  await page.evaluate(() => document.fonts.ready);
  await mkdir(assets, { recursive: true });
  await page.screenshot({ path: resolve(assets, 'mobile-sessions.png'), animations: 'disabled' });

  await page.getByRole('button', { name: 'Manage groups', exact: true }).click();
  await page.getByText('Sample groups · changes stay in this preview.', { exact: true }).waitFor();

  // Exercise the public controls to illustrate nesting. All changes disappear
  // with this isolated demo context; no host is connected or modified.
  async function addGroup(name, parent) {
    await page
      .getByRole('button', {
        name: parent ? `Add a subgroup to ${parent}` : 'Add group',
        exact: true,
      })
      .click();
    await page.getByLabel('Group name', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Create group', exact: true }).click();
    await page.getByRole('button', { name: `Show group ${name}`, exact: true }).waitFor();
  }
  await addGroup('Backend', 'Workspace');
  await addGroup('Host Rust', 'Backend');
  await addGroup('Projekty poboczne');
  await addGroup('Strona internetowa', 'Projekty poboczne');
  await addGroup('Eksperymenty', 'Projekty poboczne');
  await page
    .getByText('Sample groups · changes stay in this preview.', { exact: true })
    .scrollIntoViewIfNeeded();
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve(assets, 'mobile-groups.png'), animations: 'disabled' });
  console.log(
    'Captured demo web UI: artifacts/mobile-sessions.png and artifacts/mobile-groups.png',
  );
} finally {
  await browser.close();
}
