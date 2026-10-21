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
  await page.getByText('Demo mode · the sessions below are samples').waitFor();
  await page.getByRole('tablist', { name: 'Main navigation' }).waitFor();
  assert.equal(
    await page.getByRole('tab', { name: 'Sessions', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  assert.equal(await page.getByRole('button', { name: /^Open session/ }).count(), 7);
  const demoWorkingDot = page
    .getByRole('button', { name: 'Open session Interface preview', exact: true })
    .getByTestId('session-status-dot');
  assert.equal(await demoWorkingDot.evaluate(node => getComputedStyle(node).opacity), '1');
  await page.waitForTimeout(950);
  assert.equal(
    await demoWorkingDot.evaluate(node => getComputedStyle(node).opacity),
    '1',
    'Demo working status stays still because no agent is running',
  );
  const newSessionButton = page.getByRole('button', { name: 'New session', exact: true });
  const pressBounds = await newSessionButton.boundingBox();
  assert.ok(pressBounds, 'New-session button is visible');
  await page.mouse.move(
    pressBounds.x + pressBounds.width / 2,
    pressBounds.y + pressBounds.height / 2,
  );
  await page.mouse.down();
  await page.waitForFunction(() => {
    const button = document.querySelector('[aria-label="New session"]');
    return (
      button?.parentElement &&
      new DOMMatrix(getComputedStyle(button.parentElement).transform).a < 0.999
    );
  });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Cancel new session', exact: true }).click();
  await expectNoHorizontalOverflow();
  await page.screenshot({ path: 'artifacts/sessions.png' });
  await page.screenshot({ path: 'artifacts/minimal-home.png' });
  await page
    .getByRole('button', { name: 'Open session Mobile sessions view', exact: true })
    .click();
  await page.frameLocator('iframe[title="Session terminal"]').locator('.xterm-screen').waitFor();
  assert.equal(
    await page.getByRole('tablist', { name: 'Main navigation' }).count(),
    0,
    'A session keeps the full screen height for its terminal',
  );
  assert.equal(
    await page.getByRole('tab', { name: /^(Terminal|Rozmowa)$/ }).count(),
    0,
    'Session screens open directly into the terminal without redundant tabs',
  );
  assert.equal(await page.getByText('Sample conversation', { exact: true }).count(), 0);
  // Reduced space checks flex layout only; it does not emulate the native iOS keyboard.
  await page.setViewportSize({ width: 390, height: 440 });
  const commandField = page.getByLabel('Terminal command', { exact: true });
  const hideKeyboard = page.getByRole('button', { name: 'Hide keyboard', exact: true });
  await commandField.fill('Nie wysyłaj tego szkicu');
  await expectInViewport(commandField, 'Command stays visible above a compact keyboard viewport');
  await expectInViewport(
    page.getByRole('button', { name: 'Send', exact: true }),
    'Send stays visible',
  );
  await expectInViewport(hideKeyboard, 'Explicit keyboard dismissal stays reachable');
  await hideKeyboard.click();
  assert.equal(await commandField.evaluate(node => node === document.activeElement), false);
  assert.equal(await commandField.inputValue(), 'Nie wysyłaj tego szkicu');
  const agentTerminal = page.frameLocator('iframe[title="Session terminal"]');
  await agentTerminal.locator('textarea').focus();
  await hideKeyboard.click();
  await page.waitForFunction(() => document.activeElement?.tagName !== 'IFRAME');
  await agentTerminal.locator('textarea:not(:focus)').waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('iframe')?.clientHeight >= 220);
  await expectInViewport(
    page.locator('iframe[title="Session terminal"]'),
    'Terminal remains visible',
  );
  await expectNoHorizontalOverflow();
  await page.screenshot({ path: 'artifacts/terminal-agent-compact.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
  await page.getByRole('tab', { name: 'Need you' }).click();
  assert.equal(await page.getByRole('button', { name: /^Open session/ }).count(), 3);
  await page.getByRole('tab', { name: 'All', exact: true }).click();
  await page.getByLabel('Search sessions').fill('nieistniejąca sesja');
  await page.getByText('No matching sessions').waitFor();
  await page.getByLabel('Search sessions').fill('');
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByLabel('Session name', { exact: true }).fill('Test terminala');
  await page.getByRole('button', { name: 'Create session', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Session terminal"]');
  await frame.locator('.xterm-screen').waitFor();
  await frame.locator('textarea').focus();
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await page.getByRole('button', { name: 'Keep it open', exact: true }).waitFor();
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
    .getByRole('button', { name: 'Keep it open', exact: true })
    .waitFor({ state: 'hidden' });
  await page.getByLabel('Terminal command', { exact: true }).fill('echo POCKET_BROWSER_OK');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('iframe')?.clientHeight > 150);
  await page.waitForTimeout(500);
  const output = await frame.locator('.xterm-rows').innerText();
  assert.ok(output.includes('POCKET_BROWSER_OK'), 'Demo terminal must receive submitted input');
  await page.screenshot({ path: 'artifacts/terminal-demo.png' });
  await page.setViewportSize({ width: 320, height: 300 });
  await page.waitForFunction(() => document.querySelector('iframe')?.clientHeight >= 100);
  await expectInViewport(
    page.getByLabel('Terminal command', { exact: true }),
    'Command stays visible',
  );
  await expectInViewport(
    page.getByRole('button', { name: 'Send', exact: true }),
    'Terminal send stays visible',
  );
  await expectInViewport(
    page.getByRole('button', { name: 'Key esc', exact: true }),
    'Terminal keys stay visible',
  );
  await expectInViewport(hideKeyboard, 'Keyboard dismissal stays visible at 320px width');
  await expectNoHorizontalOverflow();
  await page.screenshot({ path: 'artifacts/terminal-compact.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /^Open session/ }).count(), 8);
  await expectNoHorizontalOverflow();
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByRole('button', { name: 'Close navigation', exact: true }).waitFor();
  const switcherBounds = await page.getByTestId('session-switcher').boundingBox();
  assert.ok(
    switcherBounds && switcherBounds.y >= 8 && switcherBounds.height < 844 * 0.95,
    'The session switcher is inset instead of occupying the entire viewport',
  );
  const recentSessions = page.getByRole('button', { name: /^Go to session/ });
  assert.equal(await recentSessions.count(), 8, 'Sidebar lists recent sessions with their status');
  const codexTone = await page
    .getByRole('button', { name: 'Go to session Mobile sessions view', exact: true })
    .getByText('Codex', { exact: true })
    .evaluate(node => getComputedStyle(node).color);
  const geminiTone = await page
    .getByRole('button', { name: 'Go to session Interface preview', exact: true })
    .getByText('Gemini', { exact: true })
    .evaluate(node => getComputedStyle(node).color);
  assert.notEqual(codexTone, geminiTone, 'Agent colors remain distinct in recent sessions');
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'artifacts/menu.png' });
  await page.setViewportSize({ width: 320, height: 844 });
  await expectNoHorizontalOverflow();
  await page.screenshot({ path: 'artifacts/menu-320.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await page.getByRole('tab', { name: 'Computers', exact: true }).click();
  assert.equal(
    await page.getByRole('tab', { name: 'Computers', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  await page.getByRole('button', { name: 'Pair a computer', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 400 });
  await page.getByLabel('Pairing code JSON').click();
  await page.getByLabel('Pairing code JSON').fill('{invalid}');
  await expectInViewport(page.getByLabel('Pairing code JSON'), 'Pairing field scrolls into view');
  await page.getByRole('button', { name: 'Connect to host', exact: true }).scrollIntoViewIfNeeded();
  await expectInViewport(
    page.getByRole('button', { name: 'Connect to host', exact: true }),
    'Pairing action is reachable',
  );
  await page.getByRole('button', { name: 'Connect to host', exact: true }).click();
  await page.getByText('Invalid code.', { exact: false }).waitFor();
  await page.screenshot({ path: 'artifacts/pairing.png' });
  await page.getByRole('button', { name: 'Close pairing', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByText('Your tools and subscriptions', { exact: true }).waitFor();
  await page
    .getByRole('button', { name: 'Close navigation', exact: true })
    .waitFor({ state: 'hidden' });
  // A short viewport also exercises the space available above a mobile keyboard.
  await page.setViewportSize({ width: 320, height: 300 });
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  const cancel = page.getByRole('button', { name: 'Cancel new session', exact: true });
  await cancel.waitFor();
  const cancelBounds = await cancel.boundingBox();
  assert.ok(
    cancelBounds && cancelBounds.y >= 0 && cancelBounds.y + cancelBounds.height <= 300,
    'Create sheet must keep its close button on screen',
  );
  await page.getByLabel('Session name', { exact: true }).fill('Mały ekran');
  await page.getByRole('button', { name: 'Create session', exact: true }).click();
  await frame.locator('.xterm-screen').waitFor();
  // A session created from Settings must still return to the session list.
  await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/');
  await page.getByText('Demo mode · the sessions below are samples', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open session Mały ekran', exact: true }).waitFor();
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
    const reducedButton = reducedPage.getByRole('button', { name: 'New session', exact: true });
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
