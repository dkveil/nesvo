import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

const output = process.env.NESVO_G3_SCREENSHOTS;
assert.ok(output, 'Set NESVO_G3_SCREENSHOTS to the evidence directory.');
await mkdir(output, { recursive: true });

const directory = await realpath(
  await mkdtemp(join(tmpdir(), 'nesvo-g3-desktop-')),
);
const project = join(directory, 'project');
const data = join(directory, 'host');
const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
let application;
try {
  await mkdir(project);
  await mkdir(data);
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Nesvo Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: join(directory, 'missing-git-config'),
          GIT_CONFIG_NOSYSTEM: '1',
        },
        windowsHide: true,
      },
    );
  git('init', '--quiet', '--initial-branch=coordinator');
  await writeFile(join(project, 'readme.txt'), 'Fixture repository\n');
  git('add', '--', 'readme.txt');
  git('commit', '-qm', 'Initial commit');

  const env = {
    ...process.env,
    NESVO_SMOKE_TEST: '1',
    NESVO_TEST_MODE: '1',
    NESVO_TEST_PID_FILE: join(directory, 'local-processes.json'),
    NESVO_DATA_DIR: data,
    NESVO_WORKFLOWS_HOME: join(directory, 'workflows'),
    NESVO_TEST_SKILLS_HOME: join(directory, 'skills'),
    CLAUDE_CONFIG_DIR: join(directory, 'claude'),
    CODEX_HOME: join(directory, 'codex'),
    NESVO_CLAUDE_EXECUTABLE: resolve('apps/host/tests/claude-fixture.mjs'),
    NESVO_CODEX_EXECUTABLE: resolve('apps/host/tests/codex-fixture.mjs'),
    NESVO_CODEX_FIXTURE_STATE_DIR: join(directory, 'codex-state'),
    NESVO_MOBILE_PORT: '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NESVO_WORK_LAPTOP_MODE;
  application = await electron.launch({
    executablePath: requireDesktop('electron'),
    args: [resolve('apps/desktop')],
    env,
    timeout: 30_000,
  });
  const page = await application.firstWindow();
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.evaluate(() => window.nesvo.setColorScheme('dark'));
  const deadline = Date.now() + 30_000;
  let connected = false;
  while (Date.now() < deadline && !connected) {
    connected = await page.evaluate(() =>
      window.nesvo.readSessionControlPolicy('local').then(
        () => true,
        () => false,
      ),
    );
    if (!connected) await delay(100);
  }
  assert.ok(connected, 'The local host did not respond.');
  const session = await page.evaluate(
    ({ project, requestId }) =>
      window.nesvo.createSession(
        {
          requestId,
          title: 'Coordinator with two writable workers',
          provider: 'Codex',
          model: 'fixture-codex',
          mode: 'supervised',
          directory: project,
        },
        'local',
      ),
    { project, requestId: randomUUID() },
  );
  await page
    .getByRole('navigation', { name: 'Sessions' })
    .getByRole('button', { name: /^Coordinator with two writable workers/ })
    .click();
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('fixture:delegate-git');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const workers = page.getByRole('region', { name: 'Workers', exact: true });
  for (const letter of ['A', 'B']) {
    await workers
      .getByRole('group', { name: `Fixture worker ${letter}`, exact: true })
      .getByRole('button', { name: 'Approve worker', exact: true })
      .click();
  }
  await workers
    .getByRole('button', { name: 'Review branch', exact: true })
    .nth(1)
    .waitFor();
  const completionDeadline = Date.now() + 30_000;
  let completed = false;
  while (Date.now() < completionDeadline && !completed) {
    completed = await page.evaluate(
      async id =>
        (await window.nesvo.listSessions()).some(
          item => item.id === id && item.status === 'completed',
        ),
      session.id,
    );
    if (!completed) await delay(100);
  }
  assert.ok(completed, 'The coordinator did not finish its delegation turn.');
  const children = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).filter(child => child.parentId === session.id);
  assert.equal(children.length, 2);
  assert.ok(
    children.every(
      child =>
        child.mode === 'supervised' &&
        child.worktree?.workerTargetBranch === 'coordinator',
    ),
  );
  const capture = async file => {
    await page.evaluate(
      () =>
        new Promise(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }),
    );
    const image = await application.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      return (
        await contents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        })
      )
        .toPNG()
        .toString('base64');
    });
    await writeFile(join(output, file), Buffer.from(image, 'base64'));
  };
  await capture('coordinator-two-writable-workers.png');
  await workers
    .getByRole('button', { name: 'Review branch', exact: true })
    .first()
    .click();
  const diff = page.getByRole('dialog', { name: 'Fixture worker A' });
  await diff.getByText(/diff --git a\/worker-a.txt/).waitFor();
  const merge = diff.getByRole('button', { name: 'Merge into coordinator' });
  assert.equal(await merge.isEnabled(), true);
  await capture('worker-diff-and-merge.png');
  await merge.click();
  const confirm = diff.getByRole('button', { name: 'Confirm merge' });
  await confirm.waitFor();
  await capture('worker-confirm-merge.png');
  await confirm.click();
  await diff.waitFor({ state: 'hidden' });
  assert.match(
    git('log', '-1', '--format=%s').toString(),
    /Write worker-a.txt/,
  );
  console.log('G3 worker screenshots saved and merge verified.');
} catch (error) {
  const log = await readFile(join(data, 'logs', 'main.log'), 'utf8').catch(
    () => '',
  );
  console.error(log.split('\n').slice(-12).join('\n'));
  throw error;
} finally {
  await application?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
}
