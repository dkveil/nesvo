import logo from '@nesvo/brand/logo.json' with { type: 'json' };
import tokens from '@nesvo/brand/tokens.json' with { type: 'json' };
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  reducedMotion: 'reduce',
});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const mark = page.getByTestId('workspace-logo');

async function assertStill(reason) {
  await page.waitForTimeout(150);
  const changes = await mark.evaluate(
    node =>
      new Promise(resolve => {
        let changes = 0;
        const observer = new MutationObserver(records => {
          changes += records.length;
        });
        for (const rect of node.querySelectorAll('rect')) {
          observer.observe(rect, { attributes: true, attributeFilter: ['x', 'y', 'opacity'] });
        }
        setTimeout(() => {
          observer.disconnect();
          resolve(changes);
        }, 1250);
      }),
  );
  assert.equal(changes, 0, reason);
}

try {
  await page.goto(process.env.APP_URL || 'http://localhost:8082', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.getByText('Demo mode · the sessions below are samples', { exact: true }).waitFor();
  assert.equal(await mark.count(), 0, 'A populated workspace starts with its session list');
  const sessions = page.getByRole('button', { name: /^Open session/ });
  assert.equal(await sessions.count(), 7);
  // Remove only the fictional sessions in this fresh browser context through
  // the normal UI. The empty-workspace logo must not require a test-only route.
  for (let remaining = 7; remaining > 0; remaining--) {
    await sessions.first().click();
    await page.frameLocator('iframe[title="Session terminal"]').locator('.xterm-screen').waitFor();
    await page.getByRole('button', { name: 'End session', exact: true }).click();
    await page.getByRole('button', { name: 'Keep it open', exact: true }).waitFor();
    await page.getByRole('button', { name: 'End session', exact: true }).last().click();
    await page.waitForURL(url => url.pathname === '/');
    assert.equal(await sessions.count(), remaining - 1);
  }
  await mark.waitFor({ timeout: 60000 });
  assert.equal(await mark.getAttribute('viewBox'), logo.viewBox.join(' '));
  assert.equal(await mark.locator('path').nth(0).getAttribute('d'), logo.paths.robot);
  assert.equal(await mark.locator('path').nth(1).getAttribute('d'), logo.paths.wordmark);
  assert.equal(await mark.locator('path').nth(0).getAttribute('fill'), tokens.colors.accent);
  await assertStill('Reduced motion keeps the source mark static');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/ultraviolet-home.png' });
  await page.setViewportSize({ width: 320, height: 740 });
  // React Native's responsive layout commits after the browser resize event.
  // Wait for the actual geometry instead of sampling the previous viewport.
  await page.waitForFunction(() => {
    const bounds = document
      .querySelector('[data-testid="workspace-logo"]')
      ?.getBoundingClientRect();
    return bounds && bounds.width > 0 && bounds.left >= 0 && bounds.right <= 320;
  });
  const bounds = await mark.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320, JSON.stringify(bounds));
  await page.getByLabel('New session name', { exact: true }).fill('Ultraviolet task');
  await page.getByRole('button', { name: 'New session from the start menu', exact: true }).click();
  assert.equal(
    await page.getByLabel('Session name', { exact: true }).inputValue(),
    'Ultraviolet task',
  );
  await page.getByRole('button', { name: 'Cancel new session', exact: true }).click();
  await page.screenshot({ path: 'artifacts/ultraviolet-compact.png' });

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const closedFrameHandle = await page.waitForFunction(() => {
    const rects = document.querySelectorAll('[data-testid="workspace-logo"] rect');
    const eyelid = rects[1];
    if (eyelid?.getAttribute('opacity') !== '1') return null;
    return {
      eyelid: Object.fromEntries(Array.from(eyelid.attributes, attr => [attr.name, attr.value])),
      eyeOpacity: rects[0]?.getAttribute('opacity'),
    };
  });
  const closedFrame = await closedFrameHandle.jsonValue();
  for (const [attribute, value] of Object.entries(logo.eyelid)) {
    assert.equal(closedFrame.eyelid[attribute], String(value));
  }
  assert.equal(closedFrame.eyelid.fill, tokens.colors.accent);
  assert.equal(closedFrame.eyeOpacity, '0');

  // Native AppState still needs device verification; this checks the web visibility gate.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await assertStill('A background document stops logo frames');
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await assertStill('A covered dashboard stops logo frames');
  await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 250 });
  await page
    .getByText('Open a new session to start working on your computer.', { exact: true })
    .scrollIntoViewIfNeeded();
  const logoIntersects = await mark.evaluate(
    node =>
      new Promise(resolve => {
        const observer = new IntersectionObserver(entries => {
          observer.disconnect();
          resolve(entries[0]?.isIntersecting);
        });
        observer.observe(node);
      }),
  );
  assert.equal(logoIntersects, false, 'The compact empty state scrolls the logo out of view');
  await assertStill('A logo scrolled offscreen stops logo frames');
  await page.setViewportSize({ width: 320, height: 740 });
  await mark.scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="workspace-logo"] rect:nth-of-type(2)')
        ?.getAttribute('opacity') === '1',
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await assertStill('Changing the OS motion preference stops a running logo');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: exact logo, full visor blink, session-name flow, compact layout and motion lifecycle.',
  );
} finally {
  await browser.close();
}
