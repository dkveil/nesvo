import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

import { HostClient, type Pairing, parsePairing } from '../apps/mobile/src/shared/api/host/client';
import { stopFixtureHost } from './host-fixture-shutdown';

// Run after `cargo build --manifest-path apps/host/Cargo.toml`, with the web app serving.
async function main() {
  const appUrl = process.env.APP_URL || 'http://localhost:8081';
  const artifactsDir = path.resolve('artifacts');
  const pairingDir = path.join(artifactsDir, `.live-${randomUUID()}`);
  await mkdir(pairingDir, { recursive: true });
  const binary =
    process.env.NESVO_HOST_BINARY ||
    path.resolve('target/debug', `nesvo-host${process.platform === 'win32' ? '.exe' : ''}`);
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
      '--exit-on-stdin-close',
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let startupError: Error | undefined;
  host.on('error', error => {
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
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Connect your computer', exact: true }).click();
    await page.getByLabel('Pairing code JSON').fill(JSON.stringify(pairing));
    await page.getByRole('button', { name: 'Connect to host', exact: true }).click();
    await page.getByText('Connected', { exact: true }).filter({ visible: true }).waitFor();
    // Organize on one client and observe the authoritative hierarchy on another.
    await page.getByRole('button', { name: 'Manage groups', exact: true }).click();
    await page.getByRole('button', { name: 'Add group', exact: true }).click();
    await page.getByLabel('Group name', { exact: true }).fill('Live workspace');
    await page.getByRole('button', { name: 'Create group', exact: true }).click();
    await page
      .getByRole('button', { name: 'Add a subgroup to Live workspace', exact: true })
      .click();
    await page.getByLabel('Group name', { exact: true }).fill('Phone');
    await page.getByRole('button', { name: 'Create group', exact: true }).click();
    await page.getByRole('button', { name: 'Show group Phone', exact: true }).click();
    const observer = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    observer.on('pageerror', error => errors.push(error.message));
    await observer.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await observer.getByRole('button', { name: 'Connect your computer', exact: true }).click();
    await observer.getByLabel('Pairing code JSON').fill(JSON.stringify(pairing));
    await observer.getByRole('button', { name: 'Connect to host', exact: true }).click();
    await observer.getByRole('button', { name: 'Manage groups', exact: true }).click();
    await observer.getByRole('button', { name: 'Show group Phone', exact: true }).waitFor();
    await observer.screenshot({ path: 'artifacts/groups-live.png' });
    // Selecting a parent includes sessions in its descendants.
    await observer.getByRole('button', { name: 'Show group Live workspace', exact: true }).click();
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await page.getByLabel('Session name', { exact: true }).fill('Rust live verification');
    await page.getByRole('button', { name: 'Create session', exact: true }).click();
    const terminal = page.frameLocator('iframe[title="Session terminal"]');
    await terminal.locator('.xterm-screen').waitFor();
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await observer
      .getByRole('button', { name: 'Open session Rust live verification', exact: true })
      .click();
    const observerTerminal = observer.frameLocator('iframe[title="Session terminal"]');
    await observerTerminal.locator('.xterm-screen').waitFor();
    assert.notEqual(
      await observer.getByLabel('Terminal command', { exact: true }).getAttribute('readonly'),
      null,
      'passive terminal must not accept input',
    );
    // The expected output does not appear contiguously in the input, avoiding an echo-only false positive.
    const command =
      process.platform === 'win32'
        ? "Write-Output ('RUST_BROWSER_' + 'EXECUTED')"
        : "printf '%s%s\\n' RUST_BROWSER_ EXECUTED";
    await page.getByLabel('Terminal command', { exact: true }).fill(command);
    assert.equal(
      await page.getByLabel('Terminal command', { exact: true }).inputValue(),
      command,
      'composer must contain the complete command before sending',
    );
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await terminal
      .locator('.xterm-rows')
      .filter({ hasText: 'RUST_BROWSER_EXECUTED' })
      .waitFor({ timeout: 20000 });
    await observerTerminal
      .locator('.xterm-rows')
      .filter({ hasText: 'RUST_BROWSER_EXECUTED' })
      .waitFor();
    await observer.getByRole('button', { name: 'Take control', exact: true }).click();
    await page.getByRole('button', { name: 'Take control', exact: true }).waitFor();
    assert.notEqual(
      await page.getByLabel('Terminal command', { exact: true }).getAttribute('readonly'),
      null,
      'takeover disables the previous controller',
    );
    await observer
      .getByLabel('Terminal command', { exact: true })
      .fill(
        process.platform === 'win32'
          ? "Write-Output ('DESKTOP_' + 'TAKEOVER')"
          : "printf '%s%s\\n' DESKTOP_ TAKEOVER",
      );
    await observer.getByRole('button', { name: 'Send', exact: true }).click();
    await terminal.locator('.xterm-rows').filter({ hasText: 'DESKTOP_TAKEOVER' }).waitFor();
    // Moving a live session changes its group on both devices without replacing its process.
    await observer.getByRole('button', { name: 'Move session to a group', exact: true }).click();
    await observer.getByRole('radio', { name: 'Group: Live workspace', exact: true }).click();
    await observer.getByRole('button', { name: 'Back to sessions', exact: true }).click();
    await observer.close();
    await page.screenshot({ path: 'artifacts/terminal-live.png' });
    await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
    await page.getByRole('tab', { name: 'Computers', exact: true }).click();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.getByText('Disconnected', { exact: true }).filter({ visible: true }).waitFor();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText('Connected', { exact: true }).filter({ visible: true }).waitFor();
    await page
      .getByRole('button', { name: 'Open session Rust live verification', exact: true })
      .click();
    await terminal.locator('.xterm-rows').filter({ hasText: 'RUST_BROWSER_EXECUTED' }).waitFor();
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await page
      .getByLabel('Terminal command', { exact: true })
      .fill(
        process.platform === 'win32'
          ? "Write-Output ('AFTER_' + 'RECONNECT_OK')"
          : "printf '%s%s\\n' AFTER_ RECONNECT_OK",
      );
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await terminal.locator('.xterm-rows').filter({ hasText: 'AFTER_RECONNECT_OK' }).waitFor();
    await page.getByRole('button', { name: 'End session', exact: true }).click();
    await page.getByRole('button', { name: 'End session', exact: true }).last().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'artifacts/session-closed.png' });
    await page
      .getByText('Room for your first session', { exact: true })
      .filter({ visible: true })
      .waitFor();
    assert.deepEqual(errors, [], 'No browser runtime errors in live session');
    console.log(
      'PASS: two authenticated browsers -> groups/subgroups -> shared PTY output -> takeover -> move -> disconnect/reconnect/replay -> close.',
    );
  } finally {
    await browser?.close();
    // Even on a failed browser assertion, ask the host to close its test shells before exiting.
    if (pairing && host.exitCode === null) {
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, 3000);
        const unsubscribe = cleanup.subscribe(event => {
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
    try {
      await stopFixtureHost(host);
    } finally {
      if (path.dirname(pairingDir) !== artifactsDir)
        throw new Error('Fixture pairing directory escaped artifacts');
      await rm(pairingDir, { recursive: true, force: true });
    }
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
