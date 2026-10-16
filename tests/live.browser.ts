import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { HostClient, parsePairing, type Pairing } from '../src/connection/client';

// Run after `cargo build --manifest-path host/Cargo.toml`, with the web app serving.
async function main() {
  const appUrl = process.env.APP_URL || 'http://localhost:8081';
  const pairingDir = path.resolve('artifacts', `.live-${randomUUID()}`);
  await mkdir(pairingDir, { recursive: true });
  const binary = path.resolve(
    'host/target/debug',
    `pocket-sessions-host${process.platform === 'win32' ? '.exe' : ''}`,
  );
  const host = spawn(
    binary,
    [
      '--port',
      '0',
      '--pairing-dir',
      pairingDir,
      '--workspace',
      process.cwd(),
      '--allowed-origins',
      new URL(appUrl).origin,
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let startupError: Error | undefined;
  host.on('error', (error) => {
    startupError = error;
  });
  host.stderr.on('data', () => {});
  host.stdout.on('data', () => {});
  let pairing: Pairing | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const cleanup = new HostClient();
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError;
      try {
        pairing = parsePairing(await readFile(path.join(pairingDir, 'pairing.json'), 'utf8'));
        break;
      } catch {
        await delay(100);
      }
    }
    assert.ok(pairing, 'Rust host must create pairing data');
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(appUrl, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Połącz swój komputer', exact: true }).click();
    await page.getByLabel('Kod parowania JSON').fill(JSON.stringify(pairing));
    await page.getByRole('button', { name: 'Połącz z hostem', exact: true }).click();
    await page.getByText('ONLINE', { exact: true }).filter({ visible: true }).waitFor();
    await page.getByRole('button', { name: 'Nowa sesja', exact: true }).click();
    await page.getByLabel('Nazwa sesji', { exact: true }).fill('Rust live verification');
    await page.getByRole('button', { name: 'Utwórz sesję', exact: true }).click();
    const terminal = page.frameLocator('iframe[title="Terminal sesji"]');
    await terminal.locator('.xterm-screen').waitFor();
    // The expected output does not appear contiguously in the input, avoiding an echo-only false positive.
    const command =
      process.platform === 'win32'
        ? "Write-Output ('RUST_BROWSER_' + 'EXECUTED')"
        : "printf '%s%s\\n' RUST_BROWSER_ EXECUTED";
    await page.getByLabel('Polecenie terminala', { exact: true }).fill(command);
    await page.getByRole('button', { name: 'Wyślij', exact: true }).click();
    await terminal
      .locator('.xterm-rows')
      .filter({ hasText: 'RUST_BROWSER_EXECUTED' })
      .waitFor({ timeout: 20000 });
    await page.screenshot({ path: 'artifacts/terminal-live.png' });
    await page.getByRole('button', { name: 'Wróć do sesji', exact: true }).click();
    await page.getByRole('tab', { name: 'Hosty', exact: true }).click();
    await page.getByRole('button', { name: 'Rozłącz', exact: true }).click();
    await page.getByText('Rozłączono', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Połącz', exact: true }).click();
    await page.getByText('ONLINE', { exact: true }).filter({ visible: true }).waitFor();
    await page
      .getByRole('button', { name: 'Otwórz sesję Rust live verification', exact: true })
      .click();
    await terminal.locator('.xterm-rows').filter({ hasText: 'RUST_BROWSER_EXECUTED' }).waitFor();
    await page
      .getByLabel('Polecenie terminala', { exact: true })
      .fill(
        process.platform === 'win32'
          ? "Write-Output ('AFTER_' + 'RECONNECT_OK')"
          : "printf '%s%s\\n' AFTER_ RECONNECT_OK",
      );
    await page.getByRole('button', { name: 'Wyślij', exact: true }).click();
    await terminal.locator('.xterm-rows').filter({ hasText: 'AFTER_RECONNECT_OK' }).waitFor();
    await page.getByRole('button', { name: 'Zakończ sesję', exact: true }).click();
    await page.getByRole('button', { name: 'Zakończ sesję', exact: true }).last().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'artifacts/session-closed.png' });
    await page
      .getByText('Miejsce na pierwszą sesję', { exact: true })
      .filter({ visible: true })
      .waitFor();
    assert.deepEqual(errors, [], 'No browser runtime errors in live session');
    console.log(
      'PASS: Rust host -> authenticated browser -> real PTY -> disconnect/reconnect/replay -> close.',
    );
  } finally {
    await browser?.close();
    // Even on a failed browser assertion, ask the host to close its test shells before exiting.
    if (pairing && host.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 3000);
        const unsubscribe = cleanup.subscribe((event) => {
          if (event.type === 'connected') cleanup.listSessions();
          if (event.type === 'sessions') {
            for (const session of event.sessions) cleanup.closeSession(session.id);
            clearTimeout(timeout);
            unsubscribe();
            setTimeout(resolve, 300);
          }
        });
        cleanup.connect(pairing!);
      });
    }
    cleanup.disconnect();
    host.kill();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
