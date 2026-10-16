import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';

import type { ClientCommand, TerminalSession } from '../apps/mobile/src/shared/api/host/types';
import { decodeFrame, encodeFrame } from '../apps/mobile/src/shared/api/host/wire';

// Deterministic UI/transport contract test. Actual CLI execution belongs to the
// Rust integration suite; this fixture never launches an installed AI program.
async function main() {
  const key = randomBytes(32);
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const requests: Extract<ClientCommand, { type: 'create' }>[] = [];
  const snapshots = new Set<() => void>();
  let session: TerminalSession | undefined;
  server.on('connection', socket => {
    const challenge = randomBytes(32).toString('hex');
    let received = 0;
    let sent = 0;
    const send = (payload: unknown) =>
      socket.send(encodeFrame(payload, key, challenge, 'host-to-client', ++sent, randomBytes));
    const snapshot = () =>
      send({ type: 'sessions', sessions: session ? [session] : [], groups: [], revision: 0 });
    socket.on('close', () => snapshots.delete(snapshot));
    socket.send(JSON.stringify({ type: 'challenge', version: 1, challenge }));
    socket.on('message', frame => {
      const command = decodeFrame(
        String(frame),
        key,
        challenge,
        'client-to-host',
        ++received,
      ) as ClientCommand;
      switch (command.type) {
        case 'auth':
          snapshots.add(snapshot);
          send({
            type: 'connected',
            protocolVersion: 2,
            clientId: 1,
            clientNonce: command.clientNonce,
          });
          snapshot();
          break;
        case 'getCapabilities':
          send({
            type: 'capabilities',
            workspace: '/workspace',
            programs: [
              { id: 'shell', label: 'Terminal', available: true },
              { id: 'claude', label: 'Claude Code', available: true },
              { id: 'gemini', label: 'Gemini CLI', available: false },
              { id: 'codex', label: 'Codex', available: true },
            ],
          });
          break;
        case 'list':
          snapshot();
          break;
        case 'create':
          requests.push(command);
          if (command.cwd === '/workspace/missing') {
            send({
              type: 'error',
              message: 'Working directory does not exist.',
              requestId: command.requestId,
            });
            break;
          }
          session = {
            id: 'created-cli',
            name: command.name,
            cwd: command.cwd || '/workspace',
            program: command.program || 'shell',
            createdAt: new Date().toISOString(),
            running: true,
            cols: 80,
            rows: 24,
            groupId: null,
            controllerId: null,
          };
          send({ type: 'created', sessionId: session.id, requestId: command.requestId });
          snapshot();
          break;
        case 'subscribe':
          send({ type: 'subscribed', sessionId: command.sessionId, cols: 80, rows: 24 });
          send({
            type: 'control',
            sessionId: command.sessionId,
            controllerId: null,
            cols: 80,
            rows: 24,
          });
          break;
      }
    });
  });

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    await mkdir('artifacts', { recursive: true });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.APP_URL || 'http://localhost:8081', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page
      .getByRole('button', { name: 'Nowa sesja z menu startowego', exact: true })
      .waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: 'Nowa sesja z menu startowego', exact: true }).click();
    assert.equal(
      await page.getByRole('radio', { name: 'Terminal', exact: true }).getAttribute('aria-checked'),
      'true',
    );
    for (const name of ['Claude Code', 'Gemini CLI', 'Codex']) {
      assert.equal(
        await page.getByRole('radio', { name, exact: true }).isDisabled(),
        true,
        'Demo must not claim real CLI availability',
      );
    }
    assert.notEqual(
      await page.getByLabel('Katalog roboczy', { exact: true }).getAttribute('readonly'),
      null,
    );
    await page.screenshot({ path: 'artifacts/new-session-demo.png' });
    await page.getByRole('button', { name: 'Anuluj nową sesję', exact: true }).click();
    await page.getByRole('button', { name: 'Połącz swój komputer', exact: true }).click();
    await page.getByLabel('Kod parowania JSON').fill(
      JSON.stringify({
        version: 1,
        url: `ws://localhost:${address.port}`,
        key: key.toString('hex'),
      }),
    );
    await page.getByRole('button', { name: 'Połącz z hostem', exact: true }).click();
    await page.getByText('Połączono', { exact: true }).filter({ visible: true }).waitFor();
    await page.getByRole('button', { name: 'Nowa sesja z menu startowego', exact: true }).click();
    assert.equal(
      await page.getByLabel('Katalog roboczy', { exact: true }).inputValue(),
      '/workspace',
    );
    assert.equal(
      await page.getByRole('radio', { name: 'Claude Code', exact: true }).isDisabled(),
      false,
    );
    assert.equal(await page.getByRole('radio', { name: 'Codex', exact: true }).isDisabled(), false);
    assert.equal(
      await page.getByRole('radio', { name: 'Gemini CLI', exact: true }).isDisabled(),
      true,
    );
    await page.getByRole('radio', { name: 'Claude Code', exact: true }).click();
    await page.screenshot({ path: 'artifacts/new-session-live.png' });
    await page.setViewportSize({ width: 320, height: 400 });
    const closeBounds = await page
      .getByRole('button', { name: 'Anuluj nową sesję', exact: true })
      .boundingBox();
    assert.ok(
      closeBounds && closeBounds.y >= 0 && closeBounds.y + closeBounds.height <= 400,
      'Create sheet close button stays above a compact keyboard viewport',
    );
    await page.getByLabel('Katalog roboczy', { exact: true }).fill('/workspace/missing');
    await page.getByLabel('Nazwa sesji', { exact: true }).fill('Retry task');
    await page.getByRole('button', { name: 'Utwórz sesję', exact: true }).click();
    await page
      .getByRole('alert')
      .filter({ hasText: 'Working directory does not exist.' })
      .waitFor();
    assert.equal(
      await page.getByLabel('Nazwa sesji', { exact: true }).inputValue(),
      'Retry task',
      'Host errors must preserve the editable draft',
    );
    assert.equal(
      await page.getByLabel('Katalog roboczy', { exact: true }).inputValue(),
      '/workspace/missing',
    );
    await page.screenshot({ path: 'artifacts/new-session-compact.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel('Katalog roboczy', { exact: true }).fill('/workspace/mobile');
    await page.getByLabel('Nazwa sesji', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Utwórz sesję', exact: true }).click();
    await page.frameLocator('iframe[title="Terminal sesji"]').locator('.xterm-screen').waitFor();
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.cwd, '/workspace/mobile');
    assert.equal(requests[1]?.program, 'claude');
    assert.equal(
      requests[1]?.name,
      'Claude Code · mobile',
      'An omitted name is derived from the selected CLI and directory',
    );
    assert.notEqual(requests[0]?.requestId, requests[1]?.requestId);
    // Snapshot status changes are visible without reopening or recreating the session.
    await page.getByRole('button', { name: 'Wróć do sesji', exact: true }).click();
    assert.ok(session);
    for (const [state, source, label] of [
      ['working', 'activity', 'Aktywność'],
      ['idle', 'activity', 'Cisza'],
      ['question', 'screen', 'Pytanie'],
      ['blocked', 'screen', 'Blokada'],
      ['done', 'process', 'Zakończona'],
      ['failed', 'process', 'Błąd'],
      ['unknown', 'screen', 'Nieznany'],
    ] as const) {
      session = { ...session, status: { state, source, updatedAt: Date.now() } };
      for (const snapshot of snapshots) snapshot();
      await page.getByLabel(new RegExp(`^${label}\\.`)).waitFor();
    }
    assert.equal(requests.length, 2, 'Status updates must not create another process');
    assert.deepEqual(errors, []);
    console.log(
      'PASS: demo launch menu, detected CLI availability, workspace selection, failed-create draft retention and correlated CLI creation.',
    );
  } finally {
    await browser?.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
