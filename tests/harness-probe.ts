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
import { stopFixtureHost } from './host-fixture-shutdown';

async function main(): Promise<void> {
  const exec = promisify(execFile);
  const mode = process.argv[2] ?? 'baseline';
  assert.ok(['baseline', 'claude-start'].includes(mode), 'Use baseline or claude-start');
  const root = await mkdtemp(join(tmpdir(), 'nesvo-harness-probe-'));
  const workspace = join(root, 'isolated workspace');
  await mkdir(workspace);
  const binary = resolve(
    process.env.NESVO_HOST_BINARY ?? 'target/verification/debug/nesvo-host.exe',
  );
  const host = spawn(
    binary,
    ['--port', '0', '--pairing-dir', root, '--workspace', workspace, '--exit-on-stdin-close'],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] },
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
  let stopAgent: (() => Promise<void>) | undefined;
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
    for (let i = 0; i < (mode === 'baseline' ? 8 : 1); i++) {
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
      attached.add(id);
      send({ type: 'attach', sessionId: id, cols: 100, rows: 32 });
      await until(() => events.find(e => e.type === 'attached' && e.sessionId === id), 'attached');
      if (mode === 'baseline')
        await until(() => (output.get(id)?.includes('PS ') ? true : undefined), 'PowerShell ready');
    }
    if (mode === 'baseline') {
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
      const before = await sample();
      const at = performance.now();
      for (let i = 0; i < 6; i++) {
        await delay(10000);
        console.log(`Baseline: ${(i + 1) * 10}/60 seconds, no clients`);
      }
      const after = await sample();
      const elapsedSeconds = (performance.now() - at) / 1000;
      const report = {
        mode,
        binary,
        sessions: created.length,
        noClients: true,
        elapsedSeconds,
        before,
        after,
        cpuPercentOfOneCore: (100 * (after.cpuSeconds - before.cpuSeconds)) / elapsedSeconds,
      };
      await mkdir('artifacts/harness', { recursive: true });
      await writeFile('artifacts/harness/baseline.json', JSON.stringify(report, null, 2));
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
          data: 'Join NESVO_ and PROBE_OK into one word and reply only with that word. Do not use tools.\r',
        });
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
      JSON.stringify({ transitions, error: String(error) }, null, 2),
    );
    if (process.env.NESVO_PROBE_CAPTURE_SCREEN === '1')
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
      await stopFixtureHost(host);
      await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    }
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
