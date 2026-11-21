import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

assert.ok(
  process.env.NESVO_PACKAGED_EXECUTABLE,
  'Set NESVO_PACKAGED_EXECUTABLE.',
);
const executable = resolve(process.env.NESVO_PACKAGED_EXECUTABLE);
const directory = await realpath(
  await mkdtemp(join(tmpdir(), 'nesvo-package-')),
);
const env = {
  ...process.env,
  NESVO_DATA_DIR: directory,
  NESVO_TEST_MODE: '1',
  NESVO_WORKFLOWS_HOME: join(directory, 'workflows-home'),
  NESVO_SMOKE_TEST: '1',
  NESVO_CLAUDE_EXECUTABLE: resolve('apps/host/tests/claude-fixture.mjs'),
  NESVO_CODEX_EXECUTABLE: resolve('apps/host/tests/codex-fixture.mjs'),
  CLAUDE_CONFIG_DIR: join(directory, 'claude'),
  CODEX_HOME: join(directory, 'codex'),
  NESVO_TEST_SKILLS_HOME: join(directory, 'skills'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NESVO_WORK_LAPTOP_MODE;
delete env.NESVO_TEST_PID_FILE;

let child;
let exited;
let browser;
let stderr = '';
try {
  await mkdir(env.CLAUDE_CONFIG_DIR);
  await mkdir(env.CODEX_HOME);
  const node = spawnSync(executable, ['-p', 'process.versions.electron'], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  assert.ifError(node.error);
  assert.equal(node.status, 0, node.stderr);
  assert.match(node.stdout.trim(), /^\d+\.\d+\.\d+/);

  child = spawn(
    executable,
    process.platform === 'linux'
      ? ['--no-sandbox', '--remote-debugging-port=0']
      : ['--remote-debugging-port=0'],
    {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    },
  );
  let failure;
  exited = new Promise(resolve => {
    child.once('error', error => {
      failure = error;
      resolve(null);
    });
    child.once('exit', (code, signal) => {
      failure = new Error(`Nesvo exited (${code ?? signal}).`);
      resolve(code);
    });
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-8000);
  });
  let endpoint;
  const deadline = Date.now() + 20_000;
  while (!endpoint && Date.now() < deadline) {
    if (failure) throw failure;
    endpoint = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/.exec(
      stderr,
    )?.[1];
    if (!endpoint) await delay(50);
  }
  assert.ok(
    endpoint,
    'The packaged renderer did not expose its test endpoint.',
  );
  browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
  const context = browser.contexts()[0];
  const renderer = /^file:\/\/.*\/app\.asar\/dist\/renderer\/index\.html$/;
  const readyBy = Date.now() + 30_000;
  let page;
  while (!page && Date.now() < readyBy) {
    if (failure) throw failure;
    page = context.pages().find(candidate => renderer.test(candidate.url()));
    if (!page) await delay(50);
  }
  assert.ok(page, 'The packaged renderer did not load its application page.');
  await page.waitForFunction(
    () => window.nesvo && document.querySelector('#root')?.childElementCount,
    undefined,
    { timeout: Math.max(1, readyBy - Date.now()) },
  );
  assert.equal(await page.title(), 'Nesvo');
  const health = await page.evaluate(() => window.nesvo.health());
  assert.equal(health.status, 'ready');
  assert.equal(health.protocolVersion, 1);
  await page.close();
  const code = await Promise.race([
    exited,
    delay(10_000, 'timeout', { ref: false }),
  ]);
  assert.equal(code, 0, 'The packaged app did not exit cleanly.');
  console.log(`Packaged Nesvo started and stopped on ${process.platform}.`);
} catch (error) {
  if (stderr) console.error(stderr.trim());
  const log = await readFile(join(directory, 'logs', 'main.log'), 'utf8').catch(
    () => '',
  );
  if (log) console.error(log.trim().split(/\r?\n/).slice(-8).join('\n'));
  throw error;
} finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null)
    child.kill();
  await exited;
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
