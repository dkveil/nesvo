import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import { WebSocketServer } from 'ws';

import type { ClientCommand } from '../apps/mobile/src/shared/api/host/types';
import { decodeFrame, encodeFrame } from '../apps/mobile/src/shared/api/host/wire';

const HOST_ID = 'e'.repeat(32);
const JOB_PAGE_SIZE = 2;

const job = (id: string, title: string, createdAt: number) => ({
  id,
  title,
  revision: 2,
  enabled: true,
  nextDueAt: 1_792_800_000_000,
  createdAt,
  schedule: { kind: 'cron', expression: '0 2 * * *', timeZone: 'Europe/Warsaw' },
  calendarState: 'ready',
  calendarError: null,
});
const jobs = [
  job('job-nightly', 'Nightly review', 1),
  { ...job('job-webhook', 'Release notes', 2), enabled: false, schedule: { kind: 'external' } },
  job('job-weekly', 'Weekly cleanup', 3),
];
const jobSpec = {
  title: 'Nightly review',
  instruction: 'Summarize the current Git changes without editing files.',
  profile: { program: 'claude', workspace: 'shared', harness: true },
  schedule: jobs[0]!.schedule,
  retry: { on: 'launchNoEffect', maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 10000 },
  misfire: 'catchUp',
  graceMs: 60000,
  overlap: 'skip',
  maxElapsedMs: 300000,
};
const occurrence = {
  id: 'occurrence-2',
  jobId: 'job-nightly',
  jobRevision: 2,
  trigger: 'schedule',
  dueAt: 1_792_713_600_000,
  createdAt: 1_792_713_600_100,
  state: 'retryWaiting',
  reason: 'retry_backoff',
  runId: 'run-9',
  startedAt: 1_792_713_601_000,
  finishedAt: null,
  jobAttemptId: 'job-attempt-1',
  jobAttemptOrdinal: 1,
  retry: {
    jobAttemptId: 'job-attempt-1',
    attemptId: null,
    launchReceiptId: 'receipt-1',
    decidedAt: 1_792_713_602_000,
    notBefore: 1_792_713_603_000,
    nextOrdinal: 2,
    class: 'noEffect',
  },
};
const olderOccurrence = {
  ...occurrence,
  id: 'occurrence-1',
  trigger: 'manual',
  state: 'succeeded',
  reason: null,
  finishedAt: 1_792_627_500_000,
  retry: null,
};
const futureOccurrence = { ...olderOccurrence, id: 'occurrence-0', state: 'archived' };

const liveSession = (
  id: string,
  name: string,
  status: { state: string; source: string },
  parentSessionId: string | null,
) => ({
  id,
  name,
  cwd: '/workspace/app',
  createdAt: '2026-10-22T08:00:00Z',
  cols: 80,
  rows: 24,
  running: true,
  groupId: null,
  controllerId: null,
  program: 'claude',
  role: parentSessionId ? 'worker' : 'coordinator',
  parentSessionId,
  status: { ...status, updatedAt: 1_792_713_600_000 },
});
const sessions = [
  liveSession('worker-a', 'Worker A', { state: 'blocked', source: 'screen' }, 'coordinator'),
  liveSession('shell', 'Shell', { state: 'idle', source: 'activity' }, null),
  liveSession('coordinator', 'Coordinator', { state: 'working', source: 'hook' }, null),
  liveSession('reviewer', 'Reviewer', { state: 'question', source: 'hook' }, 'worker-a'),
];

type JobsRequest = Extract<ClientCommand, { type: 'workflow' }>['request']['request'];

const startHost = (key: Buffer) => {
  const server = new WebSocketServer({ port: 0 });
  const reads: JobsRequest[] = [];
  const subscriptions: string[] = [];
  server.on('connection', socket => {
    const challenge = randomBytes(32).toString('hex');
    let received = 0;
    let sent = 0;
    const send = (payload: unknown) =>
      socket.send(encodeFrame(payload, key, challenge, 'host-to-client', ++sent, randomBytes));
    const reply = (requestId: string, data: Record<string, unknown>) =>
      send({ type: 'workflow', ...data, requestId });
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
          send({
            type: 'connected',
            protocolVersion: 2,
            clientId: 1,
            clientNonce: command.clientNonce,
          });
          break;
        case 'getCapabilities':
          send({
            type: 'capabilities',
            hostId: HOST_ID,
            workspace: '/workspace',
            pushNotifications: true,
            jobPages: true,
            programs: [
              { id: 'shell', label: 'Terminal', available: true },
              { id: 'claude', label: 'Claude Code', available: true },
              { id: 'gemini', label: 'Gemini CLI', available: false },
              { id: 'codex', label: 'Codex', available: true },
            ],
          });
          break;
        case 'list':
          send({ type: 'sessions', sessions, groups: [], revision: 0 });
          break;
        case 'subscribe':
          subscriptions.push(command.sessionId);
          send({ type: 'subscribed', sessionId: command.sessionId, cols: 80, rows: 24 });
          send({
            type: 'control',
            sessionId: command.sessionId,
            controllerId: null,
            cols: 80,
            rows: 24,
          });
          break;
        case 'workflow': {
          const read = command.request.request;
          reads.push(read);
          if (read.action === 'list') {
            const start = read.page * JOB_PAGE_SIZE;
            const more = jobs.length > start + JOB_PAGE_SIZE;
            reply(command.requestId, {
              jobs: jobs.slice(start, start + JOB_PAGE_SIZE),
              nextOffset: more ? start + JOB_PAGE_SIZE : null,
              page: read.page,
              nextPage: more ? read.page + 1 : null,
            });
          } else if (read.action === 'get') {
            const found = jobs.find(item => item.id === read.jobId);
            if (found) reply(command.requestId, { job: { ...found, spec: jobSpec } });
            else
              send({
                type: 'error',
                code: 'job_not_found',
                message: 'Job does not exist',
                requestId: command.requestId,
              });
          } else {
            reply(command.requestId, {
              occurrences: [occurrence, olderOccurrence, futureOccurrence],
              nextOffset: null,
              page: read.page,
              nextPage: null,
            });
          }
          break;
        }
      }
    });
  });
  return { server, reads, subscriptions };
};

const connect = async (page: Page, port: number, key: Buffer) => {
  await page
    .getByRole('button', { name: 'Connect your computer', exact: true })
    .waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Connect your computer', exact: true }).click();
  await page
    .getByLabel('Pairing code JSON')
    .fill(JSON.stringify({ version: 1, url: `ws://localhost:${port}`, key: key.toString('hex') }));
  await page.getByRole('button', { name: 'Connect to host', exact: true }).click();
  await page.getByText('Connected', { exact: true }).filter({ visible: true }).waitFor();
};

const expectNoHorizontalOverflow = async (page: Page) => {
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  assert.ok(fits, 'The mobile layout must not overflow horizontally');
};

async function main() {
  const key = randomBytes(32);
  const { server, reads, subscriptions } = startHost(key);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
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
    await page.getByRole('button', { name: 'Open menu', exact: true }).waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    assert.equal(
      await page.getByRole('button', { name: 'Jobs', exact: true }).count(),
      0,
      'Demo mode and hosts without job pages keep the Jobs entry hidden',
    );
    await page.getByRole('button', { name: 'Close navigation', exact: true }).click();

    await connect(page, address.port, key);
    const rows = page.getByRole('button', { name: /^Open session / });
    await rows.first().waitFor();
    assert.deepEqual(
      await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))),
      [
        'Open session Shell',
        'Open session Coordinator',
        'Open session Worker A, child of Coordinator',
        'Open session Reviewer, child of Worker A',
      ],
    );
    const child = page.getByRole('button', {
      name: 'Open session Worker A, child of Coordinator',
      exact: true,
    });
    const grandchild = page.getByRole('button', {
      name: 'Open session Reviewer, child of Worker A',
      exact: true,
    });
    assert.equal(await child.getByTestId('child-session-marker').count(), 1);
    assert.equal(
      await page
        .getByRole('button', { name: 'Open session Coordinator', exact: true })
        .getByTestId('child-session-marker')
        .count(),
      0,
    );
    await child.getByLabel(/^Blocked\./).waitFor();
    await grandchild.getByLabel(/^Question\./).waitFor();
    const parentBox = await page
      .getByRole('button', { name: 'Open session Coordinator', exact: true })
      .boundingBox();
    const childBox = await child.boundingBox();
    const grandchildBox = await grandchild.boundingBox();
    assert.ok(parentBox && childBox && grandchildBox);
    assert.ok(childBox.x > parentBox.x && grandchildBox.x > childBox.x, 'Children are indented');
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: 'artifacts/child-sessions.png' });
    await child.click();
    await page.frameLocator('iframe[title="Session terminal"]').locator('.xterm-screen').waitFor();
    assert.deepEqual(subscriptions, ['worker-a'], 'Tapping a child opens that child session');
    await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
    await child.waitFor();
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    await page.getByRole('button', { name: 'Open job Nightly review', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^Open job / }).count(), 2);
    await page.getByText('Paused', { exact: true }).waitFor();
    await page.getByText('External trigger only', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Load more jobs', exact: true }).click();
    await page.getByRole('button', { name: 'Open job Weekly cleanup', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^Open job / }).count(), 3);
    assert.equal(
      await page.getByRole('button', { name: 'Load more jobs', exact: true }).count(),
      0,
    );
    assert.deepEqual(
      reads.filter(read => read.action === 'list').map(read => read.action === 'list' && read.page),
      [0, 1],
    );
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: 'artifacts/jobs-list.png' });

    await page.getByRole('button', { name: 'Open job Nightly review', exact: true }).click();
    const detail = page.getByTestId('job-detail');
    await detail.getByText('Cron 0 2 * * * (Europe/Warsaw)', { exact: true }).waitFor();
    await detail.getByText('Attempt 1 of 3', { exact: true }).first().waitFor();
    await detail.getByText(/^No effect: the launch was refused/).waitFor();
    await detail.getByText('Up to 3 attempts on launchNoEffect', { exact: true }).waitFor();
    await detail.getByText('1 occurrence needs a newer nesvo app.', { exact: true }).waitFor();
    assert.equal(await detail.getByLabel(/^Occurrence /).count(), 2);
    assert.ok(
      reads.some(
        read => read.action === 'history' && read.jobId === 'job-nightly' && read.page === 0,
      ),
    );
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: 'artifacts/job-detail.png' });
    await page.setViewportSize({ width: 320, height: 640 });
    await expectNoHorizontalOverflow(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Back to jobs', exact: true }).click();
    await page.getByRole('button', { name: 'Open job Weekly cleanup', exact: true }).waitFor();

    assert.deepEqual(errors, []);
    console.log(
      'PASS: child sessions under their parent, jobs menu gating, paged job list and read-only job detail.',
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
