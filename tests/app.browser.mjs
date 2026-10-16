import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// Start `npm run web` first. This verifies the web client, not native iOS behavior.
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await mkdir('artifacts', { recursive: true });
try {
  await page.goto(process.env.APP_URL || 'http://localhost:8081', { waitUntil: 'networkidle' });
  await page.getByText('Rozejrzyj się. To tryb demo.').waitFor();
  assert.equal(await page.getByRole('button', { name: /^Otwórz sesję/ }).count(), 3);
  await page.screenshot({ path: 'artifacts/sessions.png' });
  await page.getByRole('tab', { name: 'Wymagają uwagi' }).click();
  assert.equal(await page.getByRole('button', { name: /^Otwórz sesję/ }).count(), 1);
  await page.getByRole('tab', { name: 'Wszystkie', exact: true }).click();
  await page.getByLabel('Szukaj sesji').fill('nieistniejąca sesja');
  await page.getByText('Brak pasujących sesji').waitFor();
  await page.getByLabel('Szukaj sesji').fill('');
  await page.getByRole('button', { name: 'Nowa sesja', exact: true }).click();
  await page.getByLabel('Nazwa sesji', { exact: true }).fill('Test terminala');
  await page.getByRole('button', { name: 'Utwórz sesję', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Terminal sesji"]');
  await frame.locator('.xterm-screen').waitFor();
  await page.getByLabel('Polecenie terminala', { exact: true }).fill('echo POCKET_BROWSER_OK');
  await page.getByRole('button', { name: 'Wyślij', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('iframe')?.clientHeight > 150);
  await page.waitForTimeout(500);
  const output = await frame.locator('.xterm-rows').innerText();
  assert.ok(output.includes('POCKET_BROWSER_OK'), 'Demo terminal must receive submitted input');
  await page.screenshot({ path: 'artifacts/terminal-demo.png' });
  await page.getByRole('button', { name: 'Wróć do sesji', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /^Otwórz sesję/ }).count(), 4);
  await page.getByRole('tab', { name: 'Hosty', exact: true }).click();
  await page.getByRole('button', { name: 'Sparuj komputer', exact: true }).click();
  await page.getByLabel('Kod parowania JSON').fill('{invalid}');
  await page.getByRole('button', { name: 'Połącz z hostem', exact: true }).click();
  await page.getByText('Nieprawidłowy kod.', { exact: false }).waitFor();
  await page.screenshot({ path: 'artifacts/pairing.png' });
  await page.getByRole('button', { name: 'Zamknij parowanie', exact: true }).click();
  await page.getByRole('tab', { name: 'Ustawienia', exact: true }).click();
  await page.getByText('Twoje narzędzia i subskrypcje', { exact: true }).waitFor();
  assert.deepEqual(errors, [], 'No browser runtime exceptions');
  console.log(
    'PASS: demo, filters, search, create, terminal input, pairing validation, navigation.',
  );
} finally {
  await browser.close();
}
