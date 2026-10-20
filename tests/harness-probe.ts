/** Opt-in real-host measurements. Never connects to the user's host or closes user sessions. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import WebSocket from 'ws';

import {
  decodeFrame,
  encodeFrame,
  keyBytes,
  parsePairing,
} from '../apps/mobile/src/shared/api/host/wire';
import { ControlledClaudeIdle, type HostSample, removeOwnedProbe } from './controlled-claude-idle';
import { stopFixtureHost } from './host-fixture-shutdown';

type ControlledSession = {
  sessionId: string;
  program: string;
  running: boolean;
  readiness: { phase: string };
  status: { selected: { source: string; state: string } };
  processIdentity: { pid: number };
  conversationIdentity?: { providerSessionId: string; generation: number };
  nativeQuotaCallback?: {
    source: string;
    sequence: number;
    generation: number;
    snapshot: { reason: string };
    backendFreshness: string;
    ordinaryUsageAllowed: boolean | null;
    accountFingerprint: string | null;
  };
};

async function main(): Promise<void> {
  const exec = promisify(execFile);
  const mode = process.argv[2] ?? 'baseline';
  assert.ok(
    ['baseline', 'claude-start', 'controlled-claude-idle'].includes(mode),
    'Use baseline, claude-start or controlled-claude-idle',
  );
  const controlled = mode === 'controlled-claude-idle';
  const root = await mkdtemp(join(tmpdir(), 'nesvo-harness-probe-'));
  const workspace = join(root, 'isolated workspace');
  await mkdir(workspace);
  const binary = resolve(
    process.env.NESVO_HOST_BINARY ?? 'target/verification/debug/nesvo-host.exe',
  );
  let controlledFixture: ControlledClaudeIdle | undefined;
  try {
    if (controlled) controlledFixture = await ControlledClaudeIdle.install(root, binary);
  } catch (error) {
    await removeOwnedProbe(root);
    throw error;
  }
  const host = spawn(
    binary,
    ['--port', '0', '--pairing-dir', root, '--workspace', workspace, '--exit-on-stdin-close'],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'], env: controlledFixture?.env },
  );
  let stderr = '';
  host.stderr.on('data', bytes => {
    stderr = (stderr + bytes.toString()).slice(-4000);
  });
  let socket: WebSocket | undefined;
  let outgoing = 0;
  let incoming = 0;
  let challenge = '';
  const events: Record<string, unknown>[] = [];
  const output = new Map<string, string>();
  const transitions: { elapsedMs: number; sessions: unknown }[] = [];
  const created: string[] = [];
  const attached = new Set<string>();
  let wireError: unknown;
  host.on('error', error => {
    wireError = controlled ? new Error('Owned fixture host failed to start') : error;
  });
  let stopAgent: (() => Promise<void>) | undefined;
  let diagnosticSequence = 0;
  const started = performance.now();
  async function until<T>(
    read: () => T | undefined | Promise<T | undefined>,
    label: string,
    ms = 20000,
  ): Promise<T> {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
      if (wireError) throw wireError;
      if (host.exitCode !== null)
        throw new Error(`Fixture host exited (${host.exitCode}): ${stderr}`);
      const value = await read();
      if (value !== undefined) return value;
      await delay(25);
    }
    throw new Error(`Timeout: ${label}`);
  }
  try {
    const pairing = await until(async () => {
      try {
        return parsePairing(await readFile(join(root, 'pairing.json'), 'utf8'));
      } catch {
        return undefined;
      }
    }, 'fixture pairing');
    const secret = keyBytes(pairing.key);
    socket = new WebSocket(pairing.url);
    function send(command: unknown): void {
      socket?.send(
        encodeFrame(command, secret, challenge, 'client-to-host', ++outgoing, randomBytes),
      );
    }
    socket.on('error', error => {
      wireError = error;
    });
    socket.on('message', data => {
      try {
        if (!challenge) {
          challenge = JSON.parse(data.toString()).challenge;
          return;
        }
        const event = decodeFrame(
          data.toString(),
          secret,
          challenge,
          'host-to-client',
          ++incoming,
        ) as Record<string, unknown>;
        events.push(event);
        if (event.type === 'error') wireError = new Error(String(event.message));
        if (event.type === 'sessions')
          transitions.push({
            elapsedMs: Math.round(performance.now() - started),
            sessions: (event.sessions as Record<string, unknown>[]).map(s => ({
              id: s.id,
              running: s.running,
              status: s.status,
              readiness: s.readiness,
            })),
          });
        if (
          event.type === 'output' &&
          typeof event.sessionId === 'string' &&
          typeof event.data === 'string'
        ) {
          output.set(
            event.sessionId,
            ((output.get(event.sessionId) ?? '') + event.data).slice(-24000),
          );
          if (
            attached.has(event.sessionId) &&
            (!event.replay || event.allowResponses) &&
            event.data.includes('\x1b[6n')
          )
            send({ type: 'input', sessionId: event.sessionId, data: '\x1b[1;1R' });
        }
        // Process output is retained only in private memory, never in measurement logs.
        if (events.length > 400) events.splice(0, events.length - 400);
      } catch (error) {
        wireError = error;
      }
    });
    await until(() => challenge || undefined, 'challenge');
    send({ type: 'auth', clientNonce: randomBytes(32).toString('hex') });
    await until(() => events.find(e => e.type === 'connected'), 'authenticated connection');
    for (let i = 0; i < (mode === 'claude-start' ? 1 : 8); i++) {
      const requestId = `probe-${i}`;
      send({
        type: 'create',
        name: `Probe ${i}`,
        program: mode === 'baseline' ? 'shell' : 'claude',
        requestId,
      });
      const event = await until(
        () => events.find(e => e.type === 'created' && e.requestId === requestId),
        'created',
      );
      const id = String(event.sessionId);
      created.push(id);
      if (!controlled) {
        attached.add(id);
        send({ type: 'attach', sessionId: id, cols: 100, rows: 32 });
        await until(
          () => events.find(e => e.type === 'attached' && e.sessionId === id),
          'attached',
        );
      }
      if (mode === 'baseline')
        await until(() => (output.get(id)?.includes('PS ') ? true : undefined), 'PowerShell ready');
    }
    const controlledRoots: number[] = [];
    if (controlledFixture) {
      const diagnose = async (quota: boolean): Promise<ControlledSession[]> =>
        until(
          async () => {
            const requestId = `controlled-diagnostics-${++diagnosticSequence}`;
            send({ type: 'getDiagnostics', requestId });
            const event = await until(
              () => events.find(e => e.type === 'diagnostics' && e.requestId === requestId),
              'controlled diagnostics response',
            );
            const report = event.report as {
              sessions: ControlledSession[];
              programs: { id: string; available: boolean }[];
            };
            assert.ok(
              report.programs.some(program => program.id === 'claude' && program.available),
            );
            assert.ok(
              report.programs
                .filter(program => program.available && program.id !== 'shell')
                .every(program => program.id === 'claude'),
              'No original provider may be available to the fixture host',
            );
            const sessions = report.sessions;
            if (
              sessions.length !== 8 ||
              !sessions.every(
                session =>
                  created.includes(session.sessionId) &&
                  session.program === 'claude' &&
                  session.running &&
                  session.readiness.phase === 'ready' &&
                  session.status.selected.source === 'hook' &&
                  session.status.selected.state === 'idle' &&
                  session.conversationIdentity?.providerSessionId ===
                    `fixture-${session.sessionId}` &&
                  (!quota ||
                    (session.nativeQuotaCallback?.source === 'claudeStatusLine' &&
                      session.nativeQuotaCallback.sequence === 1 &&
                      session.nativeQuotaCallback.generation ===
                        session.conversationIdentity.generation &&
                      session.nativeQuotaCallback.snapshot.reason === 'observed' &&
                      session.nativeQuotaCallback.backendFreshness === 'unknown' &&
                      session.nativeQuotaCallback.ordinaryUsageAllowed === null &&
                      session.nativeQuotaCallback.accountFingerprint === null)),
              )
            )
              return undefined;
            return sessions;
          },
          quota ? 'eight current root quota callbacks' : 'eight bound idle Claude roots',
        );
      const roots = await diagnose(false);
      controlledRoots.push(...roots.map(session => Number(session.processIdentity.pid)));
      assert.equal(new Set(controlledRoots).size, 8);
      for (const id of created) await controlledFixture.seed(id);
      await diagnose(true);
    }
    if (mode === 'baseline' || controlledFixture) {
      await delay(3000);
      // Disconnect releases the probe's legacy control lease.
      socket.close();
      await until(
        () => (socket?.readyState === WebSocket.CLOSED ? true : undefined),
        'probe disconnected',
      );
      async function sample(): Promise<{
        cpuSeconds: number;
        memoryBytes: number;
        threads: number;
        children: number;
      }> {
        const ps = `$p=Get-Process -Id ${host.pid}; $children=@(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${host.pid} }); [pscustomobject]@{cpuSeconds=$p.CPU;memoryBytes=$p.WorkingSet64;threads=$p.Threads.Count;children=$children.Count} | ConvertTo-Json -Compress`;
        return JSON.parse(
          (await exec('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }))
            .stdout,
        );
      }
      const before = controlledFixture
        ? await controlledFixture.sample(host.pid!, controlledRoots)
        : await sample();
      const samples: HostSample[] = controlledFixture ? [before as HostSample] : [];
      const at = performance.now();
      for (let i = 0; i < 6; i++) {
        await delay(10000);
        assert.equal(host.exitCode, null, 'Owned host remains alive during the idle interval');
        if (controlledFixture) {
          const current = await controlledFixture.sample(host.pid!, controlledRoots);
          assert.equal(current.children, before.children, 'Owned direct-child count stays stable');
          samples.push(current);
        }
        console.log(`${mode}: ${(i + 1) * 10}/60 seconds, no clients`);
      }
      const after = controlledFixture ? samples.at(-1)! : await sample();
      const elapsedSeconds = (performance.now() - at) / 1000;
      assert.ok(elapsedSeconds >= 60);
      const report = {
        mode,
        ...(controlledFixture
          ? {
              provider: 'controlledClaude',
              originalProviderCalls: 0,
              modelCalls: 0,
              quotaCallbacksPerRoot: 1,
            }
          : { binary }),
        sessions: created.length,
        noClients: true,
        elapsedSeconds,
        before,
        after,
        cpuPercentOfOneCore: (100 * (after.cpuSeconds - before.cpuSeconds)) / elapsedSeconds,
        ...(controlledFixture
          ? {
              samples,
              sampledPeakMemoryBytes: Math.max(...samples.map(sample => sample.memoryBytes)),
            }
          : {}),
      };
      await mkdir('artifacts/harness', { recursive: true });
      await writeFile(
        `artifacts/harness/${controlledFixture ? 'controlled-claude-idle' : 'baseline'}.json`,
        JSON.stringify(report, null, 2),
      );
      console.log(JSON.stringify(report));
    } else {
      await delay(15000);
      let text = output.get(created[0]!) ?? '';
      if (
        process.env.NESVO_PROBE_ACCEPT_TRUST === '1' &&
        /Yes,Itrustthisfolder/i.test(
          text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s/g, ''),
        )
      ) {
        // Explicit opt-in only acknowledges this fresh, empty fixture workspace.
        send({ type: 'input', sessionId: created[0], data: '\x1b[B\r' });
        await delay(15000);
        text = output.get(created[0]!) ?? '';
        const plain = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s/g, '');
        if (plain.includes('❯ContinuewithoutusingthisMCPserver')) {
          // Keep discovered external tools disabled for this empty fixture.
          send({ type: 'input', sessionId: created[0], data: '\r' });
          await delay(12000);
          text = output.get(created[0]!) ?? '';
        }
      }
      const labels = ['trust', 'hooks', 'Claude Code', 'Welcome', 'API Error', 'sign in', '7501'];
      send({ type: 'getDiagnostics', sessionId: created[0], requestId: 'probe-diagnostics' });
      const diagnostics = await until(
        () => events.find(e => e.type === 'diagnostics' && e.requestId === 'probe-diagnostics'),
        'diagnostic evidence',
      );
      const ready = transitions.some(t => JSON.stringify(t.sessions).includes('"evidence":"hook"'));
      if (ready)
        stopAgent = async () => {
          send({ type: 'input', sessionId: created[0], data: '\x03' });
          await delay(200);
          send({ type: 'input', sessionId: created[0], data: '\x03' });
          await delay(800);
          if (
            events.some(
              e =>
                e.type === 'sessions' &&
                (e.sessions as Record<string, unknown>[]).some(
                  s => s.id === created[0] && s.running === false,
                ),
            )
          )
            return;
          send({ type: 'input', sessionId: created[0], data: '/exit\r' });
          await until(
            () =>
              events.some(
                e =>
                  e.type === 'sessions' &&
                  (e.sessions as Record<string, unknown>[]).some(
                    s => s.id === created[0] && s.running === false,
                  ),
              )
                ? true
                : undefined,
            'Claude exits normally',
            15000,
          );
        };
      if (ready && process.env.NESVO_PROBE_PROMPT === '1') {
        const before = transitions.length;
        send({
          type: 'input',
          sessionId: created[0],
          data: '\x1b[200~Join NESVO_ and PROBE_OK into one word and reply only with that word. Do not use tools.\x1b[201~',
        });
        await delay(300);
        send({ type: 'input', sessionId: created[0], data: '\r' });
        await until(
          () =>
            transitions
              .slice(before)
              .some(
                t =>
                  JSON.stringify(t.sessions).includes('"state":"working"') &&
                  JSON.stringify(t.sessions).includes('"evidence":"hook"'),
              )
              ? true
              : undefined,
          'real turn starts',
        );
        await until(
          () =>
            (output.get(created[0]!) ?? '').includes('NESVO_PROBE_OK') &&
            transitions
              .slice(before)
              .some(
                t =>
                  JSON.stringify(t.sessions).includes('"evidence":"hook"') &&
                  JSON.stringify(t.sessions).includes('"state":"idle"'),
              )
              ? true
              : undefined,
          'real turn settles',
          60000,
        );
        const turn = transitions
          .slice(before)
          .flatMap(
            t => t.sessions as { status: { state: string; source: string; evidence?: string } }[],
          );
        const began = turn.findIndex(
          s => s.status.evidence === 'hook' && s.status.state === 'working',
        );
        const settled = turn.findIndex(
          (s, i) => i > began && s.status.evidence === 'hook' && s.status.state === 'idle',
        );
        assert.ok(began >= 0 && settled > began, 'actual hook-bound turn and response observed');
        assert.ok(
          !turn.slice(began, settled).some(s => s.status.state === 'idle'),
          'screen cannot manufacture idle before Stop',
        );
      }
      const report = {
        mode,
        binary,
        diagnostics: diagnostics.report,
        transitions,
        screenMarkers: labels.filter(label => text.toLowerCase().includes(label.toLowerCase())),
        noModelPromptSent: process.env.NESVO_PROBE_PROMPT !== '1' || !ready,
      };
      await mkdir('artifacts/harness', { recursive: true });
      await writeFile('artifacts/harness/claude-start.json', JSON.stringify(report, null, 2));
      if (process.env.NESVO_PROBE_CAPTURE_SCREEN === '1')
        await writeFile('artifacts/harness/claude-start-private-screen.txt', text);
      console.log(JSON.stringify(report));
    }
  } catch (error) {
    await mkdir('artifacts/harness', { recursive: true });
    await writeFile(
      'artifacts/harness/probe-failure.json',
      JSON.stringify(
        controlled
          ? { mode, sessions: created.length, error: 'Controlled Claude idle probe failed' }
          : { transitions, error: String(error) },
        null,
        2,
      ),
    );
    if (!controlled && process.env.NESVO_PROBE_CAPTURE_SCREEN === '1')
      await writeFile(
        'artifacts/harness/claude-start-private-screen.txt',
        output.get(created[0]!) ?? '',
      );
    throw error;
  } finally {
    try {
      await stopAgent?.();
    } finally {
      socket?.close();
      if (controlledFixture) {
        const cleanupErrors: unknown[] = [];
        try {
          await stopFixtureHost(host);
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await controlledFixture.cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (cleanupErrors.length)
          throw new AggregateError(cleanupErrors, 'Controlled probe cleanup was not confirmed');
        await removeOwnedProbe(root);
      } else {
        await stopFixtureHost(host);
        await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
      }
    }
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
