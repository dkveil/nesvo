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
page.on('pageerror', error => errors.push(error.message));
async function expectInViewport(locator, message) {
  const bounds = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 1, message);
}
async function expectNoHorizontalOverflow() {
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  assert.ok(fits, 'The mobile layout must not overflow horizontally');
}
await mkdir('artifacts', { recursive: true });
try {
  await page.goto(process.env.APP_URL || 'http://localhost:8081', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.getByText('Tryb demo · sesje poniżej są przykładowe').waitFor();
  assert.equal(await page.getByRole('button', { name: /^Otwórz sesję/ }).count(), 7);
  const demoWorkingDot = page
    .getByRole('button', { name: 'Otwórz sesję Podgląd interfejsu', exact: true })
    .getByTestId('session-status-dot');
  assert.equal(await demoWorkingDot.evaluate(node => getComputedStyle(node).opacity), '1');
  await page.waitForTimeout(950);
  assert.equal(
    await demoWorkingDot.evaluate(node => getComputedStyle(node).opacity),
    '1',
    'Demo working status stays still because no agent is running',
  );
  const newSessionButton = page.getByRole('button', { name: 'Nowa sesja', exact: true });
  const pressBounds = await newSessionButton.boundingBox();
  assert.ok(pressBounds, 'New-session button is visible');
  await page.mouse.move(
    pressBounds.x + pressBounds.width / 2,
    pressBounds.y + pressBounds.height / 2,
  );
  await page.mouse.down();
  await page.waitForFunction(() => {
    const button = document.querySelector('[aria-label="Nowa sesja"]');
    return (
      button?.parentElement &&
      new DOMMatrix(getComputedStyle(button.parentElement).transform).a < 0.999
    );
  });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Anuluj nową sesję', exact: true }).click();
  await expectNoHorizontalOverflow();
  await page.screenshot({ path: 'artifacts/sessions.png' });
  await page.screenshot({ path: 'artifacts/minimal-home.png' });
  await page
    .getByRole('button', { name: 'Otwórz sesję Widok sesji mobilnych', exact: true })
    .click();
  await page.frameLocator('iframe[title="Terminal sesji"]').locator('.xterm-screen').waitFor();
  assert.equal(
    await page.getByRole('tab', { name: /^(Terminal|Rozmowa)$/ }).count(),
    0,
    'Session screens open directly into the terminal without redundant tabs',
  );
  assert.equal(await page.getByText('Przykładowa rozmowa', { exact: true }).count(), 0);
  // Reduced space checks flex layout only; it does not emulate the native iOS keyboard.
  await page.setViewportSize({ width: 390, height: 440 });
  const commandField = page.getByLabel('Polecenie terminala', { exact: true });
  const hideKeyboard = page.getByRole('button', { name: 'Ukryj klawiaturę', exact: true });
  await commandField.fill('Nie wysyłaj tego szkicu');
  await expectInViewport(commandField, 'Command stays visible above a compact keyboard viewport');
  await expectInViewport(
    page.getByRole('button', { name: 'Wyślij', exact: true }),
    'Send stays visible',
  );
  await expectInViewport(hideKeyboard, 'Explicit keyboard dismissal stays reachable');
  await hideKeyboard.click();
  assert.equal(await commandField.evaluate(node => node === document.activeElement), false);
  assert.equal(await commandField.inputValue(), 'Nie wysyłaj tego szkicu');
  const agentTerminal = page.frameLocator('iframe[title="Terminal sesji"]');
  await agentTerminal.locator('textarea').focus();
  await hideKeyboard.click();
  await page.waitForFunction(() => document.activeElement?.tagName !== 'IFRAME');
  await agentTerminal.locator('textarea:not(:focus)').waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('iframe')?.clientHeight >= 220);
  await expectInViewport(
    page.locator('iframe[title="Terminal sesji"]'),
    'Terminal remains visible',
  );
  await expectNoHorizontalOverflow();
  await page.screenshot({ path: 'artifacts/terminal-agent-compact.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Wróć do sesji', exact: true }).click();
  await page.getByRole('tab', { name: 'Wymagają uwagi' }).click();
  assert.equal(await page.getByRole('button', { name: /^Otwórz sesję/ }).count(), 3);
  await page.getByRole('tab', { name: 'Wszystkie', exact: true }).click();
  await page.getByLabel('Szukaj sesji').fill('nieistniejąca sesja');
  await page.getByText('Brak pasujących sesji').waitFor();
  await page.getByLabel('Szukaj sesji').fill('');
  await page.getByRole('button', { name: 'Nowa sesja', exact: true }).click();
  await page.getByLabel('Nazwa sesji', { exact: true }).fill('Test terminala');
  await page.getByRole('button', { name: 'Utwórz sesję', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Terminal sesji"]');
  await frame.locator('.xterm-screen').waitFor();
  await frame.locator('textarea').focus();
  await page.getByRole('button', { name: 'Zakończ sesję', exact: true }).click();
  await page.getByRole('button', { name: 'Zostaw otwartą', exact: true }).waitFor();
  await frame.locator('textarea:disabled').waitFor({ state: 'attached' });
  assert.equal(await page.locator('iframe').evaluate(element => element.inert), true);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    assert.notEqual(
      await page.evaluate(() => document.activeElement?.tagName),
      'IFRAME',
      'Closing confirmation must keep keyboard input away from the terminal',
    );
  }
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'Zostaw otwartą', exact: true })
    .waitFor({ state: 'hidden' });
  await page.getByLabel('Polecenie terminala', { exact: true }).fill('echo POCKET_BROWSER_OK');
  await page.getByRole('button', { name: 'Wyślij', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('iframe')?.clientHeight > 150);
  await page.waitForTimeout(500);
  const output = await frame.locator('.xterm-rows').innerText();
  assert.ok(output.includes('POCKET_BROWSER_OK'), 'Demo terminal must receive submitted input');
  await page.screenshot({ path: 'artifacts/terminal-demo.png' });
  await page.setViewportSize({ width: 320, height: 300 });
  await page.waitForFunction(() => document.querySelector('iframe')?.clientHeight >= 100);
  await expectInViewport(
    page.getByLabel('Polecenie terminala', { exact: true }),
    'Command stays visible',
  );
  await expectInViewport(
    page.getByRole('button', { name: 'Wyślij', exact: true }),
    'Terminal send stays visible',
  );
  await expectInViewport(
    page.getByRole('button', { name: 'Klawisz esc', exact: true }),
    'Terminal keys stay visible',
  );
  await expectInViewport(hideKeyboard, 'Keyboard dismissal stays visible at 320px width');
  await expectNoHorizontalOverflow();
  await page.screenshot({ path: 'artifacts/terminal-compact.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Wróć do sesji', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /^Otwórz sesję/ }).count(), 8);
  await expectNoHorizontalOverflow();
  await page.getByRole('button', { name: 'Otwórz menu', exact: true }).click();
  await page.getByRole('tab', { name: 'Komputery', exact: true }).waitFor();
  const recentSessions = page.getByRole('button', { name: /^Przejdź do sesji/ });
  assert.equal(await recentSessions.count(), 8, 'Sidebar lists recent sessions with their status');
  const codexTone = await page
    .getByRole('button', { name: 'Przejdź do sesji Widok sesji mobilnych', exact: true })
    .getByText('Codex', { exact: true })
    .evaluate(node => getComputedStyle(node).color);
  const geminiTone = await page
    .getByRole('button', { name: 'Przejdź do sesji Podgląd interfejsu', exact: true })
    .getByText('Gemini', { exact: true })
    .evaluate(node => getComputedStyle(node).color);
  assert.notEqual(codexTone, geminiTone, 'Agent colors remain distinct in recent sessions');
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'artifacts/menu.png' });
  await page.setViewportSize({ width: 320, height: 844 });
  await expectNoHorizontalOverflow();
  await page.screenshot({ path: 'artifacts/menu-320.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Komputery', exact: true }).click();
  await page.getByRole('button', { name: 'Sparuj komputer', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 400 });
  await page.getByLabel('Kod parowania JSON').click();
  await page.getByLabel('Kod parowania JSON').fill('{invalid}');
  await expectInViewport(page.getByLabel('Kod parowania JSON'), 'Pairing field scrolls into view');
  await page.getByRole('button', { name: 'Połącz z hostem', exact: true }).scrollIntoViewIfNeeded();
  await expectInViewport(
    page.getByRole('button', { name: 'Połącz z hostem', exact: true }),
    'Pairing action is reachable',
  );
  await page.getByRole('button', { name: 'Połącz z hostem', exact: true }).click();
  await page.getByText('Nieprawidłowy kod.', { exact: false }).waitFor();
  await page.screenshot({ path: 'artifacts/pairing.png' });
  await page.getByRole('button', { name: 'Zamknij parowanie', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Otwórz menu', exact: true }).click();
  await page.getByRole('tab', { name: 'Ustawienia', exact: true }).click();
  await page.getByText('Twoje narzędzia i subskrypcje', { exact: true }).waitFor();
  await page
    .getByRole('button', { name: 'Zamknij nawigację', exact: true })
    .waitFor({ state: 'hidden' });
  // A short viewport also exercises the space available above a mobile keyboard.
  await page.setViewportSize({ width: 320, height: 300 });
  await page.getByRole('button', { name: 'Nowa sesja', exact: true }).click();
  const cancel = page.getByRole('button', { name: 'Anuluj nową sesję', exact: true });
  await cancel.waitFor();
  const cancelBounds = await cancel.boundingBox();
  assert.ok(
    cancelBounds && cancelBounds.y >= 0 && cancelBounds.y + cancelBounds.height <= 300,
    'Create sheet must keep its close button on screen',
  );
  await page.getByLabel('Nazwa sesji', { exact: true }).fill('Mały ekran');
  await page.getByRole('button', { name: 'Utwórz sesję', exact: true }).click();
  await frame.locator('.xterm-screen').waitFor();
  // A session created from Settings must still return to the session list.
  await page.getByRole('button', { name: 'Wróć do sesji', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/');
  await page.getByText('Tryb demo · sesje poniżej są przykładowe', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Otwórz sesję Mały ekran', exact: true }).waitFor();
  const reduced = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  try {
    const reducedPage = await reduced.newPage();
    reducedPage.on('pageerror', error => errors.push(error.message));
    await reducedPage.goto(process.env.APP_URL || 'http://localhost:8081', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    const reducedButton = reducedPage.getByRole('button', { name: 'Nowa sesja', exact: true });
    await reducedButton.waitFor();
    const reducedBounds = await reducedButton.boundingBox();
    assert.ok(reducedBounds, 'Reduced-motion new-session button is visible');
    await reducedPage.mouse.move(
      reducedBounds.x + reducedBounds.width / 2,
      reducedBounds.y + reducedBounds.height / 2,
    );
    await reducedPage.mouse.down();
    await reducedPage.waitForTimeout(180);
    assert.equal(
      await reducedButton.evaluate(
        node => new DOMMatrix(getComputedStyle(node.parentElement).transform).a,
      ),
      1,
      'Reduced motion removes the press scale',
    );
    await reducedPage.mouse.up();
  } finally {
    await reduced.close();
  }
  assert.deepEqual(errors, [], 'No browser runtime exceptions');
  console.log(
    'PASS: compact terminal-only sessions, keyboard dismissal, demo, filters, search, create, terminal input, pairing validation and navigation.',
  );
} finally {
  await browser.close();
}
