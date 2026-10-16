import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

import { HostClient, type Pairing, parsePairing } from '../apps/mobile/src/shared/api/host/client';

// Run after `cargo build --manifest-path apps/host/Cargo.toml`, with the web app serving.
async function main() {
  const appUrl = process.env.APP_URL || 'http://localhost:8081';
  const pairingDir = path.resolve('artifacts', `.live-${randomUUID()}`);
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
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
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
    await page.goto(appUrl, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Połącz swój komputer', exact: true }).click();
    await page.getByLabel('Kod parowania JSON').fill(JSON.stringify(pairing));
    await page.getByRole('button', { name: 'Połącz z hostem', exact: true }).click();
    await page.getByText('Połączono', { exact: true }).filter({ visible: true }).waitFor();
    // Organize on one client and observe the authoritative hierarchy on another.
    await page.getByRole('button', { name: 'Zarządzaj grupami', exact: true }).click();
    await page.getByRole('button', { name: 'Dodaj grupę', exact: true }).click();
    await page.getByLabel('Nazwa grupy', { exact: true }).fill('Live workspace');
    await page.getByRole('button', { name: 'Utwórz grupę', exact: true }).click();
    await page
      .getByRole('button', { name: 'Dodaj podgrupę do Live workspace', exact: true })
      .click();
    await page.getByLabel('Nazwa grupy', { exact: true }).fill('Phone');
    await page.getByRole('button', { name: 'Utwórz grupę', exact: true }).click();
    await page.getByRole('button', { name: 'Pokaż grupę Phone', exact: true }).click();
    const observer = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    observer.on('pageerror', error => errors.push(error.message));
    await observer.goto(appUrl, { waitUntil: 'networkidle' });
    await observer.getByRole('button', { name: 'Połącz swój komputer', exact: true }).click();
    await observer.getByLabel('Kod parowania JSON').fill(JSON.stringify(pairing));
    await observer.getByRole('button', { name: 'Połącz z hostem', exact: true }).click();
    await observer.getByRole('button', { name: 'Zarządzaj grupami', exact: true }).click();
    await observer.getByRole('button', { name: 'Pokaż grupę Phone', exact: true }).waitFor();
    await observer.screenshot({ path: 'artifacts/groups-live.png' });
    // Selecting a parent includes sessions in its descendants.
    await observer.getByRole('button', { name: 'Pokaż grupę Live workspace', exact: true }).click();
    await page.getByRole('button', { name: 'Nowa sesja', exact: true }).click();
    await page.getByLabel('Nazwa sesji', { exact: true }).fill('Rust live verification');
    await page.getByRole('button', { name: 'Utwórz sesję', exact: true }).click();
    const terminal = page.frameLocator('iframe[title="Terminal sesji"]');
    await terminal.locator('.xterm-screen').waitFor();
    await page.getByRole('button', { name: 'Przejmij sterowanie', exact: true }).click();
    await observer
      .getByRole('button', { name: 'Otwórz sesję Rust live verification', exact: true })
      .click();
    const observerTerminal = observer.frameLocator('iframe[title="Terminal sesji"]');
    await observerTerminal.locator('.xterm-screen').waitFor();
    assert.notEqual(
      await observer.getByLabel('Polecenie terminala', { exact: true }).getAttribute('readonly'),
      null,
      'passive terminal must not accept input',
    );
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
    await observerTerminal
      .locator('.xterm-rows')
      .filter({ hasText: 'RUST_BROWSER_EXECUTED' })
      .waitFor();
    await observer.getByRole('button', { name: 'Przejmij sterowanie', exact: true }).click();
    await page.getByRole('button', { name: 'Przejmij sterowanie', exact: true }).waitFor();
    assert.notEqual(
      await page.getByLabel('Polecenie terminala', { exact: true }).getAttribute('readonly'),
      null,
      'takeover disables the previous controller',
    );
    await observer
      .getByLabel('Polecenie terminala', { exact: true })
      .fill(
        process.platform === 'win32'
          ? "Write-Output ('DESKTOP_' + 'TAKEOVER')"
          : "printf '%s%s\\n' DESKTOP_ TAKEOVER",
      );
    await observer.getByRole('button', { name: 'Wyślij', exact: true }).click();
    await terminal.locator('.xterm-rows').filter({ hasText: 'DESKTOP_TAKEOVER' }).waitFor();
    // Moving a live session changes its group on both devices without replacing its process.
    await observer.getByRole('button', { name: 'Przenieś sesję do grupy', exact: true }).click();
    await observer.getByRole('radio', { name: 'Grupa: Live workspace', exact: true }).click();
    await observer.getByRole('button', { name: 'Wróć do sesji', exact: true }).click();
    await observer.close();
    await page.screenshot({ path: 'artifacts/terminal-live.png' });
    await page.getByRole('button', { name: 'Wróć do sesji', exact: true }).click();
    await page.getByRole('tab', { name: 'Komputery', exact: true }).click();
    await page.getByRole('button', { name: 'Rozłącz', exact: true }).click();
    await page.getByText('Rozłączono', { exact: true }).filter({ visible: true }).waitFor();
    await page.getByRole('button', { name: 'Połącz', exact: true }).click();
    await page.getByText('Połączono', { exact: true }).filter({ visible: true }).waitFor();
    await page
      .getByRole('button', { name: 'Otwórz sesję Rust live verification', exact: true })
      .click();
    await terminal.locator('.xterm-rows').filter({ hasText: 'RUST_BROWSER_EXECUTED' }).waitFor();
    await page.getByRole('button', { name: 'Przejmij sterowanie', exact: true }).click();
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
    host.kill();
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
