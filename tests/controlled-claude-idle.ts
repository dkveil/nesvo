/** Test-only original-process substitute. No user configuration or provider is loaded. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';

import { decodeFrame, encodeFrame } from '../apps/mobile/src/shared/api/host/wire';

const exec = promisify(execFile);
const samePath = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();
const psLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export type HostSample = {
  cpuSeconds: number;
  memoryBytes: number;
  threads: number;
  children: number;
  ownedRoots: number;
};

const observerCountKeys = [
  'scopePolls',
  'databaseOpenAttempts',
  'databaseOpens',
  'readTransactionAttempts',
  'readTransactions',
  'lifecycleSchemaProbes',
  'quotaTableProbes',
  'quotaRows',
  'quotaDecodes',
  'lifecycleEventRows',
  'lifecycleReadFailures',
  'quotaReadFailures',
  'blockingTaskFailures',
] as const;
type ObserverCounts = Record<(typeof observerCountKeys)[number], number>;
export type ObserverSnapshot = { sampledAtElapsedMs: number; counts: ObserverCounts };

function observerSnapshot(value: unknown): ObserverSnapshot {
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    'Observer counters missing',
  );
  const snapshot = value as Record<string, unknown>;
  assert.ok(
    Number.isSafeInteger(snapshot.sampledAtElapsedMs) && Number(snapshot.sampledAtElapsedMs) >= 0,
  );
  assert.ok(
    snapshot.counts && typeof snapshot.counts === 'object' && !Array.isArray(snapshot.counts),
  );
  const counts = snapshot.counts as Record<string, unknown>;
  assert.ok(Object.keys(counts).length === observerCountKeys.length);
  const selected = {} as ObserverCounts;
  for (const key of observerCountKeys) {
    assert.ok(
      Number.isSafeInteger(counts[key]) && Number(counts[key]) >= 0,
      'Invalid observer counter',
    );
    selected[key] = Number(counts[key]);
  }
  return { sampledAtElapsedMs: Number(snapshot.sampledAtElapsedMs), counts: selected };
}

/** A temporary owner connection, closed before resolving; only numeric fields escape. */
export async function readObserverSnapshot(
  url: string,
  secret: Uint8Array,
): Promise<ObserverSnapshot> {
  return new Promise<ObserverSnapshot>((done, reject) => {
    const socket = new WebSocket(url);
    let challenge = '';
    let outgoing = 0;
    let incoming = 0;
    let settled = false;
    let result: ObserverSnapshot | undefined;
    const finish = (snapshot?: ObserverSnapshot): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if (snapshot) done(snapshot);
      else reject(new Error('Observer diagnostics request failed'));
    };
    const timer = setTimeout(() => finish(), 5000);
    const send = (command: unknown): void => {
      socket.send(
        encodeFrame(command, secret, challenge, 'client-to-host', ++outgoing, randomBytes),
      );
    };
    socket.on('error', () => finish());
    socket.on('close', () => finish(result));
    socket.on('message', data => {
      try {
        if (!challenge) {
          const envelope = JSON.parse(data.toString()) as { challenge?: unknown };
          assert.ok(
            typeof envelope.challenge === 'string' && /^[a-f0-9]{64}$/.test(envelope.challenge),
          );
          challenge = envelope.challenge;
          send({ type: 'auth', clientNonce: randomBytes(32).toString('hex') });
          return;
        }
        const event = decodeFrame(
          data.toString(),
          secret,
          challenge,
          'host-to-client',
          ++incoming,
        ) as Record<string, unknown>;
        if (event.type === 'error') throw new Error('Observer diagnostics refused');
        if (event.type === 'connected')
          send({ type: 'getDiagnostics', requestId: 'observer-counts' });
        if (event.type === 'diagnostics' && event.requestId === 'observer-counts') {
          const report = event.report as Record<string, unknown>;
          result = observerSnapshot(report.lifecycleObserver);
          socket.close();
        }
      } catch {
        finish();
      }
    });
  });
}

export function observerInterval(before: ObserverSnapshot, after: ObserverSnapshot) {
  assert.ok(after.sampledAtElapsedMs > before.sampledAtElapsedMs);
  const delta = {} as ObserverCounts;
  for (const key of observerCountKeys) {
    assert.ok(after.counts[key] >= before.counts[key], 'Observer counters must be monotonic');
    delta[key] = after.counts[key] - before.counts[key];
  }
  assert.ok(delta.scopePolls > 0 && delta.databaseOpens > 0 && delta.quotaRows > 0);
  assert.equal(delta.lifecycleReadFailures, 0, 'Lifecycle reads remain healthy');
  assert.equal(delta.quotaReadFailures, 0, 'Quota reads remain healthy');
  assert.equal(delta.blockingTaskFailures, 0, 'Observer tasks remain healthy');
  return {
    source: 'ownerDiagnostics',
    elapsedSeconds: (after.sampledAtElapsedMs - before.sampledAtElapsedMs) / 1000,
    includesCpuInterval: true,
    includesPreDisconnectStabilizationSeconds: 3,
    includesConnectionOverhead: true,
    before,
    after,
    delta,
  };
}

export async function removeOwnedProbe(root: string): Promise<void> {
  const canonical = await realpath(root);
  assert.ok(samePath(dirname(canonical), await realpath(tmpdir())));
  assert.ok(basename(canonical).startsWith('nesvo-harness-probe-'));
  await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export class ControlledClaudeIdle {
  readonly env: NodeJS.ProcessEnv;
  private readonly seeded = new Set<string>();
  private rootIdentities: string[] | undefined;

  private constructor(
    private readonly root: string,
    private readonly binary: string,
    private readonly node: string,
  ) {
    this.env = { ...process.env };
    for (const key of Object.keys(this.env)) {
      if (
        [
          'PATH',
          'NODE_OPTIONS',
          'NODE_PATH',
          'NESVO_CLIENT_BINARY',
          'NESVO_TEST_CALLERS',
          'CLAUDE_CONFIG_DIR',
          'CODEX_HOME',
          'OPENAI_API_KEY',
          'OPENAI_BASE_URL',
          'CODEX_API_KEY',
          'ANTHROPIC_API_KEY',
          'ANTHROPIC_AUTH_TOKEN',
          'CLAUDE_CODE_OAUTH_TOKEN',
        ].includes(key.toUpperCase())
      )
        delete this.env[key];
    }
    // A private PATH also hides real Codex/Gemini from automatic discovery.
    this.env.PATH = join(root, 'bin');
    this.env.CLAUDE_CONFIG_DIR = join(root, 'claude-config');
    this.env.CODEX_HOME = join(root, 'codex-home');
    this.env.NESVO_TEST_CALLERS = join(root, 'callers');
  }

  static async install(root: string, binary: string): Promise<ControlledClaudeIdle> {
    assert.equal(process.platform, 'win32', 'This probe uses the existing Windows CPU/RSS sampler');
    const bin = join(root, 'bin');
    const callers = join(root, 'callers');
    const packageDirectory = join(bin, 'node_modules', '@anthropic-ai', 'claude-code');
    await mkdir(packageDirectory, { recursive: true });
    await mkdir(callers);
    await mkdir(join(root, 'claude-config'));
    await mkdir(join(root, 'codex-home'));
    const node = join(bin, 'node.exe');
    await copyFile(process.execPath, node);
    const source = await readFile(resolve('tests/fixtures/scoped-agent.cjs'), 'utf8');
    await writeFile(join(packageDirectory, 'main.js'), source);
    await writeFile(
      join(packageDirectory, 'package.json'),
      JSON.stringify({ bin: { claude: 'main.js' } }),
    );
    // The native host resolves this package directly through the owned Node.
    await writeFile(join(bin, 'claude.cmd'), '@echo off\r\necho NEVER_EXECUTE_FIXTURE_SHIM\r\n');
    await chmod(node, 0o755);
    return new ControlledClaudeIdle(
      await realpath(root),
      await realpath(binary),
      await realpath(node),
    );
  }

  async seed(sessionId: string): Promise<void> {
    assert.match(sessionId, /^[a-f0-9]{32}$/);
    assert.ok(!this.seeded.has(sessionId), 'Exactly one callback is seeded per root');
    const argv = JSON.parse(
      await readFile(join(this.root, 'callers', `${sessionId}.launch-argv.json`), 'utf8'),
    ) as string[];
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!);
    const hook = settings.hooks.SessionStart[0].hooks[0] as {
      command: string;
      args: string[];
    };
    assert.ok(samePath(await realpath(hook.command), await realpath(this.binary)));
    assert.equal(hook.args[0], '--agent-context-hook');
    assert.equal(hook.args.length, 2);
    const report = hook.args[1]!;
    assert.ok(isAbsolute(report));
    assert.equal(basename(report), 'context.json');
    assert.match(basename(dirname(report)), /^nesvo-context-[a-f0-9]{32}$/);
    assert.ok(samePath(dirname(await realpath(dirname(report))), await realpath(tmpdir())));
    const reset = Math.floor(Date.now() / 1000) + 3600;
    await new Promise<void>((done, reject) => {
      const child = execFile(
        this.binary,
        ['--claude-quota-hook', report],
        { windowsHide: true, timeout: 3000, maxBuffer: 4096 },
        error => {
          if (error) reject(new Error('Owned quota callback helper failed'));
          else done();
        },
      );
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(
        JSON.stringify({
          session_id: `fixture-${sessionId}`,
          rate_limits: {
            five_hour: { used_percentage: 31.25, resets_at: reset },
            seven_day: { used_percentage: 42.5, resets_at: reset + 86400 },
          },
        }),
      );
    });
    this.seeded.add(sessionId);
  }

  async sample(hostPid: number, expectedRoots: number[]): Promise<HostSample> {
    assert.equal(expectedRoots.length, 8);
    assert.ok(expectedRoots.every(pid => Number.isSafeInteger(pid) && pid > 0));
    const script = `$ErrorActionPreference='Stop'; $hostProcess=Get-Process -Id ${hostPid}; $processes=@(Get-CimInstance Win32_Process); $children=@($processes | Where-Object { $_.ParentProcessId -eq ${hostPid} }); $roots=@($processes | Where-Object { $_.ExecutablePath -eq ${psLiteral(this.node)} }); [pscustomobject]@{cpuSeconds=$hostProcess.CPU;memoryBytes=$hostProcess.WorkingSet64;threads=$hostProcess.Threads.Count;children=$children.Count;roots=@($roots | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;started=$_.CreationDate.ToUniversalTime().Ticks.ToString()} })} | ConvertTo-Json -Compress -Depth 3`;
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 16384,
    });
    const sample = JSON.parse(stdout) as Omit<HostSample, 'ownedRoots'> & {
      roots: { pid: number; started: string }[];
    };
    for (const value of [sample.cpuSeconds, sample.memoryBytes, sample.threads, sample.children])
      assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0);
    assert.deepEqual(
      sample.roots.map(root => root.pid).sort((a, b) => a - b),
      [...expectedRoots].sort((a, b) => a - b),
      'Only the eight original owned fixture roots must remain alive',
    );
    const identities = sample.roots.map(root => `${root.pid}:${root.started}`).sort();
    if (this.rootIdentities)
      assert.deepEqual(identities, this.rootIdentities, 'No root replacement');
    else this.rootIdentities = identities;
    return {
      cpuSeconds: sample.cpuSeconds,
      memoryBytes: sample.memoryBytes,
      threads: sample.threads,
      children: sample.children,
      ownedRoots: sample.roots.length,
    };
  }

  async cleanup(): Promise<void> {
    // The unique copied image belongs only to this fixture, including startup failures
    // before a created response. Never select user processes by a generic executable name.
    const script = `$ErrorActionPreference='Stop'; $ownedImage=${psLiteral(this.node)}; $roots=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $ownedImage }); foreach ($candidate in $roots) { $ownedProcess=Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue; if ($ownedProcess -and $ownedProcess.Path -eq $ownedImage -and [Math]::Abs($ownedProcess.StartTime.ToUniversalTime().Ticks - $candidate.CreationDate.ToUniversalTime().Ticks) -lt [TimeSpan]::TicksPerMillisecond) { $ownedProcess.Kill(); if (-not $ownedProcess.WaitForExit(3000)) { throw 'Owned fixture root did not exit' } } }; $remaining=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $ownedImage }); if ($remaining.Count -ne 0) { throw 'Owned fixture roots remain' }`;
    await exec('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 4096,
    });
  }
}
