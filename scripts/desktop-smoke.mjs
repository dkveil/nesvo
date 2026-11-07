import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

const directory = await mkdtemp(join(tmpdir(), 'nesvo-desktop-'));
const pidFile = join(directory, 'processes.json');
const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
const executablePath =
  process.env.NESVO_PACKAGED_EXECUTABLE || requireDesktop('electron');
const env = {
  ...process.env,
  NESVO_SMOKE_TEST: '1',
  NESVO_DATA_DIR: directory,
  NESVO_TEST_PID_FILE: pidFile,
};
delete env.ELECTRON_RUN_AS_NODE;
let application;
let hostPid;
try {
  application = await electron.launch({
    executablePath,
    args: process.env.NESVO_PACKAGED_EXECUTABLE
      ? []
      : [resolve('apps/desktop')],
    env,
    timeout: 30000,
  });
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page
    .getByRole('status')
    .filter({ hasText: 'Połączono z lokalnym hostem' })
    .waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Odśwież połączenie' }).click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Połączono z lokalnym hostem' })
    .waitFor();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const versions = await application.evaluate(() => process.versions);
  hostPid = JSON.parse(await readFile(pidFile, 'utf8')).host;
  assert.equal(typeof hostPid, 'number');
  if (process.env.NESVO_SCREENSHOT)
    await page.screenshot({ path: process.env.NESVO_SCREENSHOT });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'passed',
      platform: process.platform,
      electron: versions.electron,
      node: versions.node,
      hostPid,
    }),
  );
} finally {
  await application?.close();
  if (hostPid) {
    let alive = true;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        process.kill(hostPid, 0);
      } catch {
        alive = false;
        break;
      }
      await delay(100);
    }
    assert.equal(alive, false, 'Host must exit with the desktop');
  }
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
