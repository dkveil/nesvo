import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { chromium, _electron as electron } from 'playwright';
import { createProfileDirectory } from '../apps/host/tests/provider-profile-directory.mjs';
import { smokeGateRuleFlow } from './gate-rule-flow-smoke.mjs';
import { smokeManagerImport } from './manager-import-smoke.mjs';
import { smokePortableCheck } from './portable-check-smoke.mjs';
import { EXPIRED_SHARE_ID, startShareServer } from './share-server-fixture.mjs';

const setupStage = process.env.NESVO_D89_SMOKE_STAGE;
if (!setupStage && process.env.NESVO_D83_DEMO_ONLY !== '1') {
  await smokeManagerImport();
  await import('./d87-desktop-smoke.mjs');
}

const directory = await realpath(
  await mkdtemp(join(tmpdir(), 'nesvo-desktop-')),
);
const pidFile = join(directory, 'processes.json');
const providerPidFile = join(directory, 'provider.json');
const codexPidFile = join(directory, 'codex-provider.json');
const workerPidDirectory = join(directory, 'worker-processes');
const claudeConfigDirectory = join(directory, 'claude-config');
const codexConfigDirectory = join(directory, 'codex-config');
const skillsLog = join(directory, 'skills-probes.jsonl');
const usageLog = join(directory, 'usage-probes.jsonl');
const usageControl = join(directory, 'usage-control.json');
const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
const executablePath = requireDesktop('electron');
const env = {
  ...process.env,
  NESVO_SMOKE_TEST: '1',
  NESVO_TEST_MODE: '1',
  NESVO_TEST_FULL_ACCESS: '1',
  NESVO_MOBILE_PORT: '0',
  NESVO_MOBILE_BIND: '127.0.0.1',
  NESVO_WORKFLOWS_HOME: join(directory, 'workflows-home'),
  NESVO_DATA_DIR: directory,
  NESVO_TEST_PID_FILE: pidFile,
  NESVO_TEST_COMMAND_LOG: join(directory, 'commands.jsonl'),
  NESVO_CLAUDE_EXECUTABLE: resolve('apps/host/tests/claude-fixture.mjs'),
  NESVO_FIXTURE_PID_FILE: providerPidFile,
  NESVO_FIXTURE_SKILL_LOG: join(directory, 'shared-instructions.jsonl'),
  NESVO_FIXTURE_USAGE_LOG: usageLog,
  NESVO_FIXTURE_USAGE_CONTROL: usageControl,
  NESVO_CODEX_EXECUTABLE: resolve('apps/host/tests/codex-fixture.mjs'),
  NESVO_CODEX_FIXTURE_PID_FILE: codexPidFile,
  NESVO_CODEX_FIXTURE_PID_DIR: workerPidDirectory,
  NESVO_CODEX_FIXTURE_STATE_DIR: join(directory, 'codex-state'),
  NESVO_CODEX_FIXTURE_SKILLS_LOG: skillsLog,
  NESVO_CODEX_FIXTURE_RUN_LOG: join(directory, 'codex-turns.jsonl'),
  CLAUDE_CONFIG_DIR: claudeConfigDirectory,
  CODEX_HOME: codexConfigDirectory,
  NESVO_TEST_SKILLS_HOME: join(directory, 'skills-home'),
  T3CODE_HOME: join(directory, 'empty-t3'),
  NESVO_TEST_AGENT_DECK_ROOT: join(directory, 'empty-agent-deck'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.NESVO_WORK_LAPTOP_MODE;
delete env.NESVO_MOBILE_TLS_CERT;
delete env.NESVO_MOBILE_TLS_KEY;
delete env.NESVO_MOBILE_PUBLIC_URL;
delete env.NESVO_MOBILE_TRUSTED_PROXY;
const localShareOrigin = process.env.NESVO_SMOKE_SHARE_ORIGIN;
if (
  localShareOrigin &&
  !/^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(localShareOrigin)
)
  throw new Error('NESVO_SMOKE_SHARE_ORIGIN must be a loopback http origin.');
const shareServer = localShareOrigin
  ? { origin: localShareOrigin, fake: false, close: async () => undefined }
  : { ...(await startShareServer()), fake: true };
env.NESVO_SHARE_ORIGIN = shareServer.origin;
const readSharedBundle = async id => {
  const response = await fetch(`${shareServer.origin}/api/shares/${id}`);
  return {
    status: response.status,
    expiresAt: response.headers.get('nesvo-share-expires-at'),
    bundle: response.ok ? await response.json() : null,
  };
};
let application;
let hostPid;
const fullSessions = target =>
  target.evaluate(async () =>
    Promise.all(
      (await window.nesvo.listSessions()).map(session =>
        session.messageCount > session.messages.length
          ? window.nesvo.getSession(
              { sessionId: session.id, limit: 200 },
              session.hostId,
            )
          : session,
      ),
    ),
  );
const byId = values =>
  values.toSorted((left, right) => left.id.localeCompare(right.id));
const launchArgs = [resolve('apps/desktop')];
const configurationScreenshots = process.env.NESVO_D85_SCREENSHOTS;
const setupScreenshots = process.env.NESVO_D89_SCREENSHOTS;
const inboxOutcomeScreenshots = process.env.NESVO_INBOX_OUTCOME_SCREENSHOT_DIR;
const d88Screenshots = process.env.NESVO_D88_SCREENSHOTS;
const d83CdpPort = process.env.NESVO_D83_CDP_PORT;
if (setupStage)
  launchArgs.push('--remote-debugging-port=0', '--force-device-scale-factor=1');
else if (configurationScreenshots)
  launchArgs.push(
    '--remote-debugging-port=9250',
    '--force-device-scale-factor=1',
  );
else if (d88Screenshots)
  launchArgs.push(
    '--remote-debugging-port=9249',
    '--force-device-scale-factor=1',
  );
else if (d83CdpPort)
  launchArgs.push(
    '--remote-debugging-port=' + d83CdpPort,
    '--force-device-scale-factor=1',
  );
else if (inboxOutcomeScreenshots)
  launchArgs.push('--remote-debugging-port=9244');
const launchApplication = (overrides = {}) =>
  electron.launch({
    executablePath,
    args: launchArgs,
    env: { ...env, ...overrides },
    timeout: 30000,
  });
let smokeFailure;
async function setupShot(app, page, name, ready) {
  if (!setupScreenshots) return;
  await mkdir(setupScreenshots, { recursive: true });
  for (const size of [
    [1280, 800],
    [1920, 1080],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, [width, height]) =>
        BrowserWindow.getAllWindows()[0].setContentSize(width, height),
      size,
    );
    await page.waitForFunction(
      ([width, height]) => innerWidth === width && innerHeight === height,
      size,
    );
    await ready?.scrollIntoViewIfNeeded();
    const capture = () =>
      app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
          .toPNG()
          .toString('base64'),
      );
    await capture();
    await delay(350);
    const screenshot = Buffer.from(await capture(), 'base64');
    assert.deepEqual(
      [screenshot.readUInt32BE(16), screenshot.readUInt32BE(20)],
      size,
    );
    await writeFile(
      join(setupScreenshots, `${name}-${size.join('x')}.png`),
      screenshot,
    );
  }
}

async function smokeSetupProfile() {
  if (setupStage === 'D') {
    await mkdir(claudeConfigDirectory, { recursive: true });
    await writeFile(
      join(claudeConfigDirectory, 'settings.json'),
      JSON.stringify({ hooks: { SessionStart: [] } }),
    );
  }
  const file = join(directory, 'profile.yaml');
  const shared = join(directory, 'shared.yaml');
  const machine = join(directory, 'machine.yaml');
  const machineDocument = 'version: 1\n';
  await writeFile(
    shared,
    'version: 1\ninbox:\n  defaultRoute: parent\nrecipes:\n  - id: prepare\n    name: Prepare checkout\n    repository: git.example.test/org/project\n    setup:\n      - executable: prepare\n        argv: []\n',
  );
  await writeFile(machine, machineDocument);
  await writeFile(
    file,
    'version: 1\ninclude:\n  shared: shared.yaml\n  machine: machine.yaml\n',
  );
  application = await launchApplication({ NESVO_PROFILE_PATH: file });
  const page = await application.firstWindow();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  hostPid = JSON.parse(await readFile(pidFile, 'utf8')).host;
  await page.getByRole('button', { name: 'Your setup', exact: true }).click();
  await page.getByText('Profile ready to review').waitFor();
  await page.getByText('Inbox → Parent session').waitFor();
  await setupShot(application, page, 'stage-a-profile-review');
  await page.getByRole('button', { name: 'Review sources' }).click();
  await page.getByText('Awaiting review on this computer').waitFor();
  await setupShot(application, page, 'stage-a-profile-sources');
  await page.getByRole('button', { name: 'Close profile sources' }).click();
  await page.getByRole('button', { name: 'Load profile' }).click();
  await page.getByText('Active profile', { exact: true }).waitFor();
  if (setupStage === 'D') {
    await page
      .getByRole('button', { name: 'Ask about setup', exact: true })
      .click();
    const drawer = page.getByLabel('Setup assistant', { exact: true });
    await drawer.getByRole('combobox', { name: 'Provider' }).click();
    await page.getByRole('option', { name: 'Codex', exact: true }).click();
    await drawer.getByRole('combobox', { name: 'Model' }).click();
    await page.getByRole('listbox').getByRole('option').first().click();
    const ask = async text => {
      await drawer
        .getByRole('textbox', { name: 'Message to setup assistant' })
        .fill(text);
      await drawer
        .getByRole('button', { name: 'Send to setup assistant' })
        .click();
    };
    await ask('Which hook is configured?');
    await drawer
      .getByText('SessionStart was observed. Runtime loading is unverified.')
      .waitFor();
    await drawer
      .getByRole('textbox', { name: 'Message to setup assistant' })
      .scrollIntoViewIfNeeded();
    await setupShot(application, page, 'stage-d-hook-answer');
    await ask(
      'Propose recipe using prepare-demo --verify for git.example.test/org/project',
    );
    const recipe = drawer.getByRole('article', {
      name: 'Configuration change Verify checkout',
    });
    await recipe
      .getByRole('button', { name: 'Review diff for Verify checkout' })
      .click();
    const accept = recipe.getByRole('button', { name: 'Accept', exact: true });
    await setupShot(application, page, 'stage-d-assistant-proposal', accept);
    await accept.click();
    const confirm = page.getByRole('alertdialog', {
      name: 'Save profile recipe',
      exact: true,
    });
    await confirm
      .getByRole('button', { name: 'Save recipe', exact: true })
      .click();
    await recipe.getByText('Applied', { exact: true }).waitFor();
    assert.match(await readFile(machine, 'utf8'), /executable: prepare-demo/);
    await recipe.getByRole('button', { name: 'Undo', exact: true }).click();
    await recipe.getByText('Undone', { exact: true }).waitFor();
    assert.equal(await readFile(machine, 'utf8'), machineDocument);
    console.log(
      JSON.stringify({
        result: 'passed',
        scenario: 'setup assistant profile recipe and undo',
        stage: setupStage,
        platform: process.platform,
      }),
    );
    return;
  }
  if (setupStage === 'C') {
    await page
      .getByRole('button', { name: 'Close settings', exact: true })
      .click();
    await page.getByRole('button', { name: 'Inbox', exact: true }).click();
    const pending = page.getByRole('article', {
      name: 'Configuration change Prepare checkout',
    });
    await pending
      .getByRole('button', { name: 'Review diff for Prepare checkout' })
      .click();
    await pending
      .getByText('Runtime verification is unavailable on this computer.')
      .waitFor();
    await pending.locator('[data-line]').first().waitFor();
    assert.equal(
      await pending
        .getByRole('button', { name: 'Accept', exact: true })
        .count(),
      0,
    );
    await setupShot(application, page, 'stage-c-local-review-withheld');
    assert.equal(
      (await page.evaluate(() => window.nesvo.listSessions())).length,
      0,
    );
    console.log(
      JSON.stringify({
        result: 'passed',
        scenario: 'unavailable runtime stays withheld',
        stage: setupStage,
        platform: process.platform,
      }),
    );
    return;
  }
  await page.getByRole('button', { name: 'Inbox rules', exact: true }).click();
  await page.getByRole('button', { name: 'Edit profile setting' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit profile setting' });
  await editor.getByRole('combobox', { name: 'Default Inbox route' }).click();
  await page.getByRole('option', { name: 'Inbox and parent session' }).click();
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  await setupShot(application, page, 'stage-a-managed-routing');
  await editor.getByRole('button', { name: 'Save profile setting' }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.match(await readFile(machine, 'utf8'), /defaultRoute: both/);
  await page.getByRole('button', { name: 'Open Change history' }).click();
  const route = page.getByRole('article', {
    name: 'Configuration change Profile Inbox route',
  });
  await route
    .getByRole('button', { name: 'Review diff for Profile Inbox route' })
    .click();
  await route.getByRole('button', { name: 'Undo', exact: true }).click();
  await route.getByText('Undone', { exact: true }).waitFor();
  assert.equal(await readFile(machine, 'utf8'), machineDocument);
  await page
    .getByRole('button', { name: 'Close settings', exact: true })
    .click();
  await writeFile(machine, 'version: 1\ninbox: {defaultRoute: both}\n');
  await page
    .getByRole('button', { name: 'Review setup changes', exact: true })
    .click();
  await page
    .getByText('From profile · Inbox and parent session', { exact: true })
    .waitFor();
  console.log(
    JSON.stringify({
      result: 'passed',
      scenario: 'setup profile',
      stage: setupStage,
      platform: process.platform,
    }),
  );
}

async function smokeSetupDetection() {
  const file = join(directory, 'profile.yaml');
  const fixtureConfig = join(claudeConfigDirectory, 'settings.json');
  await mkdir(claudeConfigDirectory, { recursive: true });
  await writeFile(
    fixtureConfig,
    JSON.stringify({
      hooks: { SessionStart: [] },
      mcpServers: { 'demo-review': { command: 'fixture-never-run' } },
    }),
  );
  application = await launchApplication({
    NESVO_PROFILE_PATH: file,
    NESVO_TEST_SHOW_ONBOARDING: '1',
  });
  const page = await application.firstWindow();
  const guide = page.getByRole('main', {
    name: 'Getting started',
    exact: true,
  });
  hostPid = JSON.parse(await readFile(pidFile, 'utf8')).host;
  await guide.getByRole('button', { name: 'Get started' }).click();
  await guide.getByRole('button', { name: 'Skip this step' }).click();
  await guide
    .getByRole('heading', { name: 'Computers', exact: true })
    .waitFor();
  await guide.getByRole('button', { name: 'Continue', exact: true }).click();
  await guide
    .getByRole('heading', { name: 'Your setup', exact: true })
    .waitFor();
  await guide.getByText('No profile found', { exact: true }).waitFor();
  await guide
    .getByText('Claude Code user configuration', { exact: true })
    .waitFor();
  await setupShot(application, page, 'stage-b-guide-without-profile');
  await writeFile(file, 'version: 1\ninbox:\n  defaultRoute: both\n');
  await guide.getByRole('button', { name: 'Refresh', exact: true }).click();
  await guide.getByText('Profile ready to review', { exact: true }).waitFor();
  await guide
    .getByRole('button', { name: 'Skip profile', exact: true })
    .click();
  await guide.getByText('Profile skipped', { exact: true }).waitFor();
  await guide
    .getByRole('button', { name: 'Show profile', exact: true })
    .click();
  await guide
    .getByRole('button', { name: 'Load profile', exact: true })
    .click();
  await guide.getByText('Active profile', { exact: true }).waitFor();
  await guide
    .getByRole('button', { name: 'Sessions to import', exact: true })
    .click();
  await guide.getByRole('button', { name: 'Open import', exact: true }).click();
  assert.equal(
    (await page.evaluate(() => window.nesvo.listSessions())).length,
    0,
  );
  await guide.getByRole('button', { name: 'Finish setup later' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Your setup', exact: true }).click();
  await page.getByText('Active profile', { exact: true }).waitFor();
  await page
    .getByText('Claude Code user configuration', { exact: true })
    .waitFor();
  await page
    .getByRole('button', { name: 'Mark reviewed', exact: true })
    .click();
  await page.getByRole('button', { name: 'Show current setup' }).waitFor();
  await writeFile(
    fixtureConfig,
    JSON.stringify({
      hooks: { SessionStart: [], Stop: [] },
      mcpServers: { 'demo-review': { command: 'fixture-never-run' } },
    }),
  );
  await page
    .getByRole('button', { name: 'Close settings', exact: true })
    .click();
  await page.getByText(/Setup changed on .*1 finding changed/).waitFor();
  await page
    .getByRole('button', { name: 'Review setup changes', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Review changes', exact: true })
    .click();
  await page
    .getByText(/Hook events: SessionStart, Stop/)
    .last()
    .waitFor();
  await page
    .getByRole('heading', { name: 'Setup changed', exact: true })
    .scrollIntoViewIfNeeded();
  assert.equal(
    await page.getByText('Active profile', { exact: true }).count(),
    1,
  );
  await setupShot(application, page, 'stage-b-setup-changed');
  await page.getByRole('button', { name: 'Close setup review' }).click();
  assert.equal(
    (await page.evaluate(() => window.nesvo.listSessions())).length,
    0,
  );
  console.log(
    JSON.stringify({
      result: 'passed',
      scenario: 'passive setup detection',
      stage: setupStage,
      platform: process.platform,
    }),
  );
}

async function configurationShot(app, page, name, ready) {
  if (!configurationScreenshots) return;
  await mkdir(configurationScreenshots, { recursive: true });
  const original = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentSize(),
  );
  for (const size of [
    [1920, 1080],
    [1280, 800],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, [width, height]) =>
        BrowserWindow.getAllWindows()[0].setContentSize(width, height),
      size,
    );
    await page.waitForFunction(
      ([width, height]) => innerWidth === width && innerHeight === height,
      size,
    );
    await ready?.(size);
    await page.evaluate(
      () =>
        new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await delay(200);
    const image = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString('base64'),
    );
    await writeFile(
      join(configurationScreenshots, `${name}-${size.join('x')}.png`),
      Buffer.from(image, 'base64'),
    );
  }
  await app.evaluate(
    ({ BrowserWindow }, [width, height]) =>
      BrowserWindow.getAllWindows()[0].setContentSize(width, height),
    original,
  );
  await page.waitForFunction(
    ([width, height]) => innerWidth === width && innerHeight === height,
    original,
  );
}

async function smokeConfigurationInbox(app, page) {
  await page.waitForFunction(async () =>
    (await window.nesvo.listComputers()).some(
      computer =>
        computer.id === 'local' &&
        computer.status === 'connected' &&
        computer.capabilities.includes('configuration'),
    ),
  );
  const closeSettings = page.getByRole('button', {
    name: 'Close settings',
    exact: true,
  });
  if (await closeSettings.isVisible()) await closeSettings.click();
  const device = await page.evaluate(() =>
    window.nesvo.enrollExternalInboxDevice({ name: 'Fixture Sender' }, 'local'),
  );
  const cliEnv = {
    ...env,
    NESVO_INBOX_TOKEN: device.token,
    NESVO_INBOX_CONFIG: '',
    NESVO_INBOX_SSH: '',
  };
  const post = await promisify(execFile)(
    process.execPath,
    [
      'apps/host/dist/cli.js',
      'inbox',
      'post',
      '--title',
      'Release check',
      '--body',
      'The test release has passed its checks.',
      '--actions',
      'Review,Decline',
      '--json',
    ],
    { env: cliEnv, windowsHide: true },
  );
  const item = JSON.parse(post.stdout);
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  const source = page.getByRole('article', {
    name: 'External Inbox item: Release check',
  });
  const row = page.locator('[data-inbox-row]').filter({ has: source });
  await row.getByRole('button', { name: 'Inbox item actions' }).click();
  await page
    .getByRole('menuitem', { name: 'Change how this reaches me' })
    .click();
  const drawer = page.locator(
    '[data-slot="side-panel"][aria-label="Inbox assistant"]',
  );
  await drawer.getByText('Why this is here').waitFor();
  const input = drawer.getByRole('textbox', {
    name: 'Message to Inbox assistant',
  });
  await input.fill('Keep future external items in the Inbox.');
  await drawer.getByRole('button', { name: 'Send to Inbox assistant' }).click();
  const proposal = drawer.getByRole('article', {
    name: 'Configuration change external-inbox-fixture',
  });
  await proposal
    .getByRole('button', { name: 'Review diff for external-inbox-fixture' })
    .click();
  await configurationShot(
    app,
    page,
    'stage-1-inbox-assistant',
    async ([width]) => {
      await proposal.locator('[data-line]').first().waitFor();
      if (width !== 1280) return;
      const layout = await source
        .locator(':scope > [data-slot="list-row"]')
        .evaluate(row => getComputedStyle(row.firstElementChild).display);
      assert.equal(layout, 'flex');
    },
  );
  await proposal.getByRole('button', { name: 'Accept', exact: true }).click();
  await proposal.getByRole('button', { name: 'Undo', exact: true }).click();
  await proposal.getByText('Undone', { exact: true }).waitFor();
  await drawer.getByRole('button', { name: 'Close Inbox assistant' }).click();
  const unchanged = await promisify(execFile)(
    process.execPath,
    ['apps/host/dist/cli.js', 'inbox', 'status', item.id, '--json'],
    { env: cliEnv, windowsHide: true },
  );
  assert.equal(JSON.parse(unchanged.stdout).status, 'pending');
  await promisify(execFile)(
    process.execPath,
    ['apps/host/dist/cli.js', 'inbox', 'cancel', item.id],
    { env: cliEnv, windowsHide: true },
  );
  await page.evaluate(
    id => window.nesvo.revokeExternalInboxDevice({ deviceId: id }, 'local'),
    device.device.id,
  );
}

async function smokeConfigurationProfile(app, page) {
  const enrollment = await page.evaluate(() =>
    window.nesvo.configuration.enroll(
      {
        name: 'Fixture profile device',
        grants: [
          { area: 'steps', verbs: ['propose'], global: true, projects: [] },
          {
            area: 'authority',
            verbs: ['read', 'propose', 'apply'],
            global: true,
            projects: [],
          },
          { area: 'lessons', verbs: ['propose'], global: true, projects: [] },
          {
            area: 'session-groups',
            verbs: ['read', 'apply'],
            global: true,
            projects: [],
          },
          { area: 'budgets', verbs: ['propose'], global: true, projects: [] },
          {
            area: 'automations',
            verbs: ['propose'],
            global: true,
            projects: [],
          },
          {
            area: 'appearance',
            verbs: ['read', 'apply'],
            projects: [],
            global: true,
          },
          {
            area: 'inbox-rules',
            verbs: ['propose'],
            projects: [],
            global: true,
          },
        ],
      },
      'local',
    ),
  );
  assert.ok(enrollment.token);
  const cli = async (args, token = enrollment.token) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['apps/host/dist/cli.js', 'config', ...args, '--json'],
      {
        windowsHide: true,
        env: {
          ...env,
          NESVO_CONFIG_TOKEN: token,
          NESVO_CONFIG_SSH: '',
          NESVO_CONFIG_CONFIG: '',
        },
      },
    );
    return JSON.parse(stdout);
  };
  const existing = await cli(['get', 'appearance', 'color-scheme']);
  assert.ok(existing.ok);
  const scheme = existing.target.value.value === 'light' ? 'dark' : 'light';
  const input = join(directory, 'configuration-fixture.json');
  await writeFile(
    input,
    JSON.stringify({ kind: 'color-scheme', value: scheme }),
  );
  const command = [
    'apply',
    'appearance',
    'color-scheme',
    '--op',
    'update',
    '--action-id',
    randomUUID(),
    '--base',
    String(existing.target.version.revision),
    '--input-file',
    input,
  ];
  const applied = await cli(command);
  assert.equal(applied.receipt.status, 'applied');
  assert.deepEqual((await cli(command)).receipt, applied.receipt);
  await page.waitForFunction(
    async expected => (await window.nesvo.colorScheme()) === expected,
    scheme,
  );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('button', { name: 'Change history', exact: true })
    .click();
  const history = page.getByRole('article', {
    name: 'Configuration change Color scheme',
  });
  await history
    .getByRole('button', { name: 'Review diff for Color scheme' })
    .click();
  await configurationShot(app, page, 'stage-3-change-history', () =>
    history.locator('[data-line]').first().waitFor(),
  );
  await history.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForFunction(
    async expected => (await window.nesvo.colorScheme()) === expected,
    existing.target.value.value,
  );
  await page
    .getByRole('button', { name: 'Close settings', exact: true })
    .click();
  await writeFile(
    input,
    JSON.stringify({
      kind: 'markdown',
      document:
        '---\nname: cli-delivery\ntrigger: external\naction: route\nroute: inbox\n---\n',
    }),
  );
  const proposal = await cli([
    'propose',
    'inbox-rules',
    'cli-delivery',
    '--op',
    'create',
    '--action-id',
    randomUUID(),
    '--base',
    'absent',
    '--input-file',
    input,
  ]);
  assert.equal(proposal.receipt.status, 'pending');
  const inbox = page.getByRole('region', { name: 'Inbox', exact: true });
  const row = inbox.getByRole('article', {
    name: 'Configuration change cli-delivery',
  });
  const manualRules = await page.evaluate(() =>
    window.nesvo.saveInboxRule(
      {
        scope: 'global',
        expectedHash: null,
        text: '---\nname: cli-delivery\ntrigger: external\naction: route\nroute: both\n---\n',
      },
      'local',
    ),
  );
  const manual = manualRules.rules.find(rule => rule.name === 'cli-delivery');
  assert.ok(manual);
  await row
    .getByRole('button', { name: 'Review diff for cli-delivery' })
    .click();
  await row.getByRole('button', { name: 'Accept', exact: true }).click();
  await row.getByText('Needs a fresh proposal', { exact: true }).waitFor();
  await row
    .getByText('The target changed after this preview. Review an updated diff.')
    .waitFor();
  await page.evaluate(
    expectedHash =>
      window.nesvo.deleteInboxRule(
        { scope: 'global', name: 'cli-delivery', expectedHash },
        'local',
      ),
    manual.contentHash,
  );
  await row.getByRole('button', { name: 'Prepare fresh draft' }).click();
  await page
    .getByRole('dialog', { name: 'Edit proposal' })
    .getByRole('button', { name: 'Review updated diff' })
    .click();
  await row.getByText('Needs review', { exact: true }).waitFor();
  await row.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await row.waitFor({ state: 'hidden' });
  const steps = [
    {
      area: 'steps',
      name: 'review-release',
      draft: {
        kind: 'markdown',
        document:
          '---\nname: review-release\ntype: agent\nphase: pre-done\n---\nReview the release report.\n',
      },
    },
    {
      area: 'lessons',
      name: 'new',
      draft: {
        kind: 'entry',
        value: {
          description: 'Applies when reviewing a release.',
          kind: 'instruction',
          status: 'active',
          body: {
            rule: 'Read the release report.',
            why: 'It records the checks.',
            check: 'Read the report.',
          },
        },
      },
    },
  ];
  const saved = [];
  for (const definition of steps) {
    await writeFile(input, JSON.stringify(definition.draft));
    const proposed = await cli([
      'propose',
      definition.area,
      definition.name,
      '--op',
      'create',
      '--action-id',
      randomUUID(),
      '--base',
      'absent',
      '--input-file',
      input,
    ]);
    assert.equal(proposed.receipt.status, 'pending');
    const name = proposed.change.target.name;
    const proposalRow = inbox.getByRole('article', {
      name: `Configuration change ${name}`,
    });
    await proposalRow
      .getByRole('button', { name: `Review diff for ${name}` })
      .click();
    if (definition.area === 'lessons')
      await configurationShot(app, page, 'stage-4-definition-review', () =>
        proposalRow.locator('[data-line]').first().waitFor(),
      );
    await proposalRow
      .getByRole('button', { name: 'Accept', exact: true })
      .click();
    await proposalRow.waitFor({ state: 'hidden' });
    saved.push(proposed.receipt.id);
  }
  for (const id of saved.reverse()) {
    const undone = await page.evaluate(async changeId => {
      const listed = await window.nesvo.configuration.history(
        { status: 'applied' },
        'local',
      );
      const change = listed.page.changes.find(item => item.id === changeId);
      return window.nesvo.configuration.undo(
        {
          id: change.id,
          revision: change.revision,
          actionId: crypto.randomUUID(),
        },
        'local',
      );
    }, id);
    assert.equal(undone.receipt.status, 'undone');
  }
  const groupId = randomUUID();
  await page.evaluate(
    id =>
      window.nesvo.createSessionGroup(
        { groupId: id, name: 'Release' },
        'local',
      ),
    groupId,
  );
  const group = (await cli(['get', 'session-groups', groupId])).target;
  await writeFile(
    input,
    JSON.stringify({
      ...group.value,
      value: { ...group.value.value, name: 'Release reviews' },
    }),
  );
  const renamed = await cli([
    'apply',
    'session-groups',
    groupId,
    '--op',
    'update',
    '--action-id',
    randomUUID(),
    '--base',
    String(group.version.revision),
    '--input-file',
    input,
  ]);
  assert.equal(renamed.receipt.status, 'applied');
  const jobId = randomUUID();
  for (const definition of [
    {
      area: 'budgets',
      id: randomUUID(),
      name: 'Computer budget',
      draft: {
        kind: 'budgets',
        value: {
          scope: 'computer',
          period: 'day',
          limitUsd: 1000000,
          action: 'refuse-new-turns',
        },
      },
    },
    {
      area: 'automations',
      id: jobId,
      name: 'Daily release review',
      draft: {
        kind: 'automations',
        value: {
          name: 'Daily release review',
          directory,
          prompt: 'Read the release report.',
          provider: 'codex',
          model: 'fixture-codex',
          effort: null,
          mode: 'read-only',
          active: false,
          schedule: { kind: 'daily', time: '09:00' },
          timeZone: 'UTC',
        },
      },
    },
  ]) {
    await writeFile(input, JSON.stringify(definition.draft));
    const requested = await cli([
      'propose',
      definition.area,
      definition.id,
      '--op',
      'create',
      '--action-id',
      randomUUID(),
      '--base',
      'absent',
      '--input-file',
      input,
    ]);
    assert.equal(requested.receipt.status, 'pending');
    const change = inbox.getByRole('article', {
      name: `Configuration change ${definition.name}`,
    });
    await change
      .getByRole('button', { name: `Review diff for ${definition.name}` })
      .click();
    await change.getByRole('button', { name: 'Accept', exact: true }).click();
    if (definition.area === 'budgets') {
      const confirmation = page.getByRole('alertdialog', {
        name: 'Confirm configuration change',
      });
      await confirmation.waitFor();
      await configurationShot(app, page, 'stage-5-budget-review');
      await confirmation
        .getByRole('button', { name: 'Confirm and accept' })
        .click();
    }
    await change.waitFor({ state: 'hidden' });
  }
  assert.equal(
    await page.evaluate(async id => {
      const job = (await window.nesvo.scheduledJobs.list('local')).find(
        item => item.id === id,
      );
      const page = await window.nesvo.scheduledJobs.listRuns('local', id, null);
      return !!job && !job.active && page.runs.length === 0;
    }, jobId),
    true,
  );
  const workspace = join(directory, 'permission-review');
  await mkdir(workspace);
  const session = await page.evaluate(
    folder =>
      window.nesvo.createSession({
        provider: 'Codex',
        model: 'fixture-codex',
        mode: 'read-only',
        title: 'Release review',
        directory: folder,
      }),
    workspace,
  );
  const current = (await cli(['get', 'authority', session.id])).target;
  const mcp = spawn(process.execPath, ['apps/host/dist/cli.js', 'mcp'], {
    env: {
      ...env,
      NESVO_CONFIG_TOKEN: enrollment.token,
      NESVO_CONFIG_SSH: '',
      NESVO_CONFIG_CONFIG: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const exited = once(mcp, 'exit');
  const output = createInterface({ input: mcp.stdout });
  const lines = output[Symbol.asyncIterator]();
  let next = 1;
  const send = (method, params, id) =>
    mcp.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n',
    );
  const mcpRequest = async (method, params) => {
    const id = next++;
    send(method, params, id);
    const response = JSON.parse((await lines.next()).value);
    assert.equal(response.id, id);
    return response.result;
  };
  const mutation = {
    target: current.target,
    baseVersion: current.version,
    actionId: randomUUID(),
    operation: 'update',
    draft: { kind: 'authority', value: 'supervised' },
  };
  try {
    assert.ok(
      await mcpRequest('initialize', { protocolVersion: '2025-11-25' }),
    );
    send('notifications/initialized');
    const call = name =>
      mcpRequest('tools/call', { name, arguments: mutation });
    assert.equal(
      (await call('config_apply')).structuredContent.code,
      'review-required',
    );
    assert.equal(
      (await call('config_propose')).structuredContent.receipt.status,
      'pending',
    );
  } finally {
    output.close();
    mcp.stdin.end();
    await exited;
  }
  const permission = inbox.getByRole('article', {
    name: 'Configuration change Release review',
  });
  await permission
    .getByRole('button', { name: 'Review diff for Release review' })
    .click();
  await permission
    .getByRole('button', { name: 'Review permission change' })
    .click();
  const permissionDialog = page.getByRole('alertdialog', {
    name: 'Confirm session permission change',
  });
  await permissionDialog.getByText(/Read-only to Workspace edits/i).waitFor();
  await configurationShot(app, page, 'stage-6-authority');
  await permissionDialog
    .getByRole('button', { name: 'Change permission mode' })
    .click();
  await permission.waitFor({ state: 'hidden' });
  const updated = await page.evaluate(
    id => window.nesvo.getSession({ sessionId: id }),
    session.id,
  );
  assert.equal(updated.mode, 'supervised');
  assert.equal(updated.messageCount, 0);
  const authorityDevice = await page.evaluate(() =>
    window.nesvo.configuration.enroll(
      {
        name: 'Fixture authority device',
        grants: [
          {
            area: 'authority',
            verbs: ['read', 'propose'],
            global: true,
            projects: [],
          },
        ],
      },
      'local',
    ),
  );
  const authorityCli = args => cli(args, authorityDevice.token);
  const proposeAuthority = async (id, value) => {
    const { target } = await authorityCli(['get', 'authority', id]);
    await writeFile(input, JSON.stringify({ kind: 'authority', value }));
    const proposed = await authorityCli([
      'propose',
      'authority',
      id,
      '--op',
      'update',
      '--action-id',
      randomUUID(),
      '--base',
      String(target.version.revision),
      '--input-file',
      input,
    ]);
    assert.equal(proposed.receipt.status, 'pending');
    return proposed.change;
  };
  const openAuthority = async name => {
    const change = inbox.getByRole('article', {
      name: `Configuration change ${name}`,
    });
    await change
      .getByRole('button', { name: `Review diff for ${name}` })
      .click();
    await change.getByRole('button', { name: 'Open confirmation' }).click();
  };
  const waitForAuthority = async (read, reason) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = await read();
      if (value) return value;
      await delay(100);
    }
    throw new Error(reason);
  };
  const waitForOutcome = id =>
    waitForAuthority(
      () =>
        page.evaluate(async changeId => {
          const result = await window.nesvo.configuration.history(
            { area: 'authority' },
            'local',
          );
          return result.page.changes.find(
            change =>
              change.id === changeId &&
              change.status === 'applied' &&
              change.outcome,
          );
        }, id),
      'The native confirmation receipt did not settle.',
    );
  await page.evaluate(() =>
    window.nesvo.claudeAutonomy(
      { action: 'set-full-access', enabled: true },
      'local',
    ),
  );
  const fullAccess = await proposeAuthority(session.id, 'full-access');
  await openAuthority('Release review');
  const fullDialog = page.getByRole('dialog', {
    name: 'Allow Full access in this session?',
  });
  await fullDialog.waitFor();
  assert.equal(
    await fullDialog
      .getByRole('button', { name: 'Allow Full access' })
      .isEnabled(),
    false,
  );
  await configurationShot(app, page, 'follow-up-full-access');
  await fullDialog.getByRole('checkbox', { name: 'I understand' }).click();
  await fullDialog.getByRole('button', { name: 'Allow Full access' }).click();
  await waitForOutcome(fullAccess.id);
  const fullSession = await page.evaluate(
    id => window.nesvo.getSession({ sessionId: id }),
    session.id,
  );
  assert.equal(fullSession.mode, 'full-access');
  assert.equal(fullSession.messageCount, 0);
  await page.evaluate(() =>
    window.nesvo.claudeAutonomy(
      { action: 'set-full-access', enabled: false },
      'local',
    ),
  );
  const host = await page.evaluate(
    async () =>
      (await window.nesvo.listComputers()).find(
        computer => computer.id === 'local',
      ).instanceId,
  );
  const device = await proposeAuthority(`devices/${host}`, {
    kind: 'devices',
    name: 'Reviewed fixture device',
  });
  await openAuthority('Devices');
  const nativeDevice = page.getByRole('dialog', {
    name: 'Enroll configuration device',
  });
  await nativeDevice.getByRole('textbox', { name: 'Device name' }).waitFor();
  assert.equal(
    await nativeDevice
      .getByRole('textbox', { name: 'Device name' })
      .inputValue(),
    'Reviewed fixture device',
  );
  assert.equal(
    await nativeDevice
      .getByRole('button', { name: 'Enroll device', exact: true })
      .isEnabled(),
    false,
  );
  await nativeDevice
    .getByRole('checkbox', { name: 'Appearance', exact: true })
    .check();
  await configurationShot(app, page, 'follow-up-devices');
  await nativeDevice
    .getByRole('button', { name: 'Enroll device', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Device token' })
    .getByRole('button', { name: 'Done' })
    .click();
  await waitForOutcome(device.id);
  await page
    .getByRole('button', { name: 'Close settings', exact: true })
    .click();
  const phone = await proposeAuthority(`phone-access/${host}`, {
    kind: 'phone-access',
    action: 'enable',
  });
  await openAuthority('Phone access');
  await page.getByText('Review the proposal to enable Phone access.').waitFor();
  await configurationShot(app, page, 'follow-up-phone-access');
  await page.getByRole('button', { name: 'Enable phone access' }).click();
  await waitForOutcome(phone.id);
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await page.getByText('Phone access is off', { exact: true }).waitFor();
  await page
    .getByRole('button', { name: 'Close settings', exact: true })
    .click();
  const claude = await page.evaluate(
    folder =>
      window.nesvo.createSession({
        provider: 'Claude Code',
        model: 'sonnet',
        mode: 'auto',
        directory: folder,
        title: 'Rule confirmation fixture',
      }),
    workspace,
  );
  await page.evaluate(
    sessionId =>
      window.nesvo.sendMessage({
        sessionId,
        messageId: crypto.randomUUID(),
        text:
          'fixture:autonomy ' +
          JSON.stringify([
            { tool: 'Bash', input: { command: 'git status --short' } },
          ]),
      }),
    claude.id,
  );
  const approval = await waitForAuthority(
    () =>
      page.evaluate(
        async sessionId =>
          (await window.nesvo.getSession({ sessionId })).pendingApprovals.find(
            item => item.allowPattern,
          ),
        claude.id,
      ),
    'The fixture did not produce an eligible Claude operation.',
  );
  const { id: requestId } = approval;
  const rule = await proposeAuthority(`claude-allow-rule/${requestId}`, {
    kind: 'claude-allow-rule',
    scope: 'session',
  });
  await openAuthority('Claude allow rule');
  const ruleDialog = page.getByRole('dialog', {
    name: 'Review Claude allow rule',
  });
  const saveRule = ruleDialog.getByRole('button', {
    name: 'Save rule and allow',
  });
  await ruleDialog.getByText('Matches this operation.').waitFor();
  await configurationShot(app, page, 'follow-up-claude-allow-rule');
  await saveRule.click();
  await waitForOutcome(rule.id);
  const computers = await proposeAuthority(`computers/${host}`, {
    kind: 'computers',
    name: 'Reviewed SSH computer',
  });
  await openAuthority('Computers');
  const computerDialog = page.getByRole('dialog', { name: 'Add SSH computer' });
  assert.equal(
    await computerDialog
      .getByRole('textbox', { name: 'Computer name' })
      .inputValue(),
    'Reviewed SSH computer',
  );
  assert.equal(
    await computerDialog
      .getByRole('textbox', { name: 'SSH hostname' })
      .inputValue(),
    '',
  );
  await configurationShot(app, page, 'follow-up-computers');
  await computerDialog.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(
    await page.evaluate(
      async id =>
        (
          await window.nesvo.configuration.history(
            { area: 'authority' },
            'local',
          )
        ).page.changes.find(change => change.id === id).status,
      computers.id,
    ),
    'pending',
  );
  await page
    .getByRole('button', { name: 'Close settings', exact: true })
    .click();
  await page.evaluate(
    async ids => {
      for (const id of ids)
        await window.nesvo.configuration.revoke(id, 'local');
    },
    [enrollment.device.id, authorityDevice.device.id],
  );
  console.log(
    JSON.stringify({
      configurationProfile:
        'direct apply, durable receipt, Undo, CLI proposals and native owner confirmations verified',
    }),
  );
  if (!configurationScreenshots) return;
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Devices', exact: true }).click();
  await page
    .getByRole('button', { name: 'Enroll device', exact: true })
    .click();
  const grantsDialog = page.getByRole('dialog', {
    name: 'Enroll configuration device',
  });
  await grantsDialog
    .getByRole('textbox', { name: 'Device name' })
    .fill('Release reviewer');
  await grantsDialog
    .getByRole('checkbox', { name: 'Appearance', exact: true })
    .check();
  await configurationShot(app, page, 'stage-2-device-grants');
}
const providerPids = new Set();
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitDead = async pid => {
  for (let attempt = 0; attempt < 60 && alive(pid); attempt++) await delay(100);
  assert.equal(alive(pid), false, `Owned process ${pid} must exit`);
  providerPids.delete(pid);
};
async function smokeDesktop() {
  if (setupStage === 'B') return smokeSetupDetection();
  if (setupStage) return smokeSetupProfile();
  if (process.env.NESVO_D85_SMOKE_ONLY === '1') {
    application = await launchApplication();
    const page = await application.firstWindow();
    await page.getByRole('button', { name: 'Inbox', exact: true }).waitFor();
    await page.waitForFunction(async () => {
      try {
        return !!(await window.nesvo.configuration.profile({ action: 'read' }))
          .colorScheme;
      } catch {
        return false;
      }
    });
    hostPid = JSON.parse(await readFile(pidFile, 'utf8')).host;
    await smokeGateRuleFlow({ application, page, directory });
    await smokeConfigurationInbox(application, page);
    await smokeConfigurationProfile(application, page);
    return;
  }
  if (process.env.NESVO_D83_DEMO_ONLY === '1') {
    application = await launchApplication();
    const page = await application.firstWindow();
    page.setDefaultTimeout(20000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await smokePortableCheck({
      application,
      page,
      directory,
      home: env.NESVO_WORKFLOWS_HOME,
      shots: process.env.NESVO_D83_SCREENSHOTS,
      kotlin: process.env.NESVO_D83_KOTLIN_PROJECT,
      demo: true,
      shotSize:
        process.env.NESVO_D83_REVIEW_HIRES === '1' ? [1920, 1080] : undefined,
    });
    return;
  }
  const policyDirectory = join(directory, 'policy-data');
  const policyHost = join(policyDirectory, 'host');
  const policyPidFile = join(policyDirectory, 'host-pid.json');
  const managedPolicy = join(policyDirectory, 'work-laptop-policy');
  const providerConfig = join(policyDirectory, 'provider-settings.json');
  const remoteId = randomUUID();
  const target = {
    name: 'Fixture remote',
    hostname: '127.0.0.1',
    port: 1,
    username: 'fixture',
    entryPath: '/fixture/host.mjs',
    runtimeDirectory: '/fixture/runtime',
    identityFile: join(directory, 'unused-identity'),
    knownHostsFile: join(directory, 'unused-known-hosts'),
  };
  await mkdir(policyDirectory);
  await writeFile(managedPolicy, '');
  await writeFile(providerConfig, 'provider-owned settings');
  await writeFile(
    join(policyDirectory, 'computers.json'),
    JSON.stringify({
      version: 1,
      computers: [{ id: remoteId, input: target, instanceId: null }],
    }),
  );
  application = await launchApplication({
    NESVO_DATA_DIR: policyDirectory,
    NESVO_WORKFLOWS_HOME: join(policyDirectory, 'workflows-home'),
    NESVO_TEST_PID_FILE: policyPidFile,
    CLAUDE_CONFIG_DIR: join(policyDirectory, 'claude'),
    CODEX_HOME: join(policyDirectory, 'codex'),
    NESVO_TEST_SKILLS_HOME: join(policyDirectory, 'skills'),
    NESVO_FIXTURE_USAGE_LOG: join(policyDirectory, 'usage-probes.jsonl'),
    NESVO_FIXTURE_USAGE_CONTROL: join(policyDirectory, 'usage-control.json'),
    NESVO_CODEX_FIXTURE_PID_FILE: join(policyDirectory, 'codex-pid.json'),
    NESVO_CODEX_FIXTURE_STATE_DIR: join(policyDirectory, 'codex-state'),
    NESVO_CODEX_FIXTURE_SKILLS_LOG: join(
      policyDirectory,
      'skills-probes.jsonl',
    ),
    NESVO_MOBILE_PORT: '0',
  });
  const policyPage = await application.firstWindow();
  await policyPage.waitForFunction(async () =>
    (await window.nesvo.listComputers()).some(
      computer => computer.status === 'connected',
    ),
  );
  const expectedPolicy = {
    enabled: true,
    requested: true,
    enforced: true,
    automaticallyEnabled: false,
  };
  assert.deepEqual(
    await policyPage.evaluate(() => window.nesvo.workLaptopPolicy()),
    expectedPolicy,
  );
  assert.deepEqual(
    await policyPage.evaluate(async () =>
      (await window.nesvo.listComputers()).map(computer => computer.id),
    ),
    ['local'],
  );
  await assert.rejects(
    policyPage.evaluate(() => window.nesvo.setWorkLaptopPolicy(false)),
    /enforced by policy/,
  );
  await assert.rejects(
    policyPage.evaluate(() => window.nesvo.enableMobile()),
    /Work laptop mode blocks/,
  );
  await assert.rejects(
    policyPage.evaluate(input => window.nesvo.addComputer(input), target),
    /Work laptop mode blocks/,
  );
  await assert.rejects(
    policyPage.evaluate(id => window.nesvo.connectComputer(id), remoteId),
    /Work laptop mode blocks/,
  );
  await assert.rejects(
    policyPage.evaluate(id => window.nesvo.listSessions(id), remoteId),
    /Work laptop mode blocks/,
  );
  await assert.rejects(
    policyPage.evaluate(() => window.nesvo.deleteLocalData('delete')),
    /full confirmation/,
  );

  const privateValues = [
    'ghp_smokefixturetoken123456',
    'physical-key-fixture',
    'private conversation fixture',
  ];
  await policyPage.evaluate(
    values =>
      window.nesvo.reportError({
        kind: 'render',
        message: 'Authorization: Bearer ' + values[0],
        stack: 'PRIVATE_KEY=' + values[1],
        componentStack: values[2],
      }),
    privateValues,
  );
  await policyPage
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  const settings = policyPage.getByRole('dialog', {
    name: 'Settings',
    exact: true,
  });
  await settings.getByRole('button', { name: 'Data', exact: true }).click();
  await settings.getByText('Enforced by policy', { exact: true }).waitFor();
  const policySwitch = settings.getByRole('switch', {
    name: 'Work laptop mode',
    exact: true,
  });
  assert.equal(await policySwitch.getAttribute('aria-checked'), 'true');
  assert.equal(await policySwitch.isDisabled(), true);
  const backup = await policyPage.evaluate(() => window.nesvo.backupDatabase());
  const attachment = join(policyHost, 'attachments', 'fixture.txt');
  await mkdir(join(policyHost, 'attachments'), { recursive: true });
  await writeFile(attachment, 'fixture attachment');
  const policyLog = join(policyDirectory, 'logs', 'main.log');
  const log = await readFile(policyLog, 'utf8');
  assert.match(log, /Window reported a render error/);
  for (const value of privateValues) assert.ok(!log.includes(value));

  await settings
    .getByRole('button', { name: 'Delete all data', exact: true })
    .click();
  const confirmation = policyPage.getByRole('alertdialog');
  const deleteButton = confirmation.getByRole('button', {
    name: 'Delete all data',
    exact: true,
  });
  assert.equal(await deleteButton.isDisabled(), true);
  await confirmation.getByLabel('Confirmation').fill('DELETE ALL NESVO DATA');
  const policyPid = JSON.parse(await readFile(policyPidFile, 'utf8')).host;
  const policyExited = once(application.process(), 'exit', {
    signal: AbortSignal.timeout(30000),
  });
  await deleteButton.click();
  const [policyExitCode] = await policyExited;
  assert.equal(policyExitCode, 0);
  application = undefined;
  await waitDead(policyPid);
  for (const removed of [
    join(policyHost, 'nesvo.sqlite'),
    backup.path,
    attachment,
    policyLog,
    join(policyDirectory, 'computers.json'),
  ])
    await assert.rejects(stat(removed), { code: 'ENOENT' });
  assert.equal(
    await readFile(providerConfig, 'utf8'),
    'provider-owned settings',
  );
  assert.equal(await readFile(managedPolicy, 'utf8'), '');
  console.log(
    JSON.stringify({
      dataPrivacy: 'policy, diagnostics and local erase verified',
    }),
  );

  await writeFile(usageControl, '{}');
  await mkdir(claudeConfigDirectory, { recursive: true });
  await writeFile(
    join(claudeConfigDirectory, '.claude.json'),
    JSON.stringify({ mcpServers: { fixture: { command: 'fixture-mcp' } } }),
  );
  const skillDocument = (name, marker, fields = '') =>
    `---\nname: ${name}\ndescription: Shared fixture instructions.\n${fields}---\n${marker}\n`;
  const writeSkill = async (path, body) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body);
  };
  const seedNativeSkill = async workspace => {
    await writeSkill(
      join(workspace, '.agents', 'skills', 'fixture-project-skill', 'SKILL.md'),
      skillDocument('Fixture project skill', 'FIXTURE_PROJECT_MARKER'),
    );
    await mkdir(join(workspace, '.git'), { recursive: true });
  };
  await writeSkill(
    join(
      claudeConfigDirectory,
      'skills',
      'fixture-claude-instructions',
      'SKILL.md',
    ),
    skillDocument(
      'Fixture Claude instructions',
      'FIXTURE_CLAUDE_SHARED_MARKER',
    ),
  );
  await writeSkill(
    join(
      codexConfigDirectory,
      'skills',
      'fixture-codex-instructions',
      'SKILL.md',
    ),
    skillDocument('Fixture Codex instructions', 'FIXTURE_CODEX_SHARED_MARKER'),
  );
  await writeSkill(
    join(codexConfigDirectory, 'skills', 'fixture-native-disabled', 'SKILL.md'),
    skillDocument('Fixture user skill', 'Disabled source.', 'enabled: false\n'),
  );
  const userSkillPath = join(
    claudeConfigDirectory,
    'skills',
    'fixture-user-skill',
    'SKILL.md',
  );
  const userSkillText =
    '---\nname: fixture-user-skill\ndescription: User inventory fixture.\nuser-invocable: false\ndisable-model-invocation: true\n---\nMetadata only.\n';
  await mkdir(join(userSkillPath, '..'), { recursive: true });
  await writeFile(userSkillPath, userSkillText);
  application = await launchApplication({ NESVO_TEST_SHOW_ONBOARDING: '1' });
  const defaultPolicy = await (
    await application.firstWindow()
  ).evaluate(() => window.nesvo.workLaptopPolicy());
  assert.deepEqual(defaultPolicy, {
    enabled: false,
    requested: false,
    enforced: false,
    automaticallyEnabled: false,
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const guide = page.getByRole('main', {
    name: 'Getting started',
    exact: true,
  });
  const chooseTestDirectory = async (scope, directory) => {
    await application.evaluate(({ dialog }, folder) => {
      const original = dialog.showOpenDialog;
      dialog.showOpenDialog = async (...args) => {
        dialog.showOpenDialog = original;
        if (!args.at(-1).properties.includes('openDirectory'))
          throw new Error('Expected a native directory picker.');
        return { canceled: false, filePaths: [folder] };
      };
    }, directory);
    await scope
      .getByRole('button', { name: 'Choose folder…', exact: true })
      .click();
    await scope.getByTitle(directory, { exact: true }).waitFor();
  };
  await guide
    .getByRole('heading', { name: 'vibe with full control', exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Settings', exact: true }).count(),
    0,
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem('nesvo.onboarding.v1')),
    null,
  );
  await guide.getByRole('button', { name: 'Get started', exact: true }).click();
  await guide.getByRole('button', { name: 'Continue', exact: true }).click();
  const defaultFolder = join(directory, 'onboarding-project');
  await mkdir(defaultFolder);
  await chooseTestDirectory(guide, defaultFolder);
  assert.equal(
    await page.evaluate(() => window.nesvo.readDefaultSessionFolder('local')),
    defaultFolder,
  );
  await guide.getByRole('button', { name: 'Clear', exact: true }).click();
  await guide.getByText('No folder selected', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.nesvo.readDefaultSessionFolder('local')),
    null,
  );
  await guide
    .getByRole('button', { name: 'Add a computer', exact: true })
    .click();
  const addComputerDialog = page.getByRole('dialog', {
    name: 'Add SSH computer',
    exact: true,
  });
  await addComputerDialog
    .getByRole('button', { name: 'Add and connect', exact: true })
    .waitFor();
  await addComputerDialog
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await addComputerDialog.waitFor({ state: 'hidden' });
  const guideContinue = guide.getByRole('button', {
    name: 'Continue',
    exact: true,
  });
  for (const name of ['Your setup', 'Your Inbox']) {
    await guideContinue.click();
    await guide.getByRole('heading', { name, exact: true }).waitFor();
  }
  const guidePreset = guide.getByRole('switch', {
    name: 'Before push: review the diff locally',
    exact: true,
  });
  const guidePresetOn = guidePreset.and(
    page.locator('[aria-checked="true"]:enabled'),
  );
  await guidePreset.click();
  await guidePresetOn.waitFor();
  await guideContinue.click();
  await guide
    .getByRole('heading', { name: 'Starter routines', exact: true })
    .waitFor();
  await guide.getByRole('button', { name: 'Back', exact: true }).click();
  await guidePresetOn.waitFor();
  await guidePreset.click();
  await guidePreset
    .and(page.locator('[aria-checked="false"]:enabled'))
    .waitFor();
  const guideRule = await page.evaluate(async () => {
    const catalog = await window.nesvo.listInboxRules({}, 'local');
    return catalog.rules.find(rule => rule.name === 'review-before-push');
  });
  assert.equal(guideRule.scope, 'global');
  assert.equal(guideRule.rule.enabled, false);
  await page.evaluate(rule => window.nesvo.deleteInboxRule(rule, 'local'), {
    scope: 'global',
    name: guideRule.name,
    expectedHash: guideRule.contentHash,
  });
  await guide
    .getByRole('button', { name: 'Finish setup later', exact: true })
    .click();
  await guide.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.nesvo.colorScheme()), 'system');
  assert.equal(
    await page.evaluate(() => window.nesvo.setColorScheme('dark')),
    'dark',
  );
  const conversation = page.getByRole('region', {
    name: 'Conversation',
    exact: true,
  });
  const message = text =>
    conversation.getByRole('article').getByText(text, { exact: true });
  const activityFor = runId =>
    conversation.getByRole('region', {
      name: `Activity for run ${runId}`,
      exact: true,
    });
  const runActivities = (session, runId) =>
    session.activities.filter(activity => activity.runId === runId);
  const checkActivityRows = async (runId, activities) => {
    const region = activityFor(runId);
    const toggle = region.getByLabel('Toggle activity', { exact: true });
    if (!(await toggle.evaluate(node => node.closest('details')?.open)))
      await toggle.click();
    for (const group of await region.getByLabel(/^Toggle .+ activity$/).all()) {
      if (!(await group.evaluate(node => node.closest('details')?.open)))
        await group.click();
    }
    await region
      .locator('[data-activity-id]')
      .first()
      .waitFor({ state: 'visible' });
    const rendered = await region
      .locator('[data-activity-id]')
      .evaluateAll(rows =>
        rows.map(row => ({
          id: row.getAttribute('data-activity-id'),
          kind: row.getAttribute('data-activity-kind'),
          status: row.getAttribute('data-activity-status'),
        })),
      );
    assert.deepEqual(
      rendered.toSorted((left, right) => left.id.localeCompare(right.id)),
      activities
        .map(({ id, kind, status }) => ({ id, kind, status }))
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    );
  };
  const openInbox = async () => {
    await page.getByRole('button', { name: 'Inbox', exact: true }).click();
    await page.getByRole('region', { name: 'Inbox', exact: true }).waitFor();
  };
  const skillsOpener = page.getByRole('button', {
    name: 'Open skills',
    exact: true,
  });
  const skillsPanel = page.getByRole('region', {
    name: 'Session skills',
    exact: true,
  });
  const readSkillsTrace = async () => {
    try {
      return (await readFile(skillsLog, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  const waitSkillsTrace = async (path, method) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const trace = (await readSkillsTrace()).find(
        trace => trace.directory === path && trace.method === method,
      );
      if (trace) return trace;
      await delay(50);
    }
    assert.fail(`Skills trace missing for ${path}: ${method}`);
  };
  const closeSkills = async () => {
    await page.keyboard.press('Escape');
    await skillsPanel.waitFor({ state: 'hidden' });
    const deadline = Date.now() + 2000;
    while (
      !(await skillsOpener.evaluate(node => node === document.activeElement)) &&
      Date.now() < deadline
    )
      await delay(25);
    assert.equal(
      await skillsOpener.evaluate(node => node === document.activeElement),
      true,
    );
  };
  const screenshot = async suffix => {
    const target = suffix.startsWith('-mcp-')
      ? process.env.NESVO_MCP_TRUST_SCREENSHOT
      : suffix.startsWith('-inbox-rules-')
        ? process.env.NESVO_INBOX_RULES_SCREENSHOT
        : process.env.NESVO_SCREENSHOT;
    if (!target) return;
    await page.evaluate(
      () =>
        new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const encoded = await application.evaluate(async ({ BrowserWindow }) => {
      const image =
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(
          undefined,
          { stayHidden: true, stayAwake: true },
        );
      return image.toPNG().toString('base64');
    });
    await writeFile(
      target.replace(
        /\.png$/,
        suffix.replace(/^-mcp/, '').replace(/^-inbox-rules/, '') + '.png',
      ),
      Buffer.from(encoded, 'base64'),
    );
  };
  const waitState = async (id, status, previousRunId) => {
    const deadline = Date.now() + 20_000;
    let session;
    while (Date.now() < deadline) {
      session = await page.evaluate(
        async id =>
          (await window.nesvo.listSessions()).find(
            session => session.id === id,
          ),
        id,
      );
      if (session?.status === status && session.runId !== previousRunId)
        return session;
      await delay(100);
    }
    assert.fail(`Session ${id} expected ${status}: ${JSON.stringify(session)}`);
  };
  const send = async text => {
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(text);
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
  };
  const messageEditor = page.getByRole('textbox', {
    name: 'Message',
    exact: true,
  });
  const waitForFocus = async opener => {
    const deadline = Date.now() + 2000;
    while (
      !(await opener.evaluate(node => node === document.activeElement)) &&
      Date.now() < deadline
    )
      await delay(25);
    assert.equal(
      await opener.evaluate(node => node === document.activeElement),
      true,
    );
  };
  const skillPicker = page.getByRole('listbox', {
    name: 'Skills',
    exact: true,
  });
  const waitReview = async (
    sessionId,
    afterVersion = 0,
    status = 'pending',
  ) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const reviews = await page.evaluate(() => window.nesvo.listReviews());
      const review = reviews.find(
        review =>
          review.sessionId === sessionId &&
          review.version > afterVersion &&
          review.status === status,
      );
      if (review) return review;
      await delay(100);
    }
    assert.fail(
      `No ${status} review for session ${sessionId} after version ${afterVersion}`,
    );
  };
  const waitOwned = async (provider = 'Claude Code') => {
    await conversation
      .getByRole('article')
      .getByText(
        provider === 'Codex'
          ? 'Codex fixture is waiting.'
          : 'Fixture is waiting.',
        { exact: true },
      )
      .last()
      .waitFor();
    const pids = JSON.parse(
      await readFile(
        provider === 'Codex' ? codexPidFile : providerPidFile,
        'utf8',
      ),
    );
    providerPids.add(pids.pid);
    providerPids.add(pids.childPid);
    return pids;
  };
  const newThread = page.getByRole('region', {
    name: 'New thread',
    exact: true,
  });
  const modelPicker = page.getByRole('dialog', { name: 'Model', exact: true });
  const permissionsPicker = page.getByRole('dialog', {
    name: 'Permissions',
    exact: true,
  });
  const openNewThread = async () => {
    await page
      .getByRole('button', { name: 'New session', exact: true })
      .first()
      .click();
    await newThread.waitFor();
  };
  const chooseLocation = async directory => {
    await newThread
      .getByRole('button', { name: 'Location', exact: true })
      .click();
    const input = page.getByRole('textbox', {
      name: 'Working directory',
      exact: true,
    });
    await input.fill(directory);
    await input.press('Enter');
    await input.waitFor({ state: 'hidden' });
  };
  const startThread = async ({
    title,
    provider,
    model,
    effort,
    access,
    directory,
  }) => {
    await openNewThread();
    if (provider) {
      await newThread
        .getByRole('button', { name: 'Choose model', exact: true })
        .click();
      await modelPicker
        .getByRole('radio', { name: provider, exact: true })
        .click();
      if (model) {
        const search = modelPicker.getByRole('combobox', {
          name: 'Search models',
          exact: true,
        });
        await search.fill(model);
        await modelPicker
          .getByRole('option', { name: model, exact: true })
          .waitFor();
        await search.press('Enter');
      } else await page.keyboard.press('Escape');
      await modelPicker.waitFor({ state: 'hidden' });
    }
    if (effort) {
      await newThread
        .getByRole('button', { name: 'Choose model', exact: true })
        .click();
      const efforts = modelPicker.getByRole('group', {
        name: 'Reasoning effort',
        exact: true,
      });
      assert.equal(
        await efforts.locator('[data-default]').getAttribute('data-effort'),
        'medium',
      );
      assert.equal(
        await efforts
          .locator('[aria-pressed="true"]')
          .getAttribute('data-effort'),
        'medium',
      );
      await efforts.locator(`[data-effort="${effort}"]`).click();
      await modelPicker.waitFor({ state: 'hidden' });
    }
    if (access) {
      await newThread
        .getByRole('button', { name: 'Permissions', exact: true })
        .click();
      await permissionsPicker
        .getByRole('radio', { name: access, exact: true })
        .click();
      await page.keyboard.press('Escape');
      await permissionsPicker.waitFor({ state: 'hidden' });
    }
    if (directory !== undefined) await chooseLocation(directory);
    await newThread
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(title);
    await newThread
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
  };
  const sessionByTitle = async title =>
    (await page.evaluate(() => window.nesvo.listSessions())).find(
      session => session.title === title,
    );
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const initialContext = page.getByRole('dialog', {
    name: 'Settings',
    exact: true,
  });
  await initialContext
    .getByRole('region', { name: 'General', exact: true })
    .waitFor();
  await initialContext
    .getByRole('status')
    .filter({ hasText: 'Connected to local host' })
    .waitFor();
  await initialContext
    .getByRole('button', { name: 'Refresh connection', exact: true })
    .click();
  await initialContext
    .getByRole('status')
    .filter({ hasText: 'Connected to local host' })
    .waitFor();
  const settingsSearch = initialContext.getByLabel('Search settings');
  const searchResults = initialContext.getByRole('region', {
    name: 'Settings search results',
  });
  await settingsSearch.fill('quota');
  await searchResults
    .getByRole('button', { name: 'Account and limits', exact: true })
    .waitFor();
  assert.equal(
    await initialContext
      .getByRole('region', { name: 'General', exact: true })
      .isVisible(),
    false,
  );
  await settingsSearch.fill('no matching setting fixture');
  await searchResults
    .getByText('No matching settings', { exact: true })
    .waitFor();
  await settingsSearch.press('Escape');
  await initialContext
    .getByRole('region', { name: 'General', exact: true })
    .waitFor();
  const settingsNav = initialContext.getByRole('navigation', {
    name: 'Settings sections',
  });
  await settingsNav.getByRole('button', { name: 'About', exact: true }).click();
  await initialContext
    .getByRole('region', { name: 'About', exact: true })
    .waitFor();
  await initialContext
    .getByRole('button', { name: 'Session control', exact: true })
    .click();
  const controlSwitch = initialContext.getByRole('switch', {
    name: 'Let sessions coordinate sessions',
    exact: true,
  });
  await controlSwitch.waitFor();
  assert.equal(await controlSwitch.getAttribute('aria-checked'), 'false');
  await controlSwitch.click();
  await page.waitForFunction(
    async () => (await window.nesvo.readSessionControlPolicy('local')).enabled,
  );
  assert.deepEqual(
    await page.evaluate(() => window.nesvo.readSessionControlPolicy('local')),
    {
      enabled: true,
      providers: ['Claude Code', 'Codex'],
      models: [],
      childModes: ['read-only', 'accept-edits'],
      groupSize: 4,
      nested: false,
      worktrees: false,
      acceptPlans: true,
      browser: false,
    },
  );
  await screenshot('-session-control-settings');
  await controlSwitch.click();
  await page.waitForFunction(
    async () => !(await window.nesvo.readSessionControlPolicy('local')).enabled,
  );
  await page.keyboard.press('Escape');
  await initialContext.waitFor({ state: 'hidden' });
  assert.equal(
    await page
      .getByRole('status')
      .filter({ hasText: 'Connected to local host' })
      .count(),
    0,
  );
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(
    await application.evaluate(
      ({ nativeTheme }) => nativeTheme.shouldUseDarkColors,
    ),
    true,
  );
  const appliedScheme = () =>
    page.evaluate(() => ({
      dark: document.documentElement.classList.contains('dark'),
      background: getComputedStyle(document.body).backgroundColor,
    }));
  assert.deepEqual(await appliedScheme(), {
    dark: true,
    background: 'rgb(0, 0, 0)',
  });
  await page.evaluate(() => window.nesvo.setColorScheme('light'));
  await page.waitForFunction(
    () => !document.documentElement.classList.contains('dark'),
  );
  assert.deepEqual(await appliedScheme(), {
    dark: false,
    background: 'rgb(252, 252, 252)',
  });
  await page.evaluate(() => window.nesvo.setColorScheme('dark'));
  await page.waitForFunction(() =>
    document.documentElement.classList.contains('dark'),
  );
  const versions = await application.evaluate(() => process.versions);
  hostPid = JSON.parse(await readFile(pidFile, 'utf8')).host;
  assert.equal(typeof hostPid, 'number');
  const readUsageTrace = async () =>
    (await readFile(usageLog, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
  const checkUsagePanel = async (targetPage, status) => {
    const account = targetPage.getByRole('button', {
      name: 'Settings',
      exact: true,
    });
    await account.click();
    const settings = targetPage.getByRole('dialog', {
      name: 'Settings',
      exact: true,
    });
    await settings
      .getByRole('button', { name: 'Account and limits', exact: true })
      .click();
    const panel = settings.getByRole('region', {
      name: 'Account and limits',
      exact: true,
    });
    await panel
      .getByRole('button', { name: 'Refresh limits', exact: true })
      .click();
    assert.equal(
      await panel
        .locator('[data-host-id]')
        .first()
        .getAttribute('data-host-id'),
      'local',
    );

    for (const provider of ['Claude Code', 'Codex']) {
      const section = panel.getByRole('region', {
        name: `${provider} usage`,
        exact: true,
      });
      await panel
        .locator(
          `[data-provider-usage="${provider}"][data-usage-status="${status}"]`,
        )
        .waitFor();
      await section
        .getByText(
          provider === 'Codex'
            ? 'fixture@example.invalid'
            : 'claude-fixture@example.invalid',
          { exact: true },
        )
        .waitFor();
      const bars = section.getByRole('meter');
      if (status === 'ready') {
        assert.deepEqual(
          await bars.evaluateAll(nodes =>
            nodes.map(node => node.getAttribute('aria-valuenow')),
          ),
          provider === 'Codex' ? ['25', '40'] : ['23.5', '61.25'],
        );
        assert.deepEqual(
          await section
            .locator('[data-usage-window] time')
            .evaluateAll(nodes =>
              nodes.map(node => node.getAttribute('datetime')),
            ),
          ['2030-01-02T03:04:05.000Z', '2030-01-07T03:04:05.000Z'],
        );
      } else {
        assert.equal(await bars.count(), 0);
        await section
          .getByText('No current quota values are available.', { exact: true })
          .waitFor();
      }
    }
    return { account, panel };
  };
  const initialUsage = await checkUsagePanel(page, 'ready');
  await screenshot('-provider-limits');
  const initialUsageProbes = await readUsageTrace();
  assert.equal(initialUsageProbes.length, 2);
  for (const trace of initialUsageProbes) {
    providerPids.add(trace.pid);
    assert.deepEqual(
      trace.methods,
      trace.provider === 'Codex'
        ? [
            'initialize',
            'initialized',
            'account/read',
            'account/rateLimits/read',
          ]
        : ['initialize', 'get_usage'],
    );
    await waitDead(trace.pid);
  }
  await assert.rejects(readFile(env.NESVO_CODEX_FIXTURE_RUN_LOG), {
    code: 'ENOENT',
  });
  assert.deepEqual(await page.evaluate(() => window.nesvo.listSessions()), []);
  await initialUsage.panel
    .getByRole('button', { name: 'Refresh limits', exact: true })
    .click();
  assert.deepEqual(await readUsageTrace(), initialUsageProbes);
  const profileDirectory = await createProfileDirectory(
    join(directory, 'claude-work'),
  );
  const accountLabel = initialUsage.panel.getByLabel('Label', { exact: true });
  await accountLabel.fill('Work account');
  await chooseTestDirectory(initialUsage.panel, profileDirectory);
  await initialUsage.panel
    .getByRole('button', { name: 'Add account', exact: true })
    .click();
  await initialUsage.panel
    .getByText('Work account · Signed in', { exact: true })
    .waitFor();
  await initialUsage.panel
    .locator('[data-provider-usage="Claude Code"][data-usage-status="ready"]')
    .waitFor();
  await accountLabel.fill('Work account renamed');
  await initialUsage.panel
    .getByRole('button', { name: 'Save label', exact: true })
    .click();
  await initialUsage.panel
    .getByText('Work account renamed · Signed in', { exact: true })
    .waitFor();
  await initialUsage.panel
    .getByRole('button', { name: 'Remove account', exact: true })
    .click();
  const removeAccount = page.getByRole('alertdialog', {
    name: 'Remove Work account renamed?',
  });
  await removeAccount
    .getByRole('button', { name: 'Remove account', exact: true })
    .click();
  await removeAccount.waitFor({ state: 'hidden' });
  assert.deepEqual(
    await page.evaluate(() => window.nesvo.listProviderProfiles()),
    [],
  );
  await page.keyboard.press('Escape');
  await initialUsage.panel.waitFor({ state: 'hidden' });
  await page.waitForFunction(
    element => element === document.activeElement,
    await initialUsage.account.elementHandle(),
  );
  assert.equal(
    await initialUsage.account.evaluate(
      node => node === document.activeElement,
    ),
    true,
  );
  await page
    .getByRole('button', {
      name: 'Codex limits: Codex · 7 days, 60% remaining',
      exact: true,
    })
    .waitFor();
  await page
    .getByRole('button', {
      name: 'Claude Code limits: Weekly, 38.8% remaining',
      exact: true,
    })
    .waitFor();
  await screenshot('-provider-rail');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsNav
    .getByRole('button', { name: 'Permissions', exact: true })
    .click();
  const trustSettings = initialContext.getByRole('region', {
    name: 'Repository trust',
    exact: true,
  });
  await trustSettings.getByRole('button', { name: 'Add pattern' }).click();
  const addPattern = page.getByRole('dialog', {
    name: 'Add repository pattern',
  });
  await addPattern
    .getByLabel('Repository pattern')
    .fill('git.example.test/team/*');
  await addPattern.getByRole('button', { name: 'Add pattern' }).click();
  await trustSettings
    .getByText('git.example.test/team/*', { exact: true })
    .waitFor();
  const captureD88 = async name => {
    if (!d88Screenshots) return;
    await mkdir(d88Screenshots, { recursive: true });
    const previous = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    for (const size of [
      { width: 1280, height: 800 },
      { width: 1920, height: 1080 },
    ]) {
      await application.evaluate(({ BrowserWindow }, { width, height }) => {
        BrowserWindow.getAllWindows()[0].setContentSize(width, height);
      }, size);
      await page.waitForFunction(
        ({ width, height }) => innerWidth === width && innerHeight === height,
        size,
      );
      await page.waitForFunction(() =>
        document.getAnimations().every(animation => {
          const end = animation.effect?.getComputedTiming().endTime;
          return end === Infinity || animation.playState !== 'running';
        }),
      );
      await delay(200);
      const screenshot = await application.evaluate(
        async ({ BrowserWindow }) => {
          const image =
            await BrowserWindow.getAllWindows()[0].webContents.capturePage(
              undefined,
              { stayHidden: true, stayAwake: true },
            );
          return {
            size: image.getSize(),
            png: image.toPNG().toString('base64'),
          };
        },
      );
      assert.deepEqual(screenshot.size, size);
      await writeFile(
        join(d88Screenshots, `d88-${name}-${size.width}x${size.height}.png`),
        Buffer.from(screenshot.png, 'base64'),
      );
    }
    await application.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
    }, previous);
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      previous,
    );
  };
  await captureD88('a-repository-trust');
  await trustSettings
    .getByRole('button', { name: 'Revoke', exact: true })
    .click();
  await page
    .getByRole('alertdialog', { name: 'Revoke repository trust?' })
    .getByRole('button', { name: 'Revoke', exact: true })
    .click();
  await trustSettings.getByText('No active rules', { exact: true }).waitFor();
  await trustSettings
    .getByRole('button', { name: 'History', exact: true })
    .click();
  await initialContext
    .getByRole('heading', { name: 'Repository trust history', exact: true })
    .waitFor();
  await initialContext.getByText(/Revoked ·/).waitFor();
  await initialContext
    .getByRole('button', { name: 'Close repository trust history' })
    .click();
  const gateSettings = initialContext.getByRole('region', {
    name: 'Provider usage gates',
    exact: true,
  });
  await gateSettings.getByRole('button', { name: 'Add usage rule' }).click();
  const usageRule = page.getByRole('dialog', {
    name: 'Add provider usage rule',
  });
  await usageRule.getByLabel('Threshold (%)').fill('50');
  await usageRule.getByLabel('At threshold').click();
  await page.getByRole('option', { name: 'Hold', exact: true }).click();
  await usageRule.getByRole('button', { name: 'Save rule' }).click();
  await gateSettings.getByText('Hold at 50% used').waitFor();
  const heldReason = await page.evaluate(async () => {
    try {
      await window.nesvo.createSession({
        requestId: crypto.randomUUID(),
        title: 'Fixture usage hold',
        model: 'sonnet',
      });
      return null;
    } catch (error) {
      return error.message;
    }
  });
  assert.match(heldReason, /61\.25% used/);
  await settingsNav
    .getByRole('button', { name: 'General', exact: true })
    .click();
  await settingsNav
    .getByRole('button', { name: 'Permissions', exact: true })
    .click();
  await gateSettings.getByText('Fixture usage hold', { exact: true }).waitFor();
  await captureD88('c-usage-hold');
  await gateSettings
    .getByRole('button', { name: 'Remove rule', exact: true })
    .click();
  await gateSettings
    .getByRole('button', { name: 'Check again', exact: true })
    .click();
  await gateSettings.getByText('Ready for an explicit retry.').waitFor();
  await gateSettings
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await gateSettings
    .getByText('Fixture usage hold', { exact: true })
    .waitFor({ state: 'hidden' });
  await settingsNav
    .getByRole('button', { name: 'Worktrees', exact: true })
    .click();
  const providerSettings = initialContext.getByRole('region', {
    name: 'Worktree providers',
    exact: true,
  });
  await providerSettings.getByRole('button', { name: 'Add provider' }).click();
  const providerEditor = page.getByRole('dialog', {
    name: 'Add worktree provider',
  });
  await providerEditor.getByLabel('Provider definition').fill(
    JSON.stringify({
      version: 1,
      kind: 'builtin',
      name: 'Fixture branch policy',
      scope: { kind: 'pattern', pattern: 'git.example.test/team/*' },
      branchPolicy: {
        template: '<type>/<TICKET>-<slug>',
        validation: '^fix/[A-Z0-9]+-[a-z0-9-]+$',
      },
    }),
  );
  await providerEditor.getByRole('button', { name: 'Review provider' }).click();
  await page
    .getByRole('dialog', { name: 'Review worktree provider' })
    .getByRole('button', { name: 'Approve provider' })
    .click();
  await providerSettings
    .getByText('Fixture branch policy', { exact: true })
    .waitFor();
  await captureD88('b-worktree-providers');
  await providerSettings
    .getByRole('button', { name: 'Revoke', exact: true })
    .click();
  await page
    .getByRole('alertdialog', { name: 'Revoke worktree provider?' })
    .getByRole('button', { name: 'Revoke', exact: true })
    .click();
  await providerSettings
    .getByText('Fixture branch policy', { exact: true })
    .waitFor({ state: 'hidden' });
  const sourceDeviceId = await page.evaluate(
    async () =>
      (
        await window.nesvo.enrollExternalInboxDevice({
          name: 'Fixture external device',
        })
      ).device.id,
  );
  await settingsNav
    .getByRole('button', { name: 'Session control', exact: true })
    .click();
  const externalSettings = initialContext.getByRole('region', {
    name: 'External messages',
    exact: true,
  });
  await externalSettings
    .getByRole('button', { name: 'Add source', exact: true })
    .click();
  const externalSource = page.getByRole('dialog', {
    name: 'Add external message source',
  });
  await externalSource
    .getByLabel('Source label')
    .fill('Fixture message source');
  await externalSource.getByRole('button', { name: 'Save source' }).click();
  await externalSettings
    .getByText('Fixture message source', { exact: true })
    .waitFor();
  const watcherSettings = initialContext
    .getByRole('region', { name: 'Session message watchers', exact: true })
    .getByText('No watchers');
  await watcherSettings.scrollIntoViewIfNeeded();
  await captureD88('d-external-messages');
  await externalSettings
    .getByRole('button', { name: 'Revoke', exact: true })
    .click();
  const revokeSource = page.getByRole('alertdialog', {
    name: 'Revoke this message source?',
  });
  await revokeSource
    .getByRole('button', { name: 'Revoke', exact: true })
    .click();
  await externalSettings
    .getByText('Fixture message source', { exact: true })
    .waitFor({ state: 'hidden' });
  await revokeSource.waitFor({ state: 'hidden' });
  await page.evaluate(
    deviceId => window.nesvo.revokeExternalInboxDevice({ deviceId }),
    sourceDeviceId,
  );
  await initialContext
    .getByRole('button', { name: 'Close settings', exact: true })
    .click();
  await initialContext.waitFor({ state: 'hidden' });
  const scheduledJobCall = (method, ...args) =>
    page.evaluate(
      ([name, params]) => window.nesvo.scheduledJobs[name](...params),
      [method, args],
    );
  const scheduledJobDefinition = {
    id: randomUUID(),
    name: 'Morning summary',
    prompt: 'Summarize yesterday.',
    directory,
    provider: 'claude',
    model: 'sonnet',
    effort: null,
    mode: 'read-only',
    schedule: { kind: 'daily', time: '08:00' },
    timeZone: 'Europe/Warsaw',
    active: false,
  };
  const localComputer = (
    await page.evaluate(() => window.nesvo.listComputers())
  ).find(computer => computer.id === 'local');
  assert.deepEqual(localComputer.capabilities, [
    'scheduled-jobs',
    'reasoning-effort',
    'workflows',
    'git-branch',
    'session-worktrees',
    'session-worktree-tools',
    'permission-modes',
    'session-workflow',
    'session-fork',
    'pull-requests',
    'history-search',
    'session-groups',
    'costs',
    'mcp-servers',
    'conversation-import',
    'scheduled-job-change-triggers',
    'database-backup',
    'claude-approvals',
    'message-attachments',
    'terminal-handoff',
    'transcript-search',
    'session-delete',
    'conversation-compaction',
    'provider-profiles',
    'inline-attachments',
    'pull-request-reviews',
    'file-attachments',
    'session-changes',
    'code-comments',
    'repository-mcp-trust',
    'tracked-repositories',
    'running-apps',
    'default-session-folder',
    'worktree-recipes',
    'session-control',
    'workflow-sharing',
    'workflow-child-sessions',
    'session-stages',
    'claude-commands',
    'session-browser',
    'session-resume',
    'merged-worktree-cleanup',
    'automation-rituals',
    'lessons',
    'inbox-rules',
    'decision-routing',
    'running-apps-web',
    'gate-rules',
    'external-inbox',
    'claude-autonomy',
    'coordinator-workers',
    'worker-restart',
    'mcp-auth',
    'group-cost-budgets',
    'manager-import',
    'configuration',
    'repository-trust-rules',
    'custom-worktree-providers',
    'provider-usage-gates',
    'readonly-integration-grants',
    'external-session-messages',
    'session-message-watchers',
    'coordinator-orchestration',
    'portable-checks',
    'setup-profile-v1',
    'setup-detection-v1',
    'setup-assistant-v1',
  ]);
  assert.deepEqual(await scheduledJobCall('list', 'local'), []);
  const savedScheduledJob = await scheduledJobCall(
    'save',
    'local',
    scheduledJobDefinition,
    null,
  );
  assert.equal(savedScheduledJob.hostId, 'local');
  assert.equal(savedScheduledJob.revision, 1);
  assert.equal(savedScheduledJob.nextRunAt, null);
  assert.deepEqual(await scheduledJobCall('list', 'local'), [
    savedScheduledJob,
  ]);
  await assert.rejects(
    scheduledJobCall('save', 'local', scheduledJobDefinition, null),
    /already exists/,
  );
  await assert.rejects(
    scheduledJobCall(
      'save',
      'local',
      { ...scheduledJobDefinition, mode: 'supervised' },
      1,
    ),
  );
  await assert.rejects(scheduledJobCall('list', 'not-a-host'));
  const offlineComputer = await page.evaluate(() =>
    window.nesvo.addComputer({
      name: 'Offline computer',
      hostname: 'offline.invalid',
      entryPath: '/opt/nesvo/host.js',
      runtimeDirectory: '/var/lib/nesvo',
    }),
  );
  assert.deepEqual(offlineComputer.capabilities, []);
  await assert.rejects(
    scheduledJobCall('list', offlineComputer.id),
    /offline or still synchronizing/,
  );
  await assert.rejects(
    scheduledJobCall('save', offlineComputer.id, scheduledJobDefinition, null),
    /offline or still synchronizing/,
  );
  assert.equal(
    (await page.evaluate(() => window.nesvo.listComputers())).find(
      computer => computer.id === offlineComputer.id,
    ).status,
    'disconnected',
  );
  await page.evaluate(
    id => window.nesvo.removeComputer(id),
    offlineComputer.id,
  );
  await scheduledJobCall(
    'delete',
    'local',
    scheduledJobDefinition.id,
    savedScheduledJob.revision,
  );
  assert.deepEqual(await scheduledJobCall('list', 'local'), []);
  console.log(
    JSON.stringify({
      scheduledJobs: {
        capabilities: localComputer.capabilities,
        savedRevision: savedScheduledJob.revision,
        hostId: savedScheduledJob.hostId,
        offlineRefused: true,
        offlineStatus: 'disconnected',
      },
    }),
  );
  const sessionCardToggle = page.getByRole('button', {
    name: 'Session details',
    exact: true,
  });
  await sessionCardToggle.click();
  const sessionCard = page.getByRole('complementary', {
    name: 'Session details',
    exact: true,
  });
  assert.equal(
    await sessionCard
      .locator('[data-usage-row="Claude Code"] [role="meter"]')
      .getAttribute('aria-valuetext'),
    '38.8% left',
  );
  await page.keyboard.press('Escape');
  await sessionCard.waitFor({ state: 'hidden' });
  await waitForFocus(sessionCardToggle);
  await openNewThread();
  await page.waitForFunction(
    async () => (await window.nesvo.claudeStatus()).status === 'ready',
  );
  await newThread
    .getByRole('heading', { name: 'What should we build?', exact: true })
    .waitFor();
  const modelChip = newThread.getByRole('button', {
    name: 'Choose model',
    exact: true,
  });
  await modelChip.click();
  const modelSearch = modelPicker.getByRole('combobox', {
    name: 'Search models',
    exact: true,
  });
  await waitForFocus(modelSearch);
  await modelPicker
    .getByRole('option', { name: 'Sonnet', exact: true })
    .waitFor();
  assert.equal(
    await modelPicker
      .getByRole('option', { name: 'Claude Code default', exact: true })
      .getAttribute('aria-selected'),
    'true',
  );
  const firstActive = await modelSearch.getAttribute('aria-activedescendant');
  await modelSearch.press('ArrowDown');
  const nextActive = await modelSearch.getAttribute('aria-activedescendant');
  assert.notEqual(nextActive, firstActive);
  assert.equal(
    await modelPicker.locator(`#${nextActive}`).getAttribute('role'),
    'option',
  );
  await modelSearch.press('ArrowUp');
  assert.equal(
    await modelSearch.getAttribute('aria-activedescendant'),
    firstActive,
  );
  const claudeReasoning = modelPicker.getByRole('group', {
    name: 'Reasoning',
    exact: true,
  });
  await claudeReasoning
    .getByRole('button', { name: 'Default', exact: true })
    .waitFor();
  assert.equal(
    await claudeReasoning.getAttribute('data-effort-support'),
    'per-model',
  );
  assert.deepEqual(
    await claudeReasoning
      .locator('[data-effort]')
      .evaluateAll(rows => rows.map(row => row.getAttribute('data-effort'))),
    ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
  );
  assert.equal(
    await claudeReasoning
      .getByRole('button', { name: 'Default', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  await modelSearch.press('Escape');
  await modelPicker.waitFor({ state: 'hidden' });
  await waitForFocus(modelChip);
  await modelChip.click();
  await modelSearch.fill('son');
  await modelSearch.press('ArrowDown');
  await modelSearch.press('Enter');
  await modelPicker.waitFor({ state: 'hidden' });
  await modelChip.hover();
  const modelHint = page.getByRole('tooltip');
  await modelHint.waitFor();
  assert.equal((await modelHint.textContent())?.trim(), 'Claude Code · Sonnet');
  await page.mouse.move(0, 0);
  await modelChip.press('Escape');
  await modelHint.waitFor({ state: 'hidden' });
  assert.equal(await newThread.locator('[data-session-mcp]').count(), 0);
  await screenshot('-new-session');
  await startThread({ title: 'Prototype analysis' });
  await page
    .getByRole('heading', { name: 'Prototype analysis', exact: true, level: 1 })
    .waitFor();
  const first = (await page.evaluate(() => window.nesvo.listSessions()))[0];
  assert.equal(first.title, 'Prototype analysis');
  assert.equal(first.model, 'sonnet');
  assert.equal(first.provider, 'Claude Code');
  assert.equal(first.mode, 'read-only');
  assert.equal(first.messages[0].body, 'Prototype analysis');
  await message('Fixture initial reply.').waitFor();
  const firstStarted = await waitState(first.id, 'completed');
  assert.equal(firstStarted.messages.length, 2);
  assert.equal(firstStarted.role, 'standalone');
  const mcpChip = conversation.getByRole('button', {
    name: 'MCP servers and hooks',
    exact: true,
  });
  const mcpPopover = page.getByRole('dialog', {
    name: 'MCP servers and hooks',
    exact: true,
  });
  await mcpChip.click();
  await mcpPopover.getByText('fixture', { exact: true }).waitFor();
  await mcpPopover.getByText('User · stdio', { exact: true }).waitFor();
  await mcpPopover.getByText('Disabled', { exact: true }).waitFor();
  await screenshot('-mcp-plan');
  assert.equal(await mcpPopover.getByRole('switch').count(), 0);
  await page.keyboard.press('Escape');
  await mcpPopover.waitFor({ state: 'hidden' });
  await waitForFocus(mcpChip);
  const repoMcp = join(first.directory, '.mcp.json');
  const repoHooks = join(first.directory, '.claude', 'settings.json');
  await writeSkill(
    repoHooks,
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              {
                type: 'command',
                command: 'tools/refresh-index --token fixture-hook-value',
              },
              {
                type: 'command',
                command: 'tools/refresh-index --token "$(fixture-marker)"',
              },
            ],
          },
        ],
      },
    }),
  );
  const longArgument = '/workspace/' + 'projects/'.repeat(16) + 'documents';
  const writeRepositoryMcp = command =>
    writeFile(
      repoMcp,
      JSON.stringify({
        mcpServers: {
          documents: {
            command,
            args: ['--root', longArgument, '--api-token=fixture-value'],
            env: { DOCUMENTS_TOKEN: 'fixture-env-value' },
          },
          index: {
            type: 'http',
            url: 'https://fixture:password@index.example.test/api/mcp?token=fixture-query',
          },
        },
      }),
    );
  const mcpCommand =
    process.platform === 'win32'
      ? 'C:\\Program Files\\Workspace Tools\\documents-mcp.exe'
      : '/opt/workspace-tools/bin/documents-mcp';
  await writeRepositoryMcp(mcpCommand);
  await mcpChip.click();
  await mcpPopover
    .getByText('Repository MCP servers and hooks are paused.', { exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  const trustNotice = conversation.getByText(
    'Trust this repository’s configuration?',
    { exact: true },
  );
  await trustNotice.waitFor();
  const detailRegion = conversation.getByRole('region', {
    name: 'Repository integration details',
  });
  await detailRegion.getByText(mcpCommand, { exact: true }).waitFor();
  await detailRegion
    .getByText('…(+' + (longArgument.length - 104) + ' chars)', {
      exact: false,
    })
    .waitFor();
  await detailRegion.getByText('--api-token=••••', { exact: true }).waitFor();
  await detailRegion
    .getByText('DOCUMENTS_TOKEN=••••', { exact: true })
    .waitFor();
  await detailRegion
    .getByText('tools/refresh-index --token ••••', { exact: true })
    .waitFor();
  await detailRegion
    .getByText('Contains shell expansion', { exact: true })
    .waitFor();
  await detailRegion
    .getByText('Review the raw definition', { exact: true })
    .waitFor();
  await detailRegion
    .getByText('tools/refresh-index --token "$(fixture-marker)"', {
      exact: true,
    })
    .waitFor();
  await detailRegion
    .getByText('https://fixture:••••@index.example.test/api/mcp?token=••••', {
      exact: true,
    })
    .waitFor();
  assert.doesNotMatch(
    await detailRegion.innerText(),
    /fixture-(?:value|env-value|hook-value|query)|password/,
  );
  await screenshot('-mcp-prompt');
  await detailRegion.getByRole('button', { name: 'Expand argument' }).click();
  await detailRegion.getByText(longArgument, { exact: true }).waitFor();
  await detailRegion.getByRole('button', { name: 'Collapse argument' }).click();
  const trustRepository = conversation.getByRole('button', {
    name: 'Trust',
    exact: true,
  });
  assert.equal(await trustRepository.isDisabled(), true);
  await conversation
    .getByRole('button', { name: 'View raw definitions' })
    .click();
  const rawDefinitions = page.getByRole('dialog', {
    name: 'Raw repository definitions',
  });
  const sources = rawDefinitions.getByRole('region', { name: 'Source files' });
  await sources.waitFor();
  assert.match(await sources.innerText(), /\.mcp\.json/);
  assert.match(await sources.innerText(), /settings\.json/);
  assert.match(await sources.innerText(), /\$\(fixture-marker\)/);
  assert.doesNotMatch(
    await sources.innerText(),
    /fixture-(?:value|env-value|hook-value|query)|password/,
  );
  await screenshot('-mcp-definitions');
  await page.keyboard.press('Escape');
  await rawDefinitions.waitFor({ state: 'hidden' });
  await trustRepository.click();
  await trustNotice.waitFor({ state: 'hidden' });
  await writeRepositoryMcp(mcpCommand + '-v2');
  await mcpChip.click();
  await mcpPopover
    .getByText('Repository MCP servers and hooks are paused.', { exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await trustNotice.waitFor();
  await conversation
    .getByText(
      'Repository definitions changed and are paused until you trust them again.',
    )
    .waitFor();
  await detailRegion.getByText(mcpCommand + '-v2', { exact: true }).waitFor();
  await detailRegion.getByText('Changed', { exact: false }).waitFor();
  assert.equal(await trustRepository.isDisabled(), true);
  await screenshot('-mcp-changed');
  await conversation
    .getByRole('button', { name: 'Not now', exact: true })
    .click();
  await trustNotice.waitFor({ state: 'hidden' });
  await rm(repoMcp);
  await rm(repoHooks);
  const instructionPath = join(first.directory, 'CLAUDE.md');
  await writeFile(instructionPath, Buffer.alloc(256 * 1024 + 1));
  await page.locator('[data-session-mcp]').click();
  await mcpPopover.getByText(/The file exceeds 256 KiB/).waitFor();
  await page.keyboard.press('Escape');
  await conversation.getByText('Repository configuration is paused').waitFor();
  await detailRegion
    .getByText(/The file exceeds 256 KiB.*CLAUDE\.md/)
    .waitFor();
  assert.equal(await trustRepository.count(), 0);
  await conversation
    .getByRole('button', { name: 'Not now', exact: true })
    .click();
  await rm(instructionPath);
  const projectSkillPath = join(
    first.directory,
    '.claude',
    'skills',
    'fixture-project-skill',
    'SKILL.md',
  );
  await mkdir(join(first.directory, '.git'), { recursive: true });
  await mkdir(join(projectSkillPath, '..'), { recursive: true });
  await writeFile(
    projectSkillPath,
    '---\nname: fixture-project-skill\ndescription: Project inventory fixture.\n---\nMetadata only.\n',
  );
  await seedNativeSkill(first.directory);
  const onboardingSkillsDirectory = join(directory, 'host', 'workspaces');
  assert.deepEqual(
    (await readSkillsTrace()).filter(
      trace => trace.directory !== onboardingSkillsDirectory,
    ),
    [],
  );
  await skillsOpener.click();
  await skillsPanel
    .getByText('fixture-project-skill', { exact: true })
    .waitFor();
  assert.equal(await skillsPanel.getAttribute('data-session-id'), first.id);
  await skillsPanel
    .getByRole('heading', { name: 'Shared library', exact: true })
    .waitFor();
  await skillsPanel
    .getByLabel('Search skills', { exact: true })
    .fill('fixture-user-skill');
  await skillsPanel.getByText('fixture-user-skill', { exact: true }).waitFor();
  assert.equal(
    await skillsPanel
      .getByLabel('Details for fixture-project-skill', { exact: true })
      .count(),
    0,
  );
  assert.equal(
    await skillsPanel
      .getByRole('button', { name: /^(?:Invoke|Run|Use)(?: skill)?$/i })
      .count(),
    0,
  );
  await skillsPanel.getByLabel('Search skills', { exact: true }).fill('');
  await skillsPanel
    .getByRole('button', { name: 'Refresh skills', exact: true })
    .click();
  await skillsPanel
    .getByText('fixture-project-skill', { exact: true })
    .waitFor();
  await closeSkills();
  await screenshot('-empty-session');
  await messageEditor.fill('/');
  await skillPicker
    .getByRole('option', { name: 'Fixture Codex instructions', exact: true })
    .click();
  await page
    .getByLabel('Selected skill: Fixture Codex instructions', { exact: true })
    .waitFor();
  await send('fixture:stream');
  await message('Fixture streamed reply.').waitFor();
  const firstCompleted = await waitState(first.id, 'completed');
  assert.equal(firstCompleted.actualModel, 'fixture-sonnet');
  assert.equal(firstCompleted.messages.at(-1).body, 'Fixture streamed reply.');
  assert.equal(firstCompleted.messages.at(-1).state, 'completed');
  const sharedInstructionsMessage = firstCompleted.messages.at(-2);
  assert.equal(sharedInstructionsMessage.skill.delivery, 'instructions');
  assert.deepEqual(sharedInstructionsMessage.skill.origins, ['Codex']);
  assert.equal(
    sharedInstructionsMessage.skillHash,
    sharedInstructionsMessage.skill.contentHash,
  );
  const sharedInstructionsBadge = conversation.getByLabel(
    'Requested skill: Fixture Codex instructions',
    { exact: true },
  );
  await sharedInstructionsBadge.waitFor();
  assert.ok(
    (await sharedInstructionsBadge.getAttribute('title')).includes(
      sharedInstructionsMessage.skill.path,
    ),
  );
  await waitReview(first.id, 0, 'done');
  const beforeDuplicate = await page.evaluate(async () => ({
    sessions: await window.nesvo.listSessions(),
    reviews: await window.nesvo.listReviews(),
  }));
  const refuseSecondInstance = async () => {
    const duplicateApp = spawn(
      executablePath,
      process.platform === 'linux'
        ? ['--no-sandbox', ...launchArgs]
        : launchArgs,
      {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
    );
    let duplicateStderr = '';
    duplicateApp.stderr.setEncoding('utf8');
    duplicateApp.stderr.on('data', value => {
      duplicateStderr = (duplicateStderr + value).slice(-4000);
    });
    const duplicateExit = new Promise((resolve, reject) => {
      duplicateApp.once('error', reject);
      duplicateApp.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let duplicateTimer;
    try {
      assert.deepEqual(
        await Promise.race([
          duplicateExit,
          new Promise((_, reject) => {
            duplicateTimer = setTimeout(
              () =>
                reject(
                  new Error(
                    `Second application instance did not exit: ${duplicateStderr}`,
                  ),
                ),
              15000,
            );
          }),
        ]),
        { code: 0, signal: null },
        duplicateStderr,
      );
    } finally {
      clearTimeout(duplicateTimer);
      if (
        duplicateApp.pid &&
        duplicateApp.exitCode === null &&
        duplicateApp.signalCode === null
      )
        duplicateApp.kill();
      await duplicateExit;
    }
  };
  const firstStatePath = join(
    firstCompleted.directory,
    `.nesvo-fixture-${firstCompleted.providerSessionId}.json`,
  );
  const firstTurnState = await readFile(firstStatePath, 'utf8');
  const originalPidFile = await readFile(pidFile, 'utf8');
  await refuseSecondInstance();
  assert.equal(await readFile(pidFile, 'utf8'), originalPidFile);
  assert.equal(await readFile(firstStatePath, 'utf8'), firstTurnState);
  assert.deepEqual(
    byId(await page.evaluate(() => window.nesvo.listSessions())),
    byId(beforeDuplicate.sessions),
  );
  assert.deepEqual(
    byId(await page.evaluate(() => window.nesvo.listReviews())),
    byId(beforeDuplicate.reviews),
  );
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('First session draft');
  await startThread({
    title: 'Workspace analysis',
    directory: join(directory, 'missing'),
  });
  await newThread.getByRole('alert').waitFor();
  assert.equal(await sessionByTitle('Workspace analysis'), undefined);
  assert.equal(
    await newThread
      .getByRole('textbox', { name: 'Message', exact: true })
      .inputValue(),
    'Workspace analysis',
  );
  const branchLocation = join(directory, 'branch-location');
  await mkdir(join(branchLocation, '.git'), { recursive: true });
  await writeFile(
    join(branchLocation, '.git', 'HEAD'),
    'ref: refs/heads/smoke-branch\n',
  );
  await chooseLocation(branchLocation);
  await newThread
    .locator('[data-thread-project]', { hasText: /^branch-location$/ })
    .waitFor();
  await page
    .locator('[data-branch-kind="branch"]', { hasText: 'smoke-branch' })
    .waitFor();
  await chooseLocation(directory);
  await newThread
    .locator('[data-thread-project]', { hasText: /^nesvo-desktop-/ })
    .waitFor();
  await page.locator('[data-branch-kind]').waitFor({ state: 'detached' });
  await newThread
    .getByRole('button', { name: 'Send message', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Workspace analysis', exact: true, level: 1 })
    .waitFor();
  assert.equal(
    (await sessionByTitle('Workspace analysis')).directory,
    directory,
  );
  const navigation = page.getByRole('navigation', { name: 'Sessions' });
  const primaryNavigation = page.getByRole('navigation', {
    name: 'Primary',
    exact: true,
  });
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .textContent(),
    'First session draft',
  );
  await page.reload();
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await message('Fixture streamed reply.').waitFor();
  await sharedInstructionsBadge.waitFor();
  await messageEditor.fill('/');
  await skillPicker
    .getByRole('option', { name: 'Fixture Codex instructions', exact: true })
    .click();
  await send('fixture:continue');
  await message('Fixture resumed reply.').waitFor();
  const sharedInstructionsResumed = await waitState(first.id, 'completed');
  assert.deepEqual(
    sharedInstructionsResumed.messages.at(-2).skill,
    sharedInstructionsMessage.skill,
  );
  const wrapperTrace = (await readFile(env.NESVO_FIXTURE_SKILL_LOG, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(wrapperTrace.length, 2);
  assert.equal(wrapperTrace[1].resumed, true);
  assert.equal(wrapperTrace[1].hash, sharedInstructionsMessage.skillHash);
  assert.match(wrapperTrace[1].instructions, /FIXTURE_CODEX_SHARED_MARKER/);
  await screenshot('');
  await send('fixture:hold');
  const stopped = await waitOwned();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await waitState(first.id, 'stopped');
  await Promise.all([waitDead(stopped.pid), waitDead(stopped.childPid)]);
  await send('fixture:fail');
  await page
    .getByRole('alert')
    .filter({ hasText: 'Fixture account limit reached.' })
    .waitFor();
  await waitState(first.id, 'failed');
  await screenshot('-failure');
  await openNewThread();
  await page.waitForFunction(
    async () => (await window.nesvo.codexStatus()).status === 'ready',
  );
  const claudeModes = (
    await page.evaluate(() => window.nesvo.claudeStatus())
  ).modes.filter(mode => mode !== 'full-access');
  await newThread
    .getByRole('button', { name: 'Permissions', exact: true })
    .click();
  await permissionsPicker
    .getByRole('radio', { name: 'Plan', exact: true })
    .waitFor();
  assert.equal(
    await permissionsPicker
      .getByRole('radio', { name: 'Workspace edits', exact: true })
      .count(),
    0,
  );
  assert.equal(
    await permissionsPicker
      .getByRole('radio', { name: /full access|bypass/i })
      .count(),
    0,
  );
  for (const [mode, label] of [
    ['accept-edits', 'Accept edits'],
    ['auto', 'Auto'],
  ])
    assert.equal(
      await permissionsPicker
        .getByRole('radio', { name: label, exact: true })
        .count(),
      claudeModes.includes(mode) ? 1 : 0,
    );
  assert.equal(
    await permissionsPicker
      .getByText('Claude runs read-only analysis in Nesvo', { exact: false })
      .count(),
    claudeModes.length > 1 ? 0 : 1,
  );
  await page.keyboard.press('Escape');
  await permissionsPicker.waitFor({ state: 'hidden' });
  if (claudeModes.includes('accept-edits')) {
    const modeTarget = await sessionByTitle('Workspace analysis');
    await navigation
      .getByRole('button', { name: /^Workspace analysis/ })
      .click();
    await page
      .getByRole('heading', {
        name: 'Workspace analysis',
        exact: true,
        level: 1,
      })
      .waitFor();
    await waitState(modeTarget.id, 'completed');
    const modeSwitch = conversation.getByRole('button', {
      name: 'Permission mode',
      exact: true,
    });
    const modeDialog = page.getByRole('dialog', {
      name: 'Permission mode',
      exact: true,
    });
    assert.equal((await modeSwitch.textContent()).trim(), 'Plan');
    await modeSwitch.click();
    assert.equal(
      await modeDialog
        .getByRole('radio', { name: /full access|bypass|workspace edits/i })
        .count(),
      0,
    );
    await modeDialog
      .getByRole('radio', { name: 'Accept edits', exact: true })
      .click();
    await modeDialog.waitFor({ state: 'hidden' });
    await modeSwitch.getByLabel('Applies next turn').waitFor();
    await send('Mode switch check');
    await conversation
      .getByText('Mode changed to Accept edits', { exact: true })
      .waitFor();
    const modeSwitched = await waitState(modeTarget.id, 'completed');
    assert.equal(modeSwitched.mode, 'accept-edits');
    assert.equal(modeSwitched.messages.at(-2).mode, 'accept-edits');
    await modeSwitch
      .getByLabel('Applies next turn')
      .waitFor({ state: 'hidden' });
    assert.equal((await modeSwitch.textContent()).trim(), 'Accept edits');
    await mcpChip.click();
    await mcpPopover
      .getByText('Follow provider settings', { exact: true })
      .waitFor();
    await page.keyboard.press('Escape');
    await mcpPopover.waitFor({ state: 'hidden' });
    await waitForFocus(mcpChip);
    await messageEditor.press('Shift+Tab');
    await modeSwitch.getByLabel('Applies next turn').waitFor();
    for (let step = 1; step < claudeModes.length; step += 1)
      await messageEditor.press('Shift+Tab');
    await modeSwitch
      .getByLabel('Applies next turn')
      .waitFor({ state: 'hidden' });
    assert.equal((await modeSwitch.textContent()).trim(), 'Accept edits');
    const claudeApproval = page.getByRole('region', {
      name: 'Operation approval',
      exact: true,
    });
    await send('fixture:ask-mcp');
    await claudeApproval
      .getByText('Use MCP tool fixture / lookup', { exact: true })
      .waitFor();
    await claudeApproval
      .getByRole('button', { name: 'Deny', exact: true })
      .click();
    await claudeApproval
      .getByRole('textbox', { name: 'Message with the denial', exact: true })
      .fill('Use the cached status.');
    await claudeApproval
      .getByRole('button', { name: 'Confirm denial', exact: true })
      .click();
    await message(
      'Fixture action denied: The operator denied this action. Their message: Use the cached status.',
    ).waitFor();
    await waitState(modeTarget.id, 'completed');
    await openNewThread();
  }
  assert.equal(
    await newThread.getByRole('combobox', { name: /role/i }).count(),
    0,
  );
  await startThread({
    title: 'Supervised Codex',
    provider: 'Codex',
    model: 'Codex fixture',
    effort: 'high',
    access: 'Workspace edits',
  });
  await page
    .getByRole('heading', { name: 'Supervised Codex', exact: true, level: 1 })
    .waitFor();
  const createdCodex = await sessionByTitle('Supervised Codex');
  await message('Codex fixture initial reply.').waitFor();
  const codex = await waitState(createdCodex.id, 'completed');
  assert.equal(codex.provider, 'Codex');
  assert.equal(codex.model, 'fixture-codex');
  assert.equal(codex.effort, 'high');
  assert.deepEqual(
    (await readFile(env.NESVO_CODEX_FIXTURE_RUN_LOG, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
      .filter(turn => turn.sessionId === codex.providerSessionId)
      .map(turn => turn.effort),
    ['high'],
  );
  assert.equal(codex.mode, 'supervised');
  assert.equal(codex.role, 'standalone');
  assert.equal(codex.delegationEnabled, true);
  await seedNativeSkill(codex.directory);
  await skillsOpener.click();
  await skillsPanel
    .getByText('Fixture project skill', { exact: true })
    .waitFor();
  await skillsPanel.getByText('Fixture user skill', { exact: true }).waitFor();
  const disabledSkill = skillsPanel.getByLabel(
    'Details for Fixture user skill',
    { exact: true },
  );
  await disabledSkill.click();
  await disabledSkill
    .locator('..')
    .getByText('Disabled at source', { exact: true })
    .waitFor();
  assert.equal(await skillsPanel.getAttribute('data-session-id'), codex.id);
  await skillsPanel
    .getByRole('heading', { name: 'Shared library', exact: true })
    .waitFor();
  assert.deepEqual(
    (await page.evaluate(() => window.nesvo.listSessions())).find(
      session => session.id === codex.id,
    ),
    codex,
  );
  const nativeSkillIds = await skillsPanel
    .locator('[data-skill-id]')
    .evaluateAll(rows =>
      rows.map(row => row.getAttribute('data-skill-id')).sort(),
    );
  await skillsPanel
    .getByRole('button', { name: 'Refresh skills', exact: true })
    .click();
  await skillsPanel
    .getByText('Fixture project skill', { exact: true })
    .waitFor();
  assert.deepEqual(
    await skillsPanel
      .locator('[data-skill-id]')
      .evaluateAll(rows =>
        rows.map(row => row.getAttribute('data-skill-id')).sort(),
      ),
    nativeSkillIds,
  );
  await closeSkills();
  const slowSkillsDirectory = join(directory, 'skills-hold');
  await mkdir(slowSkillsDirectory);
  const slowSkillsSession = await page.evaluate(
    input => window.nesvo.createSession(input),
    {
      title: 'Slow skill inventory',
      provider: 'Codex',
      model: 'fixture-codex',
      mode: 'read-only',
      directory: slowSkillsDirectory,
    },
  );
  await navigation
    .getByRole('button', { name: /^Slow skill inventory/ })
    .click();
  await skillsOpener.click();
  await waitSkillsTrace(slowSkillsDirectory, 'skills/list');
  await closeSkills();
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await skillsOpener.click();
  await skillsPanel
    .getByText('fixture-project-skill', { exact: true })
    .waitFor();
  const slowProbe = await waitSkillsTrace(
    slowSkillsDirectory,
    'skills/list:completed',
  );
  await waitDead(slowProbe.pid);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await skillsPanel.getAttribute('data-session-id'), first.id);
    assert.equal(
      await skillsPanel
        .getByLabel('Details for fixture-project-skill', { exact: true })
        .isVisible(),
      true,
    );
    await delay(100);
  }
  assert.equal(
    (await page.evaluate(() => window.nesvo.listSessions())).find(
      session => session.id === slowSkillsSession.id,
    ).messages.length,
    0,
  );
  assert.equal(await readFile(userSkillPath, 'utf8'), userSkillText);
  await closeSkills();
  assert.ok(
    (await readSkillsTrace()).every(
      trace =>
        !trace.methods.some(method =>
          /^(?:account|model|thread|turn)\//.test(method),
        ),
    ),
  );
  await navigation.getByRole('button', { name: /^Supervised Codex/ }).click();
  const projectSkillOption = skillPicker.getByRole('option', {
    name: 'Fixture Claude instructions',
    exact: true,
  });
  const selectedSkillChip = page.getByLabel(
    'Selected skill: Fixture Claude instructions',
    { exact: true },
  );
  const waitForUniqueSkillChoice = async () => {
    await page.waitForFunction(() => {
      const picker = document.querySelector(
        '[role="listbox"][aria-label="Skills"]',
      );
      const choices = [
        ...(picker?.querySelectorAll('[role="option"]') ?? []),
      ].filter(option => option.getAttribute('aria-disabled') !== 'true');
      return (
        choices.length === 1 &&
        choices[0].getAttribute('aria-label') ===
          'Fixture Claude instructions' &&
        choices[0].getAttribute('aria-selected') === 'true'
      );
    });
  };
  await messageEditor.fill('/fixture-claude-instructions');
  await projectSkillOption.waitFor();
  await waitForUniqueSkillChoice();
  await messageEditor.press('Escape');
  await skillPicker.waitFor({ state: 'hidden' });
  assert.equal(
    await messageEditor.textContent(),
    '/fixture-claude-instructions',
  );
  await messageEditor.fill('/');
  await projectSkillOption.waitFor();
  assert.equal(
    await skillPicker
      .getByRole('option', { name: 'Fixture user skill', exact: true })
      .getAttribute('aria-disabled'),
    'true',
  );
  await messageEditor.fill('/fixture-claude-instructions');
  await waitForUniqueSkillChoice();
  await messageEditor.press('ArrowDown');
  await messageEditor.press('Enter');
  await selectedSkillChip.waitFor();
  assert.match(
    await selectedSkillChip.getAttribute('title'),
    /fixture-claude-instructions/,
  );
  await page.getByRole('button', { name: 'Remove skill', exact: true }).click();
  await selectedSkillChip.waitFor({ state: 'hidden' });
  await messageEditor.fill('/fixture-claude-instructions');
  await projectSkillOption.waitFor();
  await waitForUniqueSkillChoice();
  await messageEditor.press('Tab');
  await selectedSkillChip.waitFor();
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  assert.equal(await selectedSkillChip.count(), 0);
  await navigation.getByRole('button', { name: /^Supervised Codex/ }).click();
  await selectedSkillChip.waitFor();
  await send('fixture:stream');
  await selectedSkillChip.waitFor({ state: 'hidden' });
  await message('Codex fixture streamed reply.').waitFor();
  const codexCompleted = await waitState(codex.id, 'completed');
  assert.equal(codexCompleted.actualModel, 'fixture-codex');
  assert.equal(
    codexCompleted.messages.at(-1).body,
    'Codex fixture streamed reply.',
  );
  assert.equal(codexCompleted.messages.at(-1).state, 'completed');
  const requestedSkillMessage = codexCompleted.messages.at(-2);
  assert.equal(requestedSkillMessage.skillId, requestedSkillMessage.skill.id);
  assert.equal(requestedSkillMessage.skill.name, 'Fixture Claude instructions');
  assert.equal(requestedSkillMessage.skill.source, 'user');
  assert.equal(requestedSkillMessage.skill.delivery, 'native');
  assert.ok(requestedSkillMessage.skill.origins.includes('Claude Code'));
  assert.equal(
    requestedSkillMessage.skillHash,
    requestedSkillMessage.skill.contentHash,
  );
  const requestedSkillBadge = conversation.getByLabel(
    'Requested skill: Fixture Claude instructions',
    { exact: true },
  );
  await requestedSkillBadge.waitFor();
  assert.ok(
    (await requestedSkillBadge.getAttribute('title')).includes(
      requestedSkillMessage.skill.path,
    ),
  );
  const selectedTurn = (await readSkillsTrace()).find(
    trace =>
      trace.directory === codex.directory &&
      trace.method === 'turn/start' &&
      trace.input?.[0]?.text === 'fixture:stream',
  );
  assert.deepEqual(selectedTurn.input, [
    { type: 'text', text: 'fixture:stream', text_elements: [] },
    {
      type: 'skill',
      name: requestedSkillMessage.skill.name,
      path: requestedSkillMessage.skill.path,
    },
  ]);
  assert.equal(codexCompleted.mode, 'supervised');
  const completedActivities = runActivities(
    codexCompleted,
    codexCompleted.runId,
  );
  assert.ok(completedActivities.length >= 2);
  assert.deepEqual(
    completedActivities.map(activity => activity.kind).toSorted(),
    ['command', 'read'],
  );
  for (const activity of completedActivities) {
    assert.equal(activity.status, 'completed');
    assert.ok(
      Date.parse(activity.completedAt) >= Date.parse(activity.startedAt),
    );
  }
  await activityFor(codexCompleted.runId)
    .getByText(/^Worked for/)
    .waitFor();
  assert.match(
    await activityFor(codexCompleted.runId)
      .getByLabel('Toggle activity', { exact: true })
      .innerText(),
    /Worked for/,
  );
  await checkActivityRows(codexCompleted.runId, completedActivities);
  const approval = page.getByRole('region', {
    name: 'Operation approval',
    exact: true,
  });
  await send('fixture:approve');
  await approval.waitFor();
  await approval.getByText(/fixture write approved marker/).waitFor();
  const approvalTarget = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === codex.id);
  const statusFilter = page.getByRole('radiogroup', {
    name: 'Filter sessions by status',
    exact: true,
  });
  const needsMeFilter = statusFilter.getByRole('radio', { name: /^Needs you/ });
  await needsMeFilter.click();
  assert.equal(await needsMeFilter.getAttribute('aria-checked'), 'true');
  await navigation.getByRole('button', { name: /^Supervised Codex/ }).waitFor();
  await navigation
    .getByRole('button', { name: /^Prototype analysis/ })
    .waitFor({ state: 'hidden' });
  await screenshot('-keyboard-filter');
  await statusFilter.getByRole('radio', { name: 'All', exact: true }).click();
  await navigation
    .getByRole('button', { name: /^Prototype analysis/ })
    .waitFor();
  const lifecycleDescription = await navigation
    .getByRole('button', { name: /^Prototype analysis/ })
    .evaluate(
      node =>
        document.getElementById(node.getAttribute('aria-describedby') ?? '')
          ?.textContent ?? '',
    );
  assert.match(
    lifecycleDescription,
    /^Created [A-Z][a-z]{2} \d{1,2}, \d{4}, .+ \((just now|\d+[mhd] ago)\)\. Last activity (just now|\d+[mhd] ago)$/,
  );
  await page
    .getByRole('button', { name: 'Session list options', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Clean up…', exact: true }).click();
  const cleanup = page.getByRole('dialog', {
    name: 'Clean up sessions',
    exact: true,
  });
  await cleanup
    .getByText('No sessions inactive for 14 days or more.', { exact: true })
    .waitFor();
  await cleanup.getByRole('radio', { name: '7 days', exact: true }).click();
  await cleanup
    .getByText('No sessions inactive for 7 days or more.', { exact: true })
    .waitFor();
  assert.equal(
    await cleanup
      .getByRole('button', { name: 'Archive selected', exact: true })
      .isDisabled(),
    true,
  );
  await page.keyboard.press('Escape');
  await cleanup.waitFor({ state: 'hidden' });
  assert.equal(await guide.count(), 0);
  await page.keyboard.press('Control+Shift+P');
  const palette = page.getByRole('combobox', {
    name: 'Command palette',
    exact: true,
  });
  await palette.waitFor();
  await palette.fill('Getting started');
  await palette.press('Enter');
  await guide
    .getByRole('heading', { name: 'vibe with full control', exact: true })
    .waitFor();
  await guide.getByRole('button', { name: 'Get started', exact: true }).click();
  await guide
    .getByRole('heading', { name: 'Coding agents', exact: true })
    .waitFor();
  await guide
    .getByRole('button', { name: 'Finish setup later', exact: true })
    .click();
  await guide.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const aboutSettings = page.getByRole('dialog', {
    name: 'Settings',
    exact: true,
  });
  await aboutSettings
    .getByRole('button', { name: 'About', exact: true })
    .click();
  await aboutSettings
    .getByRole('button', { name: 'Open guide', exact: true })
    .click();
  await guide
    .getByRole('heading', { name: 'vibe with full control', exact: true })
    .waitFor();
  await guide
    .getByRole('button', { name: 'Finish setup later', exact: true })
    .click();
  await guide.waitFor({ state: 'detached' });
  assert.equal(
    await page.evaluate(() => localStorage.getItem('nesvo.onboarding.v1')),
    'completed',
  );
  await page.keyboard.press('Control+Shift+P');
  await palette.waitFor();
  await palette.fill('Prototype analysis');
  await page
    .getByRole('listbox', { name: 'Commands and sessions', exact: true })
    .getByRole('option', { name: /^Prototype analysis/ })
    .first()
    .waitFor();
  await screenshot('-keyboard-palette');
  await palette.press('Enter');
  await palette.waitFor({ state: 'hidden' });
  await page
    .getByRole('heading', { name: 'Prototype analysis', exact: true, level: 1 })
    .waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const inboxRulesDialog = page.getByRole('dialog', {
    name: 'Settings',
    exact: true,
  });
  await inboxRulesDialog
    .getByRole('button', { name: 'Inbox rules', exact: true })
    .click();
  const inboxRulesPage = inboxRulesDialog.locator(
    '[data-settings="inbox-rules"]',
  );
  await inboxRulesPage.waitFor();
  const suggestions = inboxRulesPage.getByRole('region', {
    name: 'Suggestions',
    exact: true,
  });
  await suggestions
    .getByText('Before push: review the diff locally', { exact: true })
    .waitFor();
  await suggestions
    .getByRole('button', { name: 'Add', exact: true })
    .first()
    .click();
  await suggestions
    .getByRole('button', { name: 'Added', exact: true })
    .waitFor();
  await inboxRulesPage
    .getByRole('region', { name: 'Rules', exact: true })
    .getByRole('switch', { name: 'Enable review-before-push', exact: true })
    .waitFor();
  const presetCatalog = await page.evaluate(() =>
    window.nesvo.listInboxRules({}, 'local'),
  );
  const presetRule = presetCatalog.rules.find(
    rule => rule.name === 'review-before-push',
  );
  assert.equal(presetRule.scope, 'global');
  assert.equal(presetRule.active, true);
  assert.match(presetRule.text, /pattern: "git push\*"/);
  await screenshot('-inbox-rules-settings');
  await page.keyboard.press('Escape');
  await inboxRulesDialog.waitFor({ state: 'hidden' });
  const inboxRuleFolder = join(directory, 'inbox-rules-project');
  await mkdir(inboxRuleFolder);
  const inboxRuleSession = await page.evaluate(
    input => window.nesvo.createSession(input),
    {
      title: 'Release check',
      provider: 'Claude Code',
      model: 'sonnet',
      mode: 'auto',
      directory: inboxRuleFolder,
    },
  );
  await page.evaluate(input => window.nesvo.sendMessage(input), {
    sessionId: inboxRuleSession.id,
    messageId: crypto.randomUUID(),
    text: 'fixture:bash git push origin main',
  });
  await openInbox();
  const ruleRow = page.getByRole('article', {
    name: 'Inbox rule review-before-push: Release check',
    exact: true,
  });
  await ruleRow.getByText('git push origin main').first().waitFor();
  await screenshot('-inbox-rules-item');
  await ruleRow.getByRole('button', { name: 'Decline', exact: true }).click();
  const declinedRule = await waitState(inboxRuleSession.id, 'completed');
  assert.match(
    declinedRule.messages.at(-1).body,
    /Inbox rule "review-before-push"/,
  );
  await page.evaluate(
    rule =>
      window.nesvo.deleteInboxRule(
        {
          scope: 'global',
          name: rule.name,
          expectedHash: rule.contentHash,
        },
        'local',
      ),
    presetRule,
  );
  const unrelatedBeforeApproval = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === first.id);
  await openInbox();
  const operationRow = page.getByRole('article', {
    name: `Operation approval: ${codex.title}`,
    exact: true,
  });
  await operationRow
    .getByText('Wants to run fixture write', { exact: true })
    .waitFor();
  await operationRow.getByText(/^fixture write approved marker/).waitFor();
  await screenshot('-approval');
  await operationRow.getByRole('button', { name: 'Deny', exact: true }).click();
  const declinedOperation = await waitState(codex.id, 'completed');
  assert.equal(declinedOperation.runId, approvalTarget.runId);
  assert.equal(
    declinedOperation.messages.at(-1).body,
    'Codex fixture command declined.',
  );
  assert.deepEqual(
    (await page.evaluate(() => window.nesvo.listSessions())).find(
      session => session.id === first.id,
    ),
    unrelatedBeforeApproval,
  );
  await operationRow.waitFor({ state: 'hidden' });
  await navigation.getByRole('button', { name: /^Supervised Codex/ }).click();
  await message('Codex fixture command declined.').waitFor();
  await send('fixture:file');
  await approval.waitFor();
  await approval
    .getByRole('button', { name: 'Allow once', exact: true })
    .click();
  await message('Codex fixture file accepted.').waitFor();
  await waitState(codex.id, 'completed');
  await page.reload();
  await navigation.getByRole('button', { name: /^Supervised Codex/ }).click();
  const restoredActivitySession = (await fullSessions(page)).find(
    session => session.id === codex.id,
  );
  assert.deepEqual(
    runActivities(restoredActivitySession, codexCompleted.runId),
    completedActivities,
  );
  assert.deepEqual(
    restoredActivitySession.messages.find(
      message => message.id === requestedSkillMessage.id,
    ).skill,
    requestedSkillMessage.skill,
  );
  await requestedSkillBadge.waitFor();
  await message('Codex fixture file accepted.').waitFor();
  await messageEditor.fill('/');
  await projectSkillOption.click();
  await selectedSkillChip.waitFor();
  await send('fixture:continue');
  await message('Codex fixture resumed reply.').waitFor();
  const codexResumed = await waitState(codex.id, 'completed');
  assert.equal(
    codexResumed.providerSessionId,
    codexCompleted.providerSessionId,
  );
  assert.equal(
    codexResumed.messages.at(-1).body,
    'Codex fixture resumed reply.',
  );
  assert.deepEqual(
    codexResumed.messages.at(-2).skill,
    requestedSkillMessage.skill,
  );
  await send('fixture:approval-hold');
  await approval.waitFor();
  const codexStopped = await waitOwned('Codex');
  const beforeActivityStop = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === codex.id);
  const runningActivities = runActivities(
    beforeActivityStop,
    beforeActivityStop.runId,
  );
  assert.ok(
    runningActivities.some(
      activity =>
        activity.status === 'running' && activity.completedAt === null,
    ),
  );
  assert.match(
    await activityFor(beforeActivityStop.runId)
      .getByLabel('Toggle activity', { exact: true })
      .innerText(),
    /Working for/,
  );
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const codexStoppedSession = await waitState(codex.id, 'stopped');
  assert.equal(codexStoppedSession.messages.at(-1).state, 'stopped');
  assert.deepEqual(codexStoppedSession.pendingApprovals, []);
  const stoppedActivities = runActivities(
    codexStoppedSession,
    beforeActivityStop.runId,
  );
  for (const running of runningActivities.filter(
    activity => activity.status === 'running',
  )) {
    const stopped = stoppedActivities.find(
      activity => activity.id === running.id,
    );
    assert.equal(stopped.status, 'stopped');
    assert.ok(Date.parse(stopped.completedAt) >= Date.parse(stopped.startedAt));
  }
  assert.ok(
    Date.parse(codexStoppedSession.messages.at(-1).completedAt) >=
      Date.parse(codexStoppedSession.messages.at(-1).createdAt),
  );
  await activityFor(beforeActivityStop.runId)
    .getByText(/^Stopped after/)
    .waitFor();
  const stoppedActivitySummary = await activityFor(beforeActivityStop.runId)
    .getByLabel('Toggle activity', { exact: true })
    .innerText();
  assert.match(stoppedActivitySummary, /Stopped after/);
  await approval.waitFor({ state: 'hidden' });
  await Promise.all([
    waitDead(codexStopped.pid),
    waitDead(codexStopped.childPid),
  ]);
  assert.deepEqual(
    await page.evaluate(
      async id =>
        (await window.nesvo.listSessions()).find(session => session.id === id)
          .pendingApprovals,
      codex.id,
    ),
    [],
  );
  await page.reload();
  await navigation.getByRole('button', { name: /^Supervised Codex/ }).click();
  const restoredStoppedSession = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === codex.id);
  assert.deepEqual(
    runActivities(restoredStoppedSession, beforeActivityStop.runId),
    stoppedActivities,
  );
  assert.equal(
    restoredStoppedSession.messages.at(-1).completedAt,
    codexStoppedSession.messages.at(-1).completedAt,
  );
  await checkActivityRows(beforeActivityStop.runId, stoppedActivities);
  assert.equal(
    await activityFor(beforeActivityStop.runId)
      .getByLabel('Toggle activity', { exact: true })
      .innerText(),
    stoppedActivitySummary,
  );
  await startThread({
    title: 'Prototype orchestration',
    provider: 'Codex',
    model: 'Codex fixture',
    access: 'Read-only',
  });
  await page
    .getByRole('heading', {
      name: 'Prototype orchestration',
      exact: true,
      level: 1,
    })
    .waitFor();
  const orchestrator = await sessionByTitle('Prototype orchestration');
  assert.equal(orchestrator.delegationEnabled, true);
  assert.equal(orchestrator.mode, 'read-only');
  const coordinatorWake = await page.evaluate(
    sessionId => window.nesvo.readCoordinatorWake({ sessionId }),
    orchestrator.id,
  );
  await page.evaluate(input => window.nesvo.setCoordinatorWake(input), {
    sessionId: orchestrator.id,
    enabled: false,
    actionId: randomUUID(),
    expectedRevision: coordinatorWake.revision,
  });
  await message('Codex fixture initial reply.').waitFor();
  await waitState(orchestrator.id, 'completed');
  const proposal = title =>
    page
      .locator('[data-workers]')
      .getByRole('group', { name: title, exact: true })
      .first();
  await send('fixture:delegate');
  await proposal('Fixture worker A').waitFor();
  await proposal('Fixture worker B').waitFor();
  assert.equal(
    (await page.evaluate(() => window.nesvo.listSessions())).filter(
      session => session.parentId === orchestrator.id,
    ).length,
    0,
  );
  await screenshot('-delegation');
  const delegationTarget = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === orchestrator.id);
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await page
    .getByRole('heading', { name: 'Prototype analysis', exact: true, level: 1 })
    .waitFor();
  const unrelatedBeforeDelegation = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === first.id);
  await openInbox();
  const workerRow = title =>
    page.getByRole('article', {
      name: `Start worker: ${title}`,
      exact: true,
    });
  await workerRow('Fixture worker A')
    .getByRole('button', { name: 'Approve worker', exact: true })
    .click();
  await workerRow('Fixture worker B')
    .getByRole('button', { name: 'Decline', exact: true })
    .click();
  const firstDelegation = await waitState(orchestrator.id, 'completed');
  assert.equal(firstDelegation.role, 'orchestrator');
  assert.equal(firstDelegation.runId, delegationTarget.runId);
  assert.deepEqual(
    (await page.evaluate(() => window.nesvo.listSessions())).find(
      session => session.id === first.id,
    ),
    unrelatedBeforeDelegation,
  );
  const delegationResult = JSON.parse(
    firstDelegation.messages
      .at(-1)
      .body.slice('Codex delegation results: '.length),
  );
  assert.deepEqual(
    delegationResult.results.map(result => result.status),
    ['completed', 'declined'],
  );
  assert.match(delegationResult.results[0].text, /worker a completed/);
  await navigation
    .getByRole('button', { name: /^Prototype orchestration/ })
    .click();
  await proposal('Fixture worker A')
    .getByRole('button', { name: 'Open Fixture worker A', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Fixture worker A', exact: true, level: 1 })
    .waitFor();
  await message('Codex worker a completed its scoped task.').waitFor();
  await page
    .getByRole('button', { name: 'Back to parent session', exact: true })
    .click();
  await page
    .getByRole('heading', {
      name: 'Prototype orchestration',
      exact: true,
      level: 1,
    })
    .waitFor();
  const waitWorkers = async runId => {
    const deadline = Date.now() + 20_000;
    let children = [];
    while (Date.now() < deadline) {
      children = await page.evaluate(
        async ({ id, runId }) =>
          (await window.nesvo.listSessions()).filter(
            session => session.parentId === id && session.parentRunId === runId,
          ),
        { id: orchestrator.id, runId },
      );
      if (
        children.length === 2 &&
        children.every(
          child =>
            child.status === 'running' &&
            child.messages.at(-1).body.includes('is waiting.'),
        )
      )
        break;
      await delay(100);
    }
    assert.equal(children.length, 2);
    for (const child of children) {
      assert.equal(child.status, 'running');
      assert.equal(child.delegationEnabled, false);
      const pids = JSON.parse(
        await readFile(
          join(workerPidDirectory, `${child.providerSessionId}.json`),
          'utf8',
        ),
      );
      assert.ok(alive(pids.pid));
      assert.ok(alive(pids.childPid));
      providerPids.add(pids.pid);
      providerPids.add(pids.childPid);
      child.fixturePids = [pids.pid, pids.childPid];
    }
    return children;
  };
  const launchWorkers = async () => {
    await send('fixture:delegate-two-hold');
    await proposal('Fixture worker A')
      .getByRole('button', { name: 'Approve worker', exact: true })
      .waitFor();
    const current = (
      await page.evaluate(() => window.nesvo.listSessions())
    ).find(session => session.id === orchestrator.id);
    await proposal('Fixture worker A')
      .getByRole('button', { name: 'Approve worker', exact: true })
      .click();
    await proposal('Fixture worker B')
      .getByRole('button', { name: 'Approve worker', exact: true })
      .click();
    return { parent: current, children: await waitWorkers(current.runId) };
  };
  const concurrent = await launchWorkers();
  const childA = concurrent.children.find(
    child => child.title === 'Fixture worker A',
  );
  const childB = concurrent.children.find(
    child => child.title === 'Fixture worker B',
  );
  await screenshot('-workers');
  const subsessionBar = page.locator('[data-subsession-bar]');
  const showAgents = label =>
    subsessionBar.getByRole('button', {
      name: `${label}, show agents`,
      exact: true,
    });
  await showAgents('2 workers running').waitFor();
  const childCards = page.getByRole('region', { name: 'Child sessions' });
  const runningChildA = childCards.getByRole('button', {
    name: /^Fixture worker A Running/,
  });
  await runningChildA.waitFor();
  await childCards
    .getByRole('button', { name: /^Fixture worker B Running/ })
    .waitFor();
  await screenshot('-waiting-children');
  await sessionCardToggle.click();
  const subsessionsSection = sessionCard.getByRole('region', {
    name: 'Subsessions · 2 running',
    exact: true,
  });
  await subsessionsSection
    .getByRole('button', { name: /^Open Fixture worker A, Working/ })
    .waitFor();
  await subsessionsSection
    .getByRole('button', { name: /^Open Fixture worker B, Working/ })
    .waitFor();
  await screenshot('-subsessions');
  await page.keyboard.press('Escape');
  await sessionCard.waitFor({ state: 'hidden' });
  await showAgents('2 workers running').click();
  const agentsPanel = page.getByRole('dialog', { name: 'Agents' });
  await agentsPanel
    .getByRole('button', { name: /^Open Fixture worker A, Working/ })
    .waitFor();
  await agentsPanel
    .getByRole('button', { name: 'Stop Fixture worker B', exact: true })
    .waitFor();
  await screenshot('-agents');
  await page.keyboard.press('Escape');
  await agentsPanel.waitFor({ state: 'detached' });
  await showAgents('2 workers running').click();
  await agentsPanel
    .getByRole('button', { name: /^Open Fixture worker A, Working/ })
    .click();
  await page
    .getByRole('heading', { name: 'Fixture worker A', exact: true, level: 1 })
    .waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await waitState(childA.id, 'stopped');
  await Promise.all(childA.fixturePids.map(waitDead));
  const sibling = (await page.evaluate(() => window.nesvo.listSessions())).find(
    session => session.id === childB.id,
  );
  assert.equal(sibling.status, 'running');
  for (const pid of childB.fixturePids) assert.ok(alive(pid));
  await page
    .getByRole('button', { name: 'Back to parent session', exact: true })
    .click();
  await showAgents('1 worker running').waitFor();
  await childCards
    .getByRole('button', { name: /^Fixture worker A Stopped/ })
    .waitFor();
  await sessionCardToggle.press('Enter');
  const remainingSubsessions = sessionCard.getByRole('region', {
    name: 'Subsessions · 1 running',
    exact: true,
  });
  await remainingSubsessions
    .getByRole('button', { name: 'Previous subsessions, 2', exact: true })
    .click();
  await remainingSubsessions
    .getByRole('button', { name: /^Open Fixture worker A, Stopped/ })
    .waitFor();
  await screenshot('-subsessions-previous');
  await page.keyboard.press('Escape');
  await sessionCard.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Stop group', exact: true }).click();
  await waitState(orchestrator.id, 'stopped');
  await waitState(childB.id, 'stopped');
  await Promise.all(childB.fixturePids.map(waitDead));
  await page.reload();
  await navigation
    .getByRole('button', { name: /^Prototype orchestration/ })
    .click();
  const reloadedGroup = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === orchestrator.id);
  assert.equal(reloadedGroup.status, 'stopped');
  assert.ok(
    reloadedGroup.delegations
      .filter(item => item.runId === concurrent.parent.runId)
      .every(item => item.status === 'stopped'),
  );
  const reviewDirectory = join(directory, 'review-workspace');
  await mkdir(reviewDirectory);
  await mkdir(join(reviewDirectory, 'notes', 'nested'), { recursive: true });
  const nestedFileText =
    'Nested workspace explorer fixture.\nCurrent file preview.\n';
  await Promise.all([
    writeFile(join(reviewDirectory, 'tracked.txt'), 'user dirty baseline\n'),
    writeFile(join(reviewDirectory, 'deleted.txt'), 'delete this baseline\n'),
    writeFile(join(reviewDirectory, 'dirty.txt'), 'unrelated operator edits\n'),
    writeFile(
      join(reviewDirectory, 'notes', 'nested', 'context.txt'),
      nestedFileText,
    ),
  ]);
  await startThread({
    title: 'Review changes',
    provider: 'Codex',
    model: 'Codex fixture',
    access: 'Workspace edits',
    directory: reviewDirectory,
  });
  await page
    .getByRole('heading', { name: 'Review changes', exact: true, level: 1 })
    .waitFor();
  const writingSession = await sessionByTitle('Review changes');
  assert.equal(writingSession.directory, reviewDirectory);
  assert.equal(writingSession.mode, 'supervised');
  await message('Codex fixture initial reply.').waitFor();
  await waitState(writingSession.id, 'completed');
  const introReview = await waitReview(writingSession.id, 0, 'done');
  await send('fixture:review-write');
  await message('Codex fixture initial files.').waitFor();
  const initialFiles = await waitState(writingSession.id, 'completed');
  assert.equal(
    initialFiles.messages.at(-1).body,
    'Codex fixture initial files.',
  );
  const initialReview = await waitReview(
    writingSession.id,
    introReview.version,
  );
  assert.equal(
    initialReview.diff.status,
    'complete',
    initialReview.diff.detail,
  );
  assert.equal(initialReview.diff.files.length, 3);
  const reviewRow = review =>
    page.getByRole('article', {
      name: `Review result: Review changes, version ${review.version}`,
      exact: true,
    });
  const savedResultsTrigger = page.getByRole('button', {
    name: 'Saved results',
    exact: true,
  });
  const savedResults = page.getByRole('dialog', {
    name: 'Saved results',
    exact: true,
  });
  const reviewPanel = review => savedResults.locator(`#review-${review.id}`);
  const reviewDetails = review =>
    reviewPanel(review).locator(':scope > details');
  const revealEarlierVersions = async () => {
    if (!(await savedResults.isVisible())) await savedResultsTrigger.click();
    const earlier = savedResults.getByLabel(/^\d+ earlier versions?$/);
    if (!(await earlier.count())) return;
    const disclosure = earlier.locator('..');
    if ((await disclosure.getAttribute('open')) === null) await earlier.click();
  };
  const diffPanel = page.getByRole('region', {
    name: 'Saved result diff',
    exact: true,
  });
  const checkSavedDiff = async (review, before, after) => {
    await diffPanel.waitFor();
    assert.equal(await diffPanel.getAttribute('data-review-id'), review.id);
    assert.equal(
      await diffPanel.getAttribute('data-review-version'),
      String(review.version),
    );
    await diffPanel
      .getByRole('button', { name: 'View changes in tracked.txt', exact: true })
      .click();
    const viewer = diffPanel.getByTestId('saved-diff-content');
    const removedLine = viewer
      .locator('[data-line][data-line-type="change-deletion"]')
      .filter({ hasText: before });
    const addedLine = viewer
      .locator('[data-line][data-line-type="change-addition"]')
      .filter({ hasText: after });
    await removedLine.waitFor({ state: 'visible' });
    await addedLine.waitFor({ state: 'visible' });
    assert.ok(Number(await removedLine.getAttribute('data-line')) > 0);
    assert.ok(Number(await addedLine.getAttribute('data-line')) > 0);
    await viewer
      .locator('[data-line-number-content]')
      .first()
      .waitFor({ state: 'visible' });
    assert.equal(await viewer.getAttribute('data-file-path'), 'tracked.txt');
    assert.equal(
      await diffPanel
        .getByRole('button', {
          name: 'View changes in tracked.txt',
          exact: true,
        })
        .getAttribute('aria-pressed'),
      'true',
    );
    const savedPatch = diffPanel.getByLabel('Saved patch', { exact: true });
    if (!(await savedPatch.isVisible()))
      await diffPanel.getByText('Raw patch', { exact: true }).click();
    const patch = await savedPatch.innerText();
    assert.ok(patch.includes('tracked.txt'));
    assert.ok(patch.split('\n').includes(`-${before}`));
    assert.ok(patch.split('\n').includes(`+${after}`));
    return patch;
  };
  const openSavedDiff = async (review, before, after) => {
    await revealEarlierVersions();
    const details = reviewDetails(review);
    if ((await details.getAttribute('open')) === null)
      await details
        .getByLabel(`Open version ${review.version}`, { exact: true })
        .click();
    const opener = reviewPanel(review).getByRole('button', {
      name: `View diff for version ${review.version}`,
      exact: true,
    });
    await opener.click();
    return { patch: await checkSavedDiff(review, before, after) };
  };
  const closeSavedDiff = async () => {
    await page.keyboard.press('Escape');
    await diffPanel.waitFor({ state: 'hidden' });
    await waitForFocus(savedResultsTrigger);
  };
  const filesOpener = page.getByRole('button', {
    name: 'Open files',
    exact: true,
  });
  const filesPanel = page.getByRole('region', {
    name: 'Workspace files',
    exact: true,
  });
  const currentPreview = filesPanel.getByRole('region', {
    name: 'File preview',
    exact: true,
  });
  const checkWorkspaceFiles = async () => {
    await filesPanel.waitFor();
    assert.equal(await filesPanel.getAttribute('data-slot'), 'side-panel');
    assert.equal(
      await filesPanel.getAttribute('data-session-id'),
      writingSession.id,
    );
    await filesPanel.getByText(/^Current workspace/).waitFor();
    await filesPanel.getByText('review-workspace', { exact: true }).waitFor();
  };
  const openWorkspaceFile = async (path, text) => {
    await filesPanel
      .getByRole('button', { name: `Open file ${path}`, exact: true })
      .click();
    await currentPreview.getByText(text, { exact: false }).waitFor();
    assert.equal(await currentPreview.getAttribute('data-file-path'), path);
  };
  const closeWorkspaceFiles = async () => {
    await page.keyboard.press('Escape');
    await filesPanel.waitFor({ state: 'hidden' });
    await waitForFocus(filesOpener);
  };
  const openReviewSession = async review => {
    await reviewRow(review)
      .getByRole('button', {
        name: 'Open session: Review changes',
        exact: true,
      })
      .click();
    await page
      .getByRole('heading', { name: 'Review changes', exact: true, level: 1 })
      .waitFor();
    await reviewDetails(review).and(page.locator('details[open]')).waitFor();
    assert.notEqual(await reviewDetails(review).getAttribute('open'), null);
    assert.equal(
      await navigation
        .getByRole('button', { name: /^Review changes/ })
        .getAttribute('aria-current'),
      'page',
    );
  };
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await page
    .getByRole('heading', { name: 'Prototype analysis', exact: true, level: 1 })
    .waitFor();
  await openInbox();
  await reviewRow(initialReview).waitFor();
  await reviewRow(initialReview)
    .getByText(/^Changed \d+ files?$/)
    .waitFor();
  await reviewRow(initialReview)
    .getByRole('button', { name: 'Open diff', exact: true })
    .waitFor();

  const outcomeSession = async (title, prompt, extra = {}) => {
    const folder = join(directory, title);
    await mkdir(folder);
    const session = await page.evaluate(
      input => window.nesvo.createSession(input),
      {
        title,
        model: 'sonnet',
        provider: 'Claude Code',
        directory: folder,
        ...extra,
      },
    );
    await page.evaluate(input => window.nesvo.sendMessage(input), {
      sessionId: session.id,
      messageId: randomUUID(),
      text: prompt,
    });
    return waitState(session.id, 'completed');
  };
  const questionSession = await outcomeSession(
    'Release channel',
    'fixture:ask-option',
  );
  await outcomeSession(
    'Release plan',
    'fixture:exit-plan Check the release notes and publish the changelog',
    { planFirst: true },
  );
  const doneSession = await outcomeSession(
    'Documentation scan',
    'fixture:say The contributor instructions are up to date.',
  );
  const doneRow = navigation.getByRole('button', {
    name: /^Documentation scan .* Done .* Unread$/,
  });
  await doneRow.waitFor();
  await doneRow.getByText('Done', { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('article', { name: /Review result: Documentation scan/ })
      .count(),
    0,
  );
  const questionRow = page.getByRole('article', {
    name: 'Question for you: Release channel',
  });
  await questionRow.getByText('Asks you to choose an option').waitFor();
  await questionRow.getByText('Which release channel should I use?').waitFor();
  await questionRow
    .getByRole('button', { name: 'Preview', exact: true })
    .waitFor();
  await questionRow
    .getByRole('textbox', { name: 'Reply', exact: true })
    .waitFor();
  assert.equal(
    await questionRow
      .getByRole('button', { name: 'Accept result', exact: true })
      .count(),
    0,
  );
  await page.getByText('Plan needs your approval', { exact: true }).waitFor();
  if (inboxOutcomeScreenshots) {
    await mkdir(inboxOutcomeScreenshots, { recursive: true });
    const originalSize = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getContentSize(),
    );
    const captureInbox = async name => {
      await page.evaluate(
        () =>
          new Promise(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const encoded = await application.evaluate(async ({ BrowserWindow }) => {
        const image =
          await BrowserWindow.getAllWindows()[0].webContents.capturePage(
            undefined,
            { stayHidden: true, stayAwake: true },
          );
        return image.toPNG().toString('base64');
      });
      await writeFile(
        join(inboxOutcomeScreenshots, name),
        Buffer.from(encoded, 'base64'),
      );
    };
    for (const [width, height] of [
      [1920, 1080],
      [1280, 800],
    ]) {
      await application.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0].setContentSize(...size);
        },
        [width, height],
      );
      await page.waitForFunction(
        ([width, height]) => innerWidth === width && innerHeight === height,
        [width, height],
      );
      await captureInbox('inbox-' + width + 'x' + height + '.png');
    }
    await questionRow
      .getByRole('textbox', { name: 'Reply', exact: true })
      .focus();
    await captureInbox('question-quick-replies.png');
    await reviewRow(initialReview)
      .getByRole('button', { name: 'Open diff', exact: true })
      .focus();
    await captureInbox('result-review.png');
    await doneRow.focus();
    await captureInbox('sidebar-done-unread.png');
    await application.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setContentSize(...size),
      originalSize,
    );
  }
  await questionRow
    .getByRole('button', { name: 'Stable', exact: true })
    .click();
  await questionRow.waitFor({ state: 'hidden' });
  const repliedSession = await waitState(
    questionSession.id,
    'completed',
    questionSession.runId,
  );
  assert.equal(repliedSession.messages.at(-2)?.body, 'Stable');
  await doneRow.click();
  await navigation
    .getByRole('button', { name: /^Documentation scan .* Done$/ })
    .waitFor();
  await page
    .getByRole('button', { name: 'Saved results', exact: false })
    .first()
    .waitFor();
  assert.ok(doneSession.id);
  await openInbox();
  await screenshot('-inbox');
  await openReviewSession(initialReview);
  const initialDiff = await openSavedDiff(
    initialReview,
    'user dirty baseline',
    'initial agent text',
  );
  assert.doesNotMatch(
    initialDiff.patch,
    /dirty\.txt|unrelated operator edits|\.nesvo-codex/,
  );
  await screenshot('-review');
  await closeSavedDiff();
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await page
    .getByRole('heading', { name: 'Prototype analysis', exact: true, level: 1 })
    .waitFor();
  await openInbox();
  await reviewRow(initialReview)
    .getByRole('button', { name: 'Request changes', exact: true })
    .click();
  assert.equal(
    await reviewRow(initialReview)
      .getByRole('button', { name: 'Send feedback', exact: true })
      .isDisabled(),
    true,
  );
  const feedback = 'fixture:review-correct Please correct the result.';
  await reviewRow(initialReview)
    .getByRole('textbox', { name: 'Feedback', exact: true })
    .fill(feedback);
  await screenshot('-inline-feedback');
  await reviewRow(initialReview)
    .getByRole('button', { name: 'Send feedback', exact: true })
    .click();
  await page
    .getByRole('heading', { name: 'Review changes', exact: true, level: 1 })
    .waitFor();
  await message('Codex fixture corrected files.').waitFor();
  const correctedFiles = await waitState(writingSession.id, 'completed');
  assert.equal(
    correctedFiles.providerSessionId,
    initialFiles.providerSessionId,
  );
  const correctedReview = await waitReview(
    writingSession.id,
    initialReview.version,
  );
  assert.equal(correctedReview.decision, null);
  await openInbox();
  await openReviewSession(correctedReview);
  await revealEarlierVersions();
  if ((await reviewDetails(initialReview).getAttribute('open')) === null) {
    await reviewPanel(initialReview)
      .getByLabel(`Open version ${initialReview.version}`, { exact: true })
      .click();
    await reviewDetails(initialReview)
      .and(page.locator('details[open]'))
      .waitFor();
  }
  const staleAccept = reviewPanel(initialReview).getByRole('button', {
    name: 'Accept result',
    exact: true,
  });
  if (await staleAccept.count())
    assert.equal(await staleAccept.isDisabled(), true);
  await reviewPanel(initialReview)
    .getByRole('paragraph')
    .filter({ hasText: feedback })
    .waitFor();
  const historicalDiff = await openSavedDiff(
    initialReview,
    'user dirty baseline',
    'initial agent text',
  );
  assert.doesNotMatch(historicalDiff.patch, /corrected agent text/);
  await closeSavedDiff();
  const correctedDiff = await openSavedDiff(
    correctedReview,
    'initial agent text',
    'corrected agent text',
  );
  await screenshot('-correction');
  await closeSavedDiff();
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await page
    .getByRole('heading', { name: 'Prototype analysis', exact: true, level: 1 })
    .waitFor();
  await openInbox();
  await reviewRow(correctedReview)
    .getByRole('button', { name: 'Accept result', exact: true })
    .click();
  await reviewRow(correctedReview).waitFor({ state: 'hidden' });
  assert.equal(
    await readFile(join(reviewDirectory, 'dirty.txt'), 'utf8'),
    'unrelated operator edits\n',
  );
  await page.reload();
  await openInbox();
  await page
    .getByRole('radiogroup', { name: 'Inbox view' })
    .getByRole('radio', { name: 'History', exact: true })
    .click();
  await reviewRow(correctedReview)
    .getByText(`Version ${correctedReview.version}`, {
      exact: true,
    })
    .waitFor();
  const persistedReview = (
    await page.evaluate(() => window.nesvo.listReviews())
  ).find(review => review.id === correctedReview.id);
  assert.equal(persistedReview.status, 'accepted');
  assert.equal(persistedReview.decision.decision, 'accept');
  await screenshot('-accepted');
  await openReviewSession(correctedReview);
  await reviewPanel(correctedReview)
    .getByText('Accepted', { exact: true })
    .waitFor();
  const currentTrackedText = 'Live workspace edit after the saved result.';
  await writeFile(
    join(reviewDirectory, 'tracked.txt'),
    currentTrackedText + '\n',
  );
  await filesOpener.click();
  await checkWorkspaceFiles();
  await filesPanel
    .getByRole('button', { name: 'Expand notes', exact: true })
    .click();
  await filesPanel
    .getByRole('button', { name: 'Expand notes/nested', exact: true })
    .click();
  await openWorkspaceFile(
    'notes/nested/context.txt',
    'Nested workspace explorer fixture.',
  );
  await currentPreview
    .getByText('Current file preview.', { exact: false })
    .waitFor();
  await filesPanel
    .getByLabel('Search files', { exact: true })
    .fill('tracked.txt');
  await openWorkspaceFile('tracked.txt', currentTrackedText);
  await filesPanel
    .getByRole('button', {
      name: `Open saved result version ${correctedReview.version}`,
      exact: true,
    })
    .waitFor();
  await screenshot('-files');
  await closeWorkspaceFiles();
  await revealEarlierVersions();
  if ((await reviewDetails(initialReview).getAttribute('open')) === null) {
    await reviewPanel(initialReview)
      .getByLabel(`Open version ${initialReview.version}`, { exact: true })
      .click();
  }
  await openSavedDiff(
    initialReview,
    'user dirty baseline',
    'initial agent text',
  );
  await diffPanel
    .getByRole('button', { name: 'Browse workspace files', exact: true })
    .click();
  await diffPanel.waitFor({ state: 'hidden' });
  await checkWorkspaceFiles();
  await filesPanel
    .getByLabel('Search files', { exact: true })
    .fill('tracked.txt');
  await openWorkspaceFile('tracked.txt', currentTrackedText);
  await filesPanel
    .getByRole('button', {
      name: `Open saved result version ${initialReview.version}`,
      exact: true,
    })
    .click();
  await filesPanel.waitFor({ state: 'hidden' });
  const returnedHistoricalPatch = await checkSavedDiff(
    initialReview,
    'user dirty baseline',
    'initial agent text',
  );
  assert.doesNotMatch(
    returnedHistoricalPatch,
    /Live workspace edit|corrected agent text/,
  );
  await diffPanel
    .getByRole('button', { name: 'Close diff', exact: true })
    .click();
  await diffPanel.waitFor({ state: 'hidden' });
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await openNewThread();
  await newThread
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Cancelled session');
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await newThread.waitFor({ state: 'hidden' });
  assert.equal(
    await navigation.getByRole('button', { name: /Cancelled session/ }).count(),
    0,
  );
  assert.equal(await sessionByTitle('Cancelled session'), undefined);
  await page
    .getByRole('searchbox', { name: 'Search sessions' })
    .fill('nonexistent session');
  await page.getByText('No matching sessions.').waitFor();
  await page.getByRole('searchbox', { name: 'Search sessions' }).fill('');
  const sidebarResizer = page.getByRole('separator', {
    name: 'Resize sidebar',
    exact: true,
  });
  assert.equal(await sidebarResizer.getAttribute('aria-valuenow'), '256');
  await sidebarResizer.focus();
  await sidebarResizer.press('Home');
  assert.equal(await sidebarResizer.getAttribute('aria-valuenow'), '208');
  assert.equal(
    await page.evaluate(() => localStorage.getItem('nesvo.sidebar-width.v1')),
    '208',
  );
  await sidebarResizer.dblclick();
  assert.equal(await sidebarResizer.getAttribute('aria-valuenow'), '256');
  const sidebarToggle = primaryNavigation.getByRole('button', {
    name: /^(Collapse|Expand) sidebar$/,
  });
  assert.equal(
    await sidebarToggle.getAttribute('aria-label'),
    'Collapse sidebar',
  );
  await sidebarToggle.click();
  await navigation.waitFor({ state: 'hidden' });
  assert.equal(await sidebarToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(
    await sidebarToggle.getAttribute('aria-label'),
    'Expand sidebar',
  );
  await waitForFocus(sidebarToggle);
  await page.keyboard.press('Control+b');
  await navigation.waitFor({ state: 'visible' });
  assert.equal(await sidebarToggle.getAttribute('aria-pressed'), 'true');
  assert.equal(
    await sidebarToggle.getAttribute('aria-label'),
    'Collapse sidebar',
  );
  await waitForFocus(sidebarToggle);
  await messageEditor.press('Control+b');
  await navigation.waitFor({ state: 'hidden' });
  await page.keyboard.press('Control+b');
  await navigation.waitFor({ state: 'visible' });
  await page
    .getByRole('navigation', { name: 'Breadcrumb', exact: true })
    .getByRole('heading', { name: 'Prototype analysis', level: 1 })
    .waitFor();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(720, 700),
  );
  await page.getByRole('button', { name: 'Open sessions' }).click();
  const sidebar = page.getByRole('dialog', { name: 'Navigation', exact: true });
  await screenshot('-navigation');
  await sidebar.getByRole('button', { name: /^Workspace analysis/ }).click();
  await sidebar.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Open context' }).click();
  const details = page.getByRole('dialog', {
    name: 'Context',
    exact: true,
  });
  const contextFolder = details.getByText(basename(directory), { exact: true });
  await contextFolder.waitFor();
  assert.equal(await contextFolder.getAttribute('title'), directory);
  await page.keyboard.press('Escape');
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.getByRole('button', { name: 'Open sessions' }).click();
  await sidebar.getByRole('button', { name: /^Review changes/ }).click();
  await sidebar.waitFor({ state: 'hidden' });
  await revealEarlierVersions();
  if ((await reviewDetails(correctedReview).getAttribute('open')) === null) {
    await reviewPanel(correctedReview)
      .getByLabel(`Open version ${correctedReview.version}`, { exact: true })
      .click();
  }
  await openSavedDiff(
    correctedReview,
    'initial agent text',
    'corrected agent text',
  );
  const bounds = await diffPanel.boundingBox();
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewportWidth + 1);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await screenshot('-compact');
  await closeSavedDiff();
  await filesOpener.click();
  await checkWorkspaceFiles();
  await filesPanel
    .getByLabel('Search files', { exact: true })
    .fill('context.txt');
  await openWorkspaceFile(
    'notes/nested/context.txt',
    'Nested workspace explorer fixture.',
  );
  const filesBounds = await filesPanel.boundingBox();
  assert.ok(
    filesBounds.x >= 0 &&
      filesBounds.x + filesBounds.width <= viewportWidth + 1,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await closeWorkspaceFiles();
  await page.getByRole('button', { name: 'Open sessions' }).click();
  await sidebar
    .getByRole('button', { name: /^Prototype orchestration/ })
    .click();
  await sidebar.waitFor({ state: 'hidden' });
  const shutdownGroup = await launchWorkers();
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1280, 900),
  );
  await navigation.waitFor({ state: 'visible' });
  await navigation.getByRole('button', { name: /^Review changes/ }).click();
  await revealEarlierVersions();
  if ((await reviewDetails(initialReview).getAttribute('open')) === null)
    await reviewPanel(initialReview)
      .getByLabel(`Open version ${initialReview.version}`, { exact: true })
      .click();
  await openSavedDiff(
    initialReview,
    'user dirty baseline',
    'initial agent text',
  );
  const beforeRestart = await page.evaluate(async () => ({
    sessions: await window.nesvo.listSessions(),
    reviews: await window.nesvo.listReviews(),
  }));
  const pendingResult = beforeRestart.reviews.find(
    review => review.status === 'pending',
  );
  assert.ok(
    pendingResult,
    'Restart must preserve a result awaiting a decision',
  );
  assert.deepEqual(errors, []);
  await application.close();
  application = undefined;
  const closedHostPid = hostPid;
  await Promise.all([...providerPids, hostPid].map(waitDead));
  hostPid = undefined;
  const usageTraceOffset = (await readUsageTrace()).length;
  const fixtureState = async () => {
    const paths = (await readdir(env.NESVO_CODEX_FIXTURE_STATE_DIR)).map(name =>
      join(env.NESVO_CODEX_FIXTURE_STATE_DIR, name),
    );
    for (const session of beforeRestart.sessions)
      if (session.provider === 'Claude Code' && session.providerInitialized)
        paths.push(
          join(
            session.directory,
            `.nesvo-fixture-${session.providerSessionId}.json`,
          ),
        );
    return Promise.all(
      paths.sort().map(async path => [path, await readFile(path, 'utf8')]),
    );
  };
  const stateAfterClose = await fixtureState();
  await writeFile(
    usageControl,
    JSON.stringify({ 'Claude Code': 'unavailable', Codex: 'unavailable' }),
  );
  application = await launchApplication();
  const restartedPage = await application.firstWindow();
  restartedPage.setDefaultTimeout(20000);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1280, 900),
  );
  restartedPage.on('pageerror', error => errors.push(error.message));
  await restartedPage.emulateMedia({ reducedMotion: 'reduce' });
  await restartedPage
    .getByRole('heading', { name: writingSession.title, exact: true, level: 1 })
    .waitFor();
  hostPid = JSON.parse(await readFile(pidFile, 'utf8')).host;
  assert.equal(typeof hostPid, 'number');
  const restartedDiff = restartedPage.getByRole('region', {
    name: 'Saved result diff',
    exact: true,
  });
  await restartedDiff.waitFor();
  assert.equal(
    await restartedDiff.getAttribute('data-review-id'),
    initialReview.id,
  );
  assert.equal(
    await restartedDiff.getAttribute('data-review-version'),
    String(initialReview.version),
  );
  await restartedDiff
    .locator('[data-testid="saved-diff-content"][data-file-path="tracked.txt"]')
    .waitFor();
  await restartedDiff.getByText('Raw patch', { exact: true }).click();
  const restoredPatch = await restartedDiff
    .getByLabel('Saved patch', { exact: true })
    .innerText();
  assert.equal(restoredPatch, initialDiff.patch);
  assert.doesNotMatch(
    restoredPatch,
    /corrected agent text|Live workspace edit/,
  );
  const restartedUsage = await checkUsagePanel(restartedPage, 'unavailable');
  await restartedPage.keyboard.press('Escape');
  await restartedUsage.panel.waitFor({ state: 'hidden' });
  for (const provider of ['Claude Code', 'Codex']) {
    const indicator = restartedPage.locator(
      `[data-provider-indicator="${provider}"]`,
    );
    assert.equal(
      await indicator.getAttribute('aria-label'),
      `${provider} limits: unavailable`,
    );
    assert.equal(
      await indicator.getAttribute('data-usage-state'),
      'unavailable',
    );
  }
  const restartedUsageProbes = (await readUsageTrace()).slice(usageTraceOffset);
  assert.deepEqual(
    restartedUsageProbes.map(trace => trace.provider).sort(),
    initialUsageProbes.map(trace => trace.provider).sort(),
  );
  for (const trace of restartedUsageProbes) {
    providerPids.add(trace.pid);
    await waitDead(trace.pid);
  }
  const restored = await restartedPage.evaluate(async () => ({
    sessions: await window.nesvo.listSessions(),
    reviews: await window.nesvo.listReviews(),
  }));
  assert.deepEqual(byId(restored.reviews), byId(beforeRestart.reviews));
  for (const session of beforeRestart.sessions.filter(
    session => !['running', 'stopping'].includes(session.status),
  ))
    assert.deepEqual(
      restored.sessions.find(value => value.id === session.id),
      session,
    );
  const resumedParent = restored.sessions.find(
    session => session.id === orchestrator.id,
  );
  assert.equal(resumedParent.runId, shutdownGroup.parent.runId);
  for (const session of [
    resumedParent,
    ...shutdownGroup.children.map(child =>
      restored.sessions.find(session => session.id === child.id),
    ),
  ]) {
    assert.equal(session.status, 'interrupted');
    assert.equal(session.interruption.reason, 'host-shutdown');
    assert.equal(session.interruption.runId, session.runId);
    assert.deepEqual(
      session.messages.at(-1).interruption,
      session.interruption,
    );
    assert.deepEqual(session.pendingApprovals, []);
  }
  for (const child of shutdownGroup.children) {
    const restoredChild = restored.sessions.find(
      session => session.id === child.id,
    );
    for (const key of [
      'parentId',
      'parentRunId',
      'providerSessionId',
      'runId',
      'scope',
      'directory',
    ])
      assert.equal(restoredChild[key], child[key]);
    const proposal = resumedParent.delegations.find(
      proposal => proposal.childSessionId === child.id,
    );
    assert.equal(proposal.runId, shutdownGroup.parent.runId);
    assert.equal(proposal.status, 'interrupted');
  }
  const acceptedRetry = {
    reviewId: correctedReview.id,
    version: correctedReview.version,
    decisionId: persistedReview.decision.id,
    decision: 'accept',
    feedback: persistedReview.decision.feedback,
  };
  const correctedVersion = beforeRestart.reviews.find(
    review => review.id === initialReview.id,
  );
  const correctionRetry = {
    reviewId: initialReview.id,
    version: initialReview.version,
    decisionId: correctedVersion.decision.id,
    decision: 'request-changes',
    feedback,
  };
  for (const input of [acceptedRetry, correctionRetry]) {
    const retried = await restartedPage.evaluate(
      input => window.nesvo.decideReview(input),
      input,
    );
    assert.deepEqual(
      retried,
      beforeRestart.reviews.find(review => review.id === input.reviewId),
    );
  }
  await delay(200);
  assert.deepEqual(await fixtureState(), stateAfterClose);
  assert.deepEqual(
    byId(await restartedPage.evaluate(() => window.nesvo.listSessions())),
    byId(restored.sessions),
  );
  assert.deepEqual(
    byId(await restartedPage.evaluate(() => window.nesvo.listReviews())),
    byId(restored.reviews),
  );
  await restartedDiff
    .getByRole('button', { name: 'Close diff', exact: true })
    .focus();
  await restartedPage.keyboard.press('Escape');
  await restartedDiff.waitFor({ state: 'hidden' });
  await restartedPage
    .getByRole('button', { name: 'Inbox', exact: true })
    .click();
  const restartedInbox = restartedPage.getByRole('region', {
    name: 'Inbox',
    exact: true,
  });
  await restartedInbox.waitFor();
  await restartedInbox
    .getByRole('radiogroup', { name: 'Inbox view' })
    .getByRole('radio', { name: 'Pending', exact: true })
    .click();
  await restartedInbox
    .getByRole('article', {
      name: `Review result: ${pendingResult.title}, version ${pendingResult.version}`,
      exact: true,
    })
    .filter({ hasText: pendingResult.summary })
    .waitFor();
  await restartedInbox
    .getByRole('radiogroup', { name: 'Inbox view' })
    .getByRole('radio', { name: 'History', exact: true })
    .click();
  const restartedAccepted = restartedInbox.getByRole('article', {
    name: `Review result: ${correctedReview.title}, version ${correctedReview.version}`,
    exact: true,
  });
  await restartedAccepted
    .getByText(`Version ${correctedReview.version}`, {
      exact: true,
    })
    .waitFor();
  await restartedAccepted
    .getByRole('button', {
      name: `Open session: ${writingSession.title}`,
      exact: true,
    })
    .click();
  await restartedPage
    .getByRole('dialog', { name: 'Saved results', exact: true })
    .locator(`#review-${correctedReview.id} > details[open]`)
    .waitFor();
  await restartedPage
    .getByRole('navigation', { name: 'Sessions', exact: true })
    .getByRole('button', { name: /^Prototype orchestration/ })
    .click();
  const interruptedNotice = restartedPage.getByRole('region', {
    name: 'Interrupted run',
    exact: true,
  });
  await interruptedNotice.waitFor();
  await interruptedNotice
    .getByText('Interrupted when Nesvo closed', { exact: true })
    .waitFor();
  await interruptedNotice
    .getByText(
      'Use Continue coordinator in the session header. Resume interrupted workers from their rows.',
      {
        exact: true,
      },
    )
    .waitFor();
  await restartedPage
    .locator('header [data-coordinator-wait]')
    .getByRole('button', { name: 'Continue coordinator', exact: true })
    .first()
    .waitFor();
  await restartedPage
    .getByRole('textbox', { name: 'Message', exact: true })
    .click();
  assert.equal(
    await restartedPage
      .getByRole('textbox', { name: 'Message', exact: true })
      .evaluate(node => node === document.activeElement),
    true,
  );
  assert.deepEqual(
    byId(await restartedPage.evaluate(() => window.nesvo.listSessions())),
    byId(restored.sessions),
  );
  assert.deepEqual(await fixtureState(), stateAfterClose);
  const workflowCall = (method, ...args) =>
    restartedPage.evaluate(
      ([name, params]) => window.nesvo.workflows[name](...params),
      [method, args],
    );
  const workflowComputer = (
    await restartedPage.evaluate(() => window.nesvo.listComputers())
  ).find(computer => computer.id === 'local');
  assert.equal(workflowComputer.capabilities.includes('workflows'), true);
  const definitionCatalog = await workflowCall('listDefinitions', 'local', {
    directory,
  });
  assert.ok(Array.isArray(definitionCatalog.workflows));
  assert.ok(Array.isArray(definitionCatalog.issues));
  await assert.rejects(
    workflowCall('listDefinitions', 'local', { directory, recursive: true }),
  );
  await assert.rejects(
    workflowCall('listDefinitions', 'not-a-host', { directory }),
    /Invalid UUID/,
  );
  const workflowProject = join(directory, 'workflow-project');
  const workflowRoot = join(workflowProject, '.agents', 'workflows');
  for (const folder of [
    join(workflowProject, '.git'),
    join(workflowRoot, 'steps'),
    join(workflowRoot, 'workflows'),
    join(workflowProject, '.agents', 'tasks'),
  ])
    await mkdir(folder, { recursive: true });
  await writeFile(
    join(workflowRoot, 'steps', 'smoke-check.md'),
    '---\nname: smoke-check\ntype: command\nphase: pre-done\n---\necho ok\n',
  );
  await writeFile(
    join(workflowRoot, 'workflows', 'smoke.md'),
    '---\nname: smoke\nsteps: [smoke-check]\n---\n',
  );
  await writeFile(
    join(workflowProject, '.agents', 'tasks', 'smoke.md'),
    '---\nworkflow: smoke\ntitle: Smoke workflow task\n---\nCheck the workflow path.\n',
  );
  await restartedPage.evaluate(() => {
    window.smokeWorkflowRuns = [];
    window.nesvo.subscribe(event => {
      if (event.type === 'workflow-run-changed')
        window.smokeWorkflowRuns.push(event.run);
    });
  });
  const workflowRun = await workflowCall('startTask', 'local', {
    specPath: join('.agents', 'tasks', 'smoke.md'),
    workflowName: 'smoke',
    provider: 'Claude Code',
    model: 'sonnet',
    mode: 'read-only',
    directory: workflowProject,
    isolation: 'none',
    gateProvider: 'Claude Code',
    gateModel: 'sonnet',
  });
  assert.equal(workflowRun.hostId, 'local');
  assert.ok(workflowRun.sessionId);
  await restartedPage.waitForFunction(
    id =>
      window.smokeWorkflowRuns.some(
        run => run.id === id && run.status === 'passed',
      ),
    workflowRun.id,
    { timeout: 30_000 },
  );
  const workflowDetail = await workflowCall('getRun', 'local', workflowRun.id);
  assert.equal(workflowDetail.run.status, 'passed');
  assert.deepEqual(
    workflowDetail.steps.map(step => [step.name, step.state]),
    [['smoke-check', 'passed']],
  );
  await writeFile(
    join(workflowRoot, 'steps', 'smoke-review.md'),
    '---\nname: smoke-review\ntype: human\nphase: pre-done\n---\nReview the result.\n',
  );
  await writeFile(
    join(workflowRoot, 'workflows', 'flows-smoke.md'),
    '---\nname: flows-smoke\nsteps: [smoke-check, smoke-review]\n---\n',
  );
  await writeFile(
    join(workflowProject, '.agents', 'tasks', 'flows-smoke.md'),
    '---\nworkflow: flows-smoke\ntitle: Stage F1\n---\nPrepare the stage for review.\n',
  );
  await restartedPage
    .getByRole('button', { name: 'Workflows', exact: true })
    .click();
  await restartedPage
    .getByRole('region', { name: 'Workflows', exact: true })
    .getByRole('button', { name: 'Flows', exact: true })
    .click();
  const flows = restartedPage.getByRole('region', {
    name: 'Flows',
    exact: true,
  });
  await flows
    .getByRole('region', { name: 'Ad hoc orchestration', exact: true })
    .locator(`[data-orchestration-session="${resumedParent.id}"]`)
    .waitFor();
  assert.equal(await flows.locator('[data-flow-step]').count(), 0);
  const liveFlow = await workflowCall('startTask', 'local', {
    specPath: join('.agents', 'tasks', 'flows-smoke.md'),
    workflowName: 'flows-smoke',
    provider: 'Claude Code',
    model: 'sonnet',
    mode: 'read-only',
    directory: workflowProject,
    isolation: 'none',
    gateProvider: 'Claude Code',
    gateModel: 'sonnet',
  });
  const flowSession = flows
    .locator('[data-flow-step="smoke-review"]')
    .getByRole('button', { name: /Open Stage F1, Waiting for you/ });
  await flowSession.waitFor({ timeout: 30_000 });
  if (process.env.NESVO_FLOWS_SCREENSHOT) {
    await restartedPage.evaluate(
      () =>
        new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const encoded = await application.evaluate(async ({ BrowserWindow }) => {
      const image =
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(
          undefined,
          { stayHidden: true, stayAwake: true },
        );
      return image.toPNG().toString('base64');
    });
    await writeFile(
      process.env.NESVO_FLOWS_SCREENSHOT,
      Buffer.from(encoded, 'base64'),
    );
  }
  await flowSession.click();
  await restartedPage
    .getByRole('heading', { name: 'Stage F1', exact: true })
    .waitFor();
  await workflowCall('stopRun', 'local', liveFlow.id);
  await restartedPage.evaluate(() => {
    window.smokeAssistantProposals = [];
    window.smokeAssistantChanges = [];
    window.nesvo.subscribe(event => {
      if (event.type === 'workflow-assistant-proposal')
        window.smokeAssistantProposals.push(event);
      if (event.type === 'workflow-assistant-change')
        window.smokeAssistantChanges.push(event);
    });
  });
  for (const [name, type, phase, body] of [
    ['check', 'command', 'pre-done', 'echo check'],
    ['approve', 'human', 'pre-push', 'Approve the change.'],
  ])
    await writeFile(
      join(workflowRoot, 'steps', `${name}.md`),
      `---\nname: ${name}\ntype: ${type}\nphase: ${phase}\n---\n${body}\n`,
    );
  const assistantTurn = await workflowCall('assistantSend', 'local', {
    sessionId: null,
    provider: 'Claude Code',
    model: 'sonnet',
    text: 'fixture:assistant-live',
    context: {
      directory: workflowProject,
      workflowName: 'smoke',
      document: null,
    },
  });
  assert.match(assistantTurn.sessionId, /^[0-9a-f-]{36}$/);
  await restartedPage.waitForFunction(
    id => window.smokeAssistantProposals.some(event => event.messageId === id),
    assistantTurn.messageId,
    { timeout: 30_000 },
  );
  const assistantProposal = await restartedPage.evaluate(
    id => window.smokeAssistantProposals.find(event => event.messageId === id),
    assistantTurn.messageId,
  );
  assert.equal(assistantProposal.hostId, 'local');
  assert.equal(assistantProposal.sessionId, assistantTurn.sessionId);
  assert.equal(assistantProposal.status, 'ok');
  assert.deepEqual(assistantProposal.proposal.changes, []);
  const assistantChanges = await restartedPage.evaluate(
    id =>
      window.smokeAssistantChanges.filter(
        event => event.change.messageId === id,
      ),
    assistantTurn.messageId,
  );
  assert.deepEqual(
    assistantChanges.map(event => [
      event.hostId,
      event.change.kind,
      event.change.op,
      event.change.createdBy,
    ]),
    [
      ['local', 'step', 'create', 'assistant'],
      ['local', 'workflow', 'create', 'assistant'],
      ['local', 'automation', 'create', 'assistant'],
    ],
  );
  const assistantHistory = await workflowCall(
    'assistantChanges',
    'local',
    assistantTurn.sessionId,
  );
  assert.deepEqual(
    assistantHistory.changes,
    assistantChanges.map(event => event.change),
  );
  const [liveStep, liveWorkflow, liveAutomation] = assistantHistory.changes;
  const createdAutomation = (
    await restartedPage.evaluate(() => window.nesvo.scheduledJobs.list('local'))
  ).find(job => job.id === liveAutomation.target.automationId);
  assert.equal(createdAutomation.active, false);
  for (const change of [liveWorkflow, liveStep, liveAutomation]) {
    const undone = await workflowCall('assistantUndo', 'local', {
      conversationId: assistantTurn.sessionId,
      changeId: change.changeId,
    });
    assert.equal(undone.status, 'undone', JSON.stringify(undone));
  }
  await assert.rejects(
    readFile(join(workflowRoot, 'steps', 'lint-check.md'), 'utf8'),
  );
  await assert.rejects(
    readFile(join(workflowRoot, 'workflows', 'assistant-flow.md'), 'utf8'),
  );
  const resolution = {
    runId: workflowRun.id,
    stepId: workflowDetail.steps[0].id,
    decisionId: randomUUID(),
  };
  await assert.rejects(
    workflowCall('resolveStep', 'local', {
      ...resolution,
      resolution: 'mark-done',
      comment: '',
    }),
    /Describe what you verified/,
  );
  await assert.rejects(
    workflowCall('resolveStep', 'local', {
      ...resolution,
      resolution: 'run-again',
    }),
    /Only a step that may already have run can be marked done or run again\./,
  );
  console.log(
    JSON.stringify({
      workflows: {
        capabilities: workflowComputer.capabilities,
        runId: workflowRun.id,
        status: workflowDetail.run.status,
        rendererEvents: await restartedPage.evaluate(
          id => window.smokeWorkflowRuns.filter(run => run.id === id).length,
          workflowRun.id,
        ),
        assistant: {
          sessionId: assistantTurn.sessionId,
          status: assistantProposal.status,
          changes: assistantChanges.length,
          undone: assistantHistory.changes.length,
        },
      },
    }),
  );
  const graphStep = (name, type, phase, body, extra = '') =>
    writeFile(
      join(workflowRoot, 'steps', `${name}.md`),
      `---\nname: ${name}\ntype: ${type}\nphase: ${phase}\n${extra}---\n${body}\n`,
    );
  await graphStep('smoke-plan', 'agent', 'plan', 'Plan the change.');
  await graphStep('smoke-lint', 'command', 'pre-done', 'echo lint');
  await graphStep('smoke-report', 'command', 'pre-done', 'echo report');
  await graphStep('smoke-format', 'command', 'pre-done', 'echo format');
  await graphStep('smoke-approve', 'human', 'pre-push', 'Approve the release.');
  await graphStep(
    'smoke-publish',
    'action',
    'pre-push',
    'git push origin HEAD',
    'effect: external\n',
  );
  const editorShot = async name => {
    if (!process.env.NESVO_SCREENSHOT) return;
    await restartedPage.evaluate(
      () =>
        new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const encoded = await application.evaluate(async ({ BrowserWindow }) => {
      const image =
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(
          undefined,
          { stayHidden: true, stayAwake: true },
        );
      return image.toPNG().toString('base64');
    });
    await writeFile(
      process.env.NESVO_SCREENSHOT.replace(
        /\.png$/,
        `-graph-editor-${name}.png`,
      ),
      Buffer.from(encoded, 'base64'),
    );
  };
  await restartedPage.evaluate(() => window.nesvo.setColorScheme('dark'));
  await restartedPage
    .getByRole('button', { name: 'Workflows', exact: true })
    .click();
  const workflowsView = restartedPage.getByRole('region', {
    name: 'Workflows',
    exact: true,
  });
  await workflowsView
    .getByLabel('Project folder', { exact: true })
    .fill(workflowProject);
  await workflowsView
    .getByRole('button', { name: 'Read', exact: true })
    .click();
  await workflowsView
    .getByRole('button', { name: 'New workflow', exact: true })
    .first()
    .click();
  const newWorkflowDialog = restartedPage.getByRole('dialog', {
    name: 'New workflow',
    exact: true,
  });
  await newWorkflowDialog.waitFor();
  assert.equal(
    await newWorkflowDialog.getAttribute('data-placement'),
    'center',
  );
  assert.equal(
    await newWorkflowDialog
      .getByRole('textbox', { name: 'Name', exact: true })
      .getAttribute('aria-invalid'),
    'false',
  );
  await newWorkflowDialog.getByRole('combobox', { name: 'Saved in' }).waitFor();
  await newWorkflowDialog
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('smoke-graph');
  await newWorkflowDialog
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await newWorkflowDialog.waitFor({ state: 'hidden' });
  const editor = restartedPage.getByRole('region', {
    name: 'Graph editor',
    exact: true,
  });
  await editor.waitFor();
  assert.equal(
    await editor.getByRole('textbox', { name: 'Workflow name' }).inputValue(),
    'smoke-graph',
  );
  const inspector = editor.getByRole('complementary', {
    name: 'Inspector',
    exact: true,
  });
  const closeInspector = async () => {
    if (!(await inspector.isVisible())) return;
    await inspector
      .getByRole('button', { name: 'Close inspector', exact: true })
      .click();
    await inspector.waitFor({ state: 'hidden' });
  };
  const openPicker = async (from, when = 'success') => {
    const add = editor.locator(
      `[data-node-add="${from}"][data-node-add-when="${when}"]`,
    );
    await revealGraphControls([add]);
    await add.click();
    await restartedPage.locator('[data-node-picker]').waitFor();
  };
  const addGraphStep = async (name, from = '__start') => {
    await openPicker(from);
    await restartedPage.locator(`[data-picker-step="${name}"]`).click();
    await editor.locator(`[data-editor-node="${name}"]`).waitFor();
  };
  const edgeCount = id => editor.locator(`[data-editor-edge="${id}"]`).count();
  const fitGraph = () =>
    editor.getByRole('button', { name: 'Fit graph', exact: true }).click();
  const handleInfo = locator =>
    locator.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const centre = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      return {
        classes: element.className,
        pointerEvents: getComputedStyle(element).pointerEvents,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        atCentre: centre
          ? `${centre.tagName}.${centre.className}`.slice(0, 120)
          : null,
      };
    });
  const edgeInspector = (from, to) =>
    inspector.getByRole('group', {
      name: `Connection ${from} to ${to}`,
      exact: true,
    });
  const edgeShown = (from, to) =>
    edgeInspector(from, to)
      .waitFor({ timeout: 4000 })
      .then(
        () => true,
        () => false,
      );
  const canvas = editor.getByRole('application', {
    name: 'Workflow graph canvas',
    exact: true,
  });
  const inside = (box, frame) =>
    !!box &&
    !!frame &&
    box.x >= frame.x &&
    box.y >= frame.y &&
    box.x + box.width <= frame.x + frame.width &&
    box.y + box.height <= frame.y + frame.height;
  const revealGraphControls = async controls => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const frame = await canvas.boundingBox();
      const boxes = await Promise.all(
        controls.map(control => control.boundingBox()),
      );
      if (boxes.every(box => inside(box, frame))) return;
      await fitGraph();
      await delay(250);
    }
    throw new Error('Graph editor controls stay outside the canvas.');
  };
  const connectSteps = async (from, to, expectedRefusal) => {
    const sourceHandle = editor.getByLabel(`Connect from ${from}`, {
      exact: true,
    });
    const targetHandle = editor.getByLabel(`Connect into ${to}`, {
      exact: true,
    });
    await revealGraphControls([sourceHandle, targetHandle]);
    await sourceHandle.dragTo(targetHandle, { force: true, steps: 8 });
    if (expectedRefusal) {
      await restartedPage
        .locator('[data-editor-notice]')
        .filter({ hasText: expectedRefusal })
        .waitFor();
      return;
    }
    if (await edgeShown(from, to)) return;
    console.log(
      JSON.stringify({
        graphEditorConnect: {
          from: await handleInfo(sourceHandle),
          to: await handleInfo(targetHandle),
        },
      }),
    );
    await editorShot(`connect-${from}-${to}`);
    throw new Error(`The connection ${from} -> ${to} did not appear.`);
  };
  await addGraphStep('smoke-check');
  await addGraphStep('smoke-lint');
  await addGraphStep('smoke-report');
  await connectSteps('smoke-check', 'smoke-lint');
  await editor.locator('[data-editor-inspector="edge"]').waitFor();
  await connectSteps('smoke-check', 'smoke-report');
  const reportEdge = edgeInspector('smoke-check', 'smoke-report');
  await reportEdge
    .getByRole('button', { name: 'On success', exact: true, pressed: true })
    .waitFor();
  await reportEdge
    .getByRole('button', { name: 'On failure', exact: true })
    .press('Space');
  await reportEdge
    .getByRole('button', { name: 'On failure', exact: true, pressed: true })
    .waitFor();
  await editor
    .locator(
      '[data-editor-edge-label="smoke-check -> smoke-report on failure"]',
    )
    .waitFor();
  await editorShot('inspector-edge-dark');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await restartedPage
    .locator('[data-editor-notice]')
    .filter({ hasText: 'Saved smoke-graph.' })
    .waitFor();
  const graphFile = await readFile(
    join(workflowRoot, 'workflows', 'smoke-graph.md'),
    'utf8',
  );
  assert.match(
    graphFile,
    /^steps: \[smoke-check, smoke-lint, smoke-report\]$/m,
  );
  assert.match(
    graphFile,
    /edges:\n  - smoke-check -> smoke-lint\n  - smoke-check -> smoke-report on failure\n/,
  );
  assert.match(
    graphFile,
    /layout:\n  smoke-check: \[-?\d+, -?\d+\]\n  smoke-lint: \[-?\d+, -?\d+\]\n  smoke-report: \[-?\d+, -?\d+\]\n---\n/,
  );
  const savedCatalog = await workflowCall('listDefinitions', 'local', {
    directory: workflowProject,
  });
  const savedGraph = savedCatalog.workflows.find(
    workflow => workflow.name === 'smoke-graph',
  );
  assert.deepEqual(savedGraph.graph, {
    explicit: true,
    edges: [
      { from: 'smoke-check', to: 'smoke-lint', when: 'success' },
      { from: 'smoke-check', to: 'smoke-report', when: 'failure' },
    ],
  });
  assert.deepEqual(
    savedCatalog.issues.filter(issue => issue.path.endsWith('smoke-graph.md')),
    [],
  );
  await editor
    .getByRole('button', { name: 'Close graph editor', exact: true })
    .click();
  await workflowsView
    .getByRole('button', { name: 'Edit smoke-graph', exact: true })
    .click();
  await editor.waitFor();
  await editor.locator('[data-editor-node="smoke-report"]').waitFor();
  assert.equal(await editor.locator('[data-editor-node]').count(), 3);
  await addGraphStep('smoke-approve');
  await connectSteps(
    'smoke-lint',
    'smoke-approve',
    /^Edge "smoke-lint -> smoke-approve" crosses phases; "smoke-lint" is pre-done and "smoke-approve" is pre-push$/,
  );
  assert.equal(await editor.locator('[data-editor-edge-label]').count(), 1);
  await addGraphStep('smoke-plan');
  const agentPrompt = inspector.getByRole('textbox', {
    name: 'Instructions',
    exact: true,
  });
  assert.equal(
    await agentPrompt.evaluate(element => getComputedStyle(element).resize),
    'none',
  );
  await agentPrompt.fill('Plan the change.\n/fixture-claude');
  await restartedPage
    .getByRole('option', { name: 'Fixture Claude instructions', exact: true })
    .click();
  assert.equal(await agentPrompt.inputValue(), 'Plan the change.');
  await inspector
    .getByLabel('Selected skill: Fixture Claude instructions')
    .waitFor();
  await closeInspector();
  await addGraphStep('smoke-publish', 'smoke-approve');
  await editor
    .locator('[data-editor-edge="smoke-approve -> smoke-publish"]')
    .waitFor({ state: 'attached' });
  await editor.locator('[data-editor-inspector="node"]').waitFor();
  await closeInspector();
  await fitGraph();
  await editor
    .locator('[data-editor-edge="smoke-check -> smoke-lint"]')
    .hover({ force: true });
  await editor
    .locator('[data-edge-insert="smoke-check -> smoke-lint"]')
    .click();
  await restartedPage.locator('[data-node-picker]').waitFor();
  await restartedPage.locator('[data-picker-step="smoke-format"]').click();
  await editor.locator('[data-editor-node="smoke-format"]').waitFor();
  await editor
    .locator('[data-editor-edge="smoke-check -> smoke-format"]')
    .waitFor({ state: 'attached' });
  await editor
    .locator('[data-editor-edge="smoke-format -> smoke-lint"]')
    .waitFor({ state: 'attached' });
  assert.equal(await edgeCount('smoke-check -> smoke-lint'), 0);
  await editorShot('insert-dark');
  await closeInspector();
  await editor.locator('[data-editor-node="smoke-format"]').hover();
  await editor.locator('[data-node-delete="smoke-format"]').click();
  await editor
    .locator('[data-editor-node="smoke-format"]')
    .waitFor({ state: 'hidden' });
  assert.equal(await edgeCount('smoke-check -> smoke-format'), 0);
  await restartedPage.keyboard.press('Control+z');
  await editor.locator('[data-editor-node="smoke-format"]').waitFor();
  await editor
    .locator('[data-editor-edge="smoke-format -> smoke-lint"]')
    .waitFor({ state: 'attached' });
  await restartedPage.keyboard.press('Control+y');
  await editor
    .locator('[data-editor-node="smoke-format"]')
    .waitFor({ state: 'hidden' });
  await restartedPage.keyboard.press('Escape');
  await editor.locator('[data-editor-inspector]').waitFor({ state: 'hidden' });
  await fitGraph();
  await delay(300);
  await editorShot('fan-out-dark');
  await restartedPage.evaluate(() => window.nesvo.setColorScheme('light'));
  await delay(300);
  await editorShot('fan-out-light');
  await openPicker('__start');
  await restartedPage
    .getByRole('listbox', { name: 'Node picker', exact: true })
    .waitFor();
  await editorShot('palette-light');
  await restartedPage.evaluate(() => window.nesvo.setColorScheme('dark'));
  await delay(300);
  await editorShot('palette-dark');
  await restartedPage.keyboard.press('Escape');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await restartedPage
    .locator('[data-editor-notice]')
    .filter({ hasText: 'Saved smoke-graph.' })
    .waitFor();
  assert.match(
    await readFile(join(workflowRoot, 'steps', 'smoke-plan.md'), 'utf8'),
    /prompt_skill:.*Fixture Claude instructions/,
  );
  await writeFile(
    join(workflowRoot, 'workflows', 'smoke-graph.md'),
    (
      await readFile(join(workflowRoot, 'workflows', 'smoke-graph.md'), 'utf8')
    ).replace('---\n', '---\ndescription: Changed outside the editor.\n'),
  );
  await editor.getByRole('button', { name: 'Settings', exact: true }).click();
  await editor.locator('[data-editor-inspector="workflow"]').waitFor();
  await inspector
    .getByRole('textbox', { name: 'Description', exact: true })
    .fill('Changed inside the editor.');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  const conflictDialog = restartedPage.getByRole('dialog', {
    name: 'File changed on disk',
    exact: true,
  });
  await conflictDialog.waitFor();
  await conflictDialog
    .getByText('description: Changed outside the editor.')
    .waitFor();
  await editorShot('conflict-dark');
  await conflictDialog
    .getByRole('button', { name: 'Reload', exact: true })
    .click();
  await conflictDialog.waitFor({ state: 'hidden' });
  const reloadDeadline = Date.now() + 20_000;
  const descriptionField = inspector.getByRole('textbox', {
    name: 'Description',
    exact: true,
  });
  while (
    (await descriptionField.inputValue()) !== 'Changed outside the editor.' &&
    Date.now() < reloadDeadline
  )
    await delay(100);
  assert.equal(
    await descriptionField.inputValue(),
    'Changed outside the editor.',
  );
  assert.equal(
    await editor
      .getByRole('button', { name: 'Save', exact: true })
      .isDisabled(),
    true,
  );
  await editorShot('inspector-workflow-dark');
  await closeInspector();
  await openPicker('__start');
  await restartedPage.locator('[data-picker-new="command"]').click();
  await editor.locator('[data-editor-inspector="draft"]').waitFor();
  await inspector
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('smoke-timeout');
  await inspector
    .getByRole('textbox', { name: 'Command', exact: true })
    .fill('echo timeout');
  const timeoutField = inspector.getByRole('textbox', {
    name: 'Timeout',
    exact: true,
  });
  const durationMessage = inspector.getByText(
    'Use a duration such as 90s, 15m or 2h.',
    { exact: true },
  );
  const createStep = inspector.getByRole('button', {
    name: 'Create step',
    exact: true,
  });
  await timeoutField.fill('0');
  await timeoutField.press('Tab');
  await durationMessage.waitFor();
  assert.equal(await timeoutField.getAttribute('aria-invalid'), 'true');
  await createStep.click();
  await editor.locator('[data-editor-inspector="draft"]').waitFor();
  assert.equal(
    await editor.locator('[data-editor-node="smoke-timeout"]').count(),
    0,
  );
  await editorShot('inspector-step-error-dark');
  await timeoutField.fill('90');
  await durationMessage.waitFor({ state: 'hidden' });
  await createStep.click();
  await editor.locator('[data-editor-node="smoke-timeout"]').waitFor();
  await editor.locator('[data-editor-inspector="node"]').waitFor();
  await editorShot('inspector-step-dark');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await restartedPage
    .locator('[data-editor-notice]')
    .filter({ hasText: 'Saved smoke-graph.' })
    .waitFor();
  const savedTimeoutStep = join(workflowRoot, 'steps', 'smoke-timeout.md');
  for (
    let attempt = 0;
    attempt < 100 && !existsSync(savedTimeoutStep);
    attempt += 1
  )
    await delay(50);
  assert.match(await readFile(savedTimeoutStep, 'utf8'), /^timeout: 90m$/m);
  await closeInspector();
  await editor.locator('[data-editor-start]').click();
  await editor.locator('[data-editor-inspector="start"]').waitFor();
  await inspector
    .locator('[data-start-row="new-thread"]')
    .getByText('New thread', { exact: true })
    .waitFor();
  await editorShot('inspector-start-dark');
  await inspector
    .getByRole('button', { name: 'Add schedule', exact: true })
    .click();
  await inspector.getByRole('form', { name: 'Add schedule' }).waitFor();
  await editorShot('inspector-start-schedule-dark');
  await editor
    .getByRole('button', { name: 'Close graph editor', exact: true })
    .click();
  await workflowsView
    .getByRole('button', { name: 'Edit smoke', exact: true })
    .click();
  await editor.waitFor();
  const lastRunToggle = editor.getByRole('button', {
    name: 'Last run',
    exact: true,
  });
  if ((await lastRunToggle.getAttribute('aria-pressed')) !== 'true')
    await lastRunToggle.click();
  await editor
    .locator('[data-editor-node="smoke-check"][data-run-state="passed"]')
    .waitFor();
  await editor.locator('[data-editor-node="smoke-check"]').click();
  await editor.locator('[data-editor-inspector="node"]').waitFor();
  await inspector.getByText('Last run', { exact: true }).waitFor();
  await fitGraph();
  await delay(300);
  await editorShot('run-overlay-dark');
  await editor
    .getByRole('button', { name: 'Close graph editor', exact: true })
    .click();
  await workflowsView.waitFor();
  const dockConsoleErrors = [];
  const recordDockConsoleError = message => {
    if (message.type() === 'error') dockConsoleErrors.push(message.text());
  };
  restartedPage.on('console', recordDockConsoleError);
  await graphStep('check', 'command', 'pre-done', 'echo check');
  await graphStep('approve', 'human', 'pre-push', 'Approve the change.');
  const bothShots = async name => {
    await editorShot(`assistant-${name}-dark`);
    await restartedPage.evaluate(() => window.nesvo.setColorScheme('light'));
    await delay(300);
    await editorShot(`assistant-${name}-light`);
    await restartedPage.evaluate(() => window.nesvo.setColorScheme('dark'));
    await delay(300);
  };
  const deepText = locator =>
    locator.evaluate(node => {
      const walk = element =>
        [
          ...(element.shadowRoot ? element.shadowRoot.childNodes : []),
          ...element.childNodes,
        ]
          .map(child =>
            child.nodeType === Node.TEXT_NODE
              ? child.textContent
              : child.nodeType === Node.ELEMENT_NODE
                ? walk(child)
                : '',
          )
          .join('');
      return walk(node);
    });
  await workflowsView
    .getByRole('button', { name: 'Edit smoke', exact: true })
    .click();
  await editor.waitFor();
  const editorDock = editor.locator('[data-slot="editor-dock"]');
  const openAssistant = editorDock.getByRole('button', {
    name: /^Open assistant(?:,|$)/,
  });
  await openAssistant.waitFor();
  await bothShots('collapsed');
  await openAssistant.click();
  const assistantDock = editor.locator(
    '[data-slot="side-panel"][data-assistant-dock]',
  );
  await assistantDock.waitFor();
  assert.equal(await assistantDock.getAttribute('data-slot'), 'side-panel');
  await assistantDock.getByText(/^Describe a change to smoke\./).waitFor();
  await bothShots('empty');
  await assistantDock
    .getByRole('button', { name: 'Choose model', exact: true })
    .click();
  const modelPopover = restartedPage.getByRole('dialog', {
    name: 'Model',
    exact: true,
  });
  await modelPopover.waitFor();
  await modelPopover
    .getByRole('radio', { name: 'Claude Code', exact: true })
    .click();
  await modelPopover.getByRole('option').first().waitFor();
  await bothShots('model-picker');
  await modelPopover.getByRole('option').first().click();
  await modelPopover.waitFor({ state: 'hidden' });
  const assistantInput = assistantDock.getByRole('textbox', {
    name: 'Message the assistant',
    exact: true,
  });
  const sendToAssistant = async (text, shot) => {
    const before = await assistantDock.locator('[data-assistant-turn]').count();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await assistantInput.fill(text);
      await assistantInput.press('Enter');
      if (shot && attempt === 0) await editorShot(shot);
      const deadline = Date.now() + 15_000;
      let notice = '';
      while (Date.now() < deadline) {
        if (
          (await assistantDock.locator('[data-assistant-turn]').count()) >
          before
        )
          return;
        const alert = assistantDock.locator('form [role="alert"]');
        if (await alert.count()) {
          notice = await alert.textContent();
          break;
        }
        await delay(100);
      }
      if (!/Waiting for |Another session is using this folder/.test(notice))
        throw new Error(`The assistant did not accept "${text}". ${notice}`);
      await delay(500);
    }
    throw new Error(`The assistant stayed busy for "${text}".`);
  };
  await sendToAssistant('fixture:assistant-prose', 'assistant-sending-dark');
  const replyTurn = assistantDock
    .locator('[data-assistant-status="proposal"]')
    .filter({ hasText: 'I would add a lint step before the approval.' });
  await replyTurn.waitFor({ timeout: 30_000 });
  await bothShots('reply');
  await assistantInput.fill('/');
  const assistantSkills = restartedPage.getByRole('listbox', {
    name: 'Skills',
    exact: true,
  });
  await assistantSkills
    .getByRole('option', { name: 'Fixture Claude instructions', exact: true })
    .click();
  await assistantDock
    .getByLabel('Selected skill: Fixture Claude instructions')
    .waitFor();
  await assistantDock.getByRole('button', { name: 'Remove skill' }).click();
  const lintPath = join(workflowRoot, 'steps', 'lint-check.md');
  const flowPath = join(workflowRoot, 'workflows', 'assistant-flow.md');
  await assert.rejects(readFile(lintPath, 'utf8'));
  await sendToAssistant('fixture:assistant-live');
  const liveTurn = assistantDock
    .locator('[data-assistant-status="proposal"]')
    .filter({
      hasText: 'Added a lint check, a workflow and a disabled automation.',
    });
  await liveTurn.waitFor({ timeout: 30_000 });
  assert.equal(
    await readFile(lintPath, 'utf8'),
    '---\nname: lint-check\ntype: command\nphase: pre-done\ntimeout: 2m\n---\necho lint passed\n',
  );
  assert.match(
    await readFile(flowPath, 'utf8'),
    /steps: \[lint-check, check, approve\]/,
  );
  const dockText = await assistantDock.textContent();
  assert.equal(dockText.includes('[begin operator-request'), false);
  assert.equal(dockText.includes('fixture-secret-value'), false);
  assert.deepEqual(
    await assistantDock
      .locator('[data-assistant-turn] .bg-message-surface')
      .allTextContents(),
    ['fixture:assistant-prose', 'fixture:assistant-live'],
  );
  await bothShots('live');
  const dockConversation = (await fullSessions(restartedPage)).find(
    session =>
      session.title === 'Workflow assistant · smoke' &&
      session.messages.some(message =>
        message.body.includes('fixture:assistant-live'),
      ) &&
      session.id !== assistantTurn.sessionId,
  );
  const dockAutomation = (
    await workflowCall('assistantChanges', 'local', dockConversation.id)
  ).changes.find(change => change.kind === 'automation');
  assert.equal(
    (
      await workflowCall('assistantUndo', 'local', {
        conversationId: dockConversation.id,
        changeId: dockAutomation.changeId,
      })
    ).status,
    'undone',
  );
  const assistantSessionTitle = 'Workflow assistant · smoke';
  await assistantDock
    .getByRole('button', { name: 'Close assistant', exact: true })
    .click();
  await editor
    .getByRole('button', { name: 'Close graph editor', exact: true })
    .click();
  await workflowsView
    .getByRole('button', { name: 'Read', exact: true })
    .click();
  await workflowsView
    .getByRole('button', { name: 'Edit assistant-flow', exact: true })
    .click();
  await editor.waitFor();
  for (const name of ['lint-check', 'check', 'approve'])
    await editor.locator(`[data-editor-node="${name}"]`).waitFor();
  await openAssistant.click();
  await assistantDock.waitFor();
  await assistantDock
    .getByText(/^Describe a change to assistant-flow\./)
    .waitFor();
  await editor
    .getByRole('button', { name: 'Close graph editor', exact: true })
    .click();
  await workflowsView
    .getByRole('button', { name: 'Edit smoke', exact: true })
    .click();
  await editor.waitFor();
  if (!(await assistantDock.isVisible())) await openAssistant.click();
  await assistantDock
    .getByRole('button', { name: 'Open session', exact: true })
    .click();
  await restartedPage
    .getByRole('heading', { name: assistantSessionTitle, level: 1 })
    .waitFor();
  const assistantSession = (await fullSessions(restartedPage)).find(
    session =>
      session.title === assistantSessionTitle &&
      session.messages.some(message =>
        message.body.includes('fixture:assistant-prose'),
      ),
  );
  assert.ok(assistantSession);
  assert.equal(assistantSession.mode, 'read-only');
  assert.ok(
    assistantSession.messages.some(
      message =>
        message.author === 'operator' &&
        message.body.includes('[begin operator-request'),
    ),
  );
  restartedPage.off('console', recordDockConsoleError);
  assert.deepEqual(dockConsoleErrors, []);
  console.log(
    JSON.stringify({
      assistantDock: {
        sessionId: assistantSession.id,
        turns: 2,
        live: ['lint-check', 'assistant-flow'],
      },
    }),
  );
  await restartedPage
    .getByRole('button', { name: 'Workflows', exact: true })
    .click();
  await workflowsView.waitFor();
  const shareShot = async name => {
    const folder = process.env.NESVO_SHARE_SCREENSHOT_DIR;
    if (!folder) return;
    await restartedPage.evaluate(
      () =>
        new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const encoded = await application.evaluate(async ({ BrowserWindow }) => {
      const image =
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(
          undefined,
          { stayHidden: true, stayAwake: true },
        );
      return image.toPNG().toString('base64');
    });
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, `${shareServer.fake ? 'share' : 'share-e2e'}-${name}.png`),
      Buffer.from(encoded, 'base64'),
    );
  };
  const deliverLink = async link => {
    const second = spawn(executablePath, [...launchArgs, link], {
      env,
      stdio: 'ignore',
      windowsHide: true,
    });
    const code = await new Promise((resolve, reject) => {
      second.once('error', reject);
      second.once('exit', resolve);
    });
    assert.equal(code, 0, 'The second instance hands the link over and quits');
  };
  await workflowsView
    .getByLabel('Project folder', { exact: true })
    .fill(workflowProject);
  await workflowsView
    .getByRole('button', { name: 'Read', exact: true })
    .click();
  const sharedStepPath = join(workflowRoot, 'steps', 'smoke-check.md');
  const sharedStep = await readFile(sharedStepPath, 'utf8');
  const sharedWorkflow = await readFile(
    join(workflowRoot, 'workflows', 'smoke.md'),
    'utf8',
  );
  const fixtureToken = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8';
  await writeFile(
    sharedStepPath,
    sharedStep.replace('echo ok', `GITHUB_TOKEN=${fixtureToken} echo ok`),
  );
  await workflowsView
    .getByRole('button', { name: 'Share smoke', exact: true })
    .click();
  const shareDialog = restartedPage.getByRole('dialog', {
    name: 'Share smoke',
    exact: true,
  });
  const secrets = shareDialog.getByRole('region', {
    name: 'Possible secrets',
    exact: true,
  });
  await secrets.waitFor();
  assert.equal(
    await shareDialog
      .getByRole('button', { name: 'Upload and create link', exact: true })
      .count(),
    0,
  );
  assert.ok(!(await secrets.textContent()).includes(fixtureToken));
  await secrets.getByText('smoke-check.md:6', { exact: true }).waitFor();
  await shareShot('blocked');
  await writeFile(sharedStepPath, sharedStep);
  await shareDialog
    .getByRole('button', { name: 'Scan again', exact: true })
    .click();
  const uploadButton = shareDialog.getByRole('button', {
    name: 'Upload and create link',
    exact: true,
  });
  await uploadButton.waitFor();
  await shareDialog
    .getByRole('region', { name: 'Files to upload', exact: true })
    .getByText('steps/smoke-check.md · Command', { exact: true })
    .waitFor();
  if (shareServer.fake) assert.equal(shareServer.shares.size, 0);
  await shareShot('review');
  if (shareServer.fake) {
    shareServer.failNextCreate({ status: 429, retryAfter: 90 });
    await uploadButton.click();
    await shareDialog
      .getByText(/limiting new links\. Try again in 2 minutes\./)
      .waitFor();
    await shareShot('rate-limited');
    assert.equal(shareServer.shares.size, 0);
  }
  await uploadButton.click();
  const linkField = shareDialog.getByLabel('Link', { exact: true });
  await linkField.waitFor();
  const sharedUrl = await linkField.inputValue();
  const shareId = /\/w\/([A-Za-z0-9_-]{32})$/.exec(sharedUrl)?.[1];
  assert.ok(shareId, sharedUrl);
  assert.equal(sharedUrl, `${shareServer.origin}/w/${shareId}`);
  if (shareServer.fake) assert.equal(shareServer.shares.size, 1);
  const served = await readSharedBundle(shareId);
  assert.equal(served.status, 200);
  assert.ok(served.expiresAt);
  const uploaded = { bundle: served.bundle };
  assert.deepEqual(
    {
      version: uploaded.bundle.version,
      name: uploaded.bundle.name,
      workflow: uploaded.bundle.workflow,
      app: uploaded.bundle.createdWith.app,
    },
    {
      version: 1,
      name: 'smoke',
      workflow: { fileName: 'smoke.md', content: sharedWorkflow },
      app: 'nesvo',
    },
  );
  assert.ok(
    uploaded.bundle.steps.some(step => step.fileName === 'smoke-check.md'),
  );
  for (const step of uploaded.bundle.steps)
    assert.equal(
      step.content,
      await readFile(join(workflowRoot, 'steps', step.fileName), 'utf8'),
    );
  await shareDialog.getByText(/^Expires /).waitFor();
  await shareShot('link');
  await shareDialog.getByRole('button', { name: 'Done', exact: true }).click();
  await shareDialog.waitFor({ state: 'hidden' });
  const storedSharing = JSON.parse(
    await readFile(join(directory, 'sharing.json'), 'utf8'),
  );
  uploaded.revokeToken = storedSharing.links[0].revokeToken;
  assert.match(uploaded.revokeToken, /^[A-Za-z0-9_-]{43}$/);
  if (shareServer.fake)
    assert.equal(
      shareServer.shares.get(shareId).revokeToken,
      uploaded.revokeToken,
    );
  let importLink = `nesvo://import-workflow?share=${shareId}&origin=${encodeURIComponent(shareServer.origin)}`;
  if (!shareServer.fake) {
    const browser = await chromium.launch();
    try {
      const sharePage = await browser.newPage({
        viewport: { width: 1280, height: 860 },
        colorScheme: 'dark',
      });
      await sharePage.goto(sharedUrl);
      await sharePage
        .getByText('smoke-check', { exact: false })
        .first()
        .waitFor();
      importLink = await sharePage
        .getByRole('link', { name: 'Open in Nesvo', exact: true })
        .getAttribute('href');
      if (process.env.NESVO_SHARE_SCREENSHOT_DIR)
        await sharePage.screenshot({
          path: join(
            process.env.NESVO_SHARE_SCREENSHOT_DIR,
            'share-e2e-web-page.png',
          ),
          fullPage: true,
        });
    } finally {
      await browser.close();
    }
  }
  const linkList = await restartedPage.evaluate(() =>
    window.nesvo.sharing.links(),
  );
  assert.equal(linkList.length, 1);
  assert.equal('revokeToken' in linkList[0], false);

  await deliverLink(
    `nesvo://import-workflow?share=${shareId}&origin=${encodeURIComponent('https://evil.example')}`,
  );
  const refusedDialog = restartedPage.getByRole('dialog', {
    name: 'This link could not be opened',
    exact: true,
  });
  await refusedDialog.getByText(/not your configured share site/).waitFor();
  await shareShot('refused');
  await refusedDialog
    .getByRole('button', { name: 'Close', exact: true })
    .first()
    .click();
  await refusedDialog.waitFor({ state: 'hidden' });

  if (shareServer.fake) {
    await deliverLink(
      `nesvo://import-workflow?share=${EXPIRED_SHARE_ID}&origin=${encodeURIComponent(shareServer.origin)}`,
    );
    await refusedDialog.getByText(/link has expired/).waitFor();
    await refusedDialog
      .getByRole('button', { name: 'Close', exact: true })
      .first()
      .click();
    await refusedDialog.waitFor({ state: 'hidden' });
  }

  const shareTarget = join(directory, 'share-target');
  await mkdir(join(shareTarget, '.git'), { recursive: true });
  await application.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, shareTarget);
  await deliverLink(importLink);
  const importDialog = restartedPage.getByRole('dialog', {
    name: 'Import smoke',
    exact: true,
  });
  await importDialog.waitFor();
  await importDialog.getByText('echo ok', { exact: false }).first().waitFor();
  await importDialog.getByText(/run on your computer/).waitFor();
  await importDialog
    .getByText(/Expires /)
    .first()
    .waitFor();
  await importDialog.getByRole('combobox', { name: 'Saved in' }).click();
  await restartedPage
    .getByRole('option', { name: 'Choose a folder…', exact: true })
    .click();
  await importDialog
    .getByRole('combobox', { name: 'Saved in' })
    .filter({ hasText: 'share-target' })
    .waitFor();
  await importDialog.getByText('New', { exact: true }).first().waitFor();
  await shareShot('import');
  await importDialog
    .getByRole('button', { name: 'Save workflow', exact: true })
    .click();
  await importDialog.waitFor({ state: 'hidden' });
  await editor.waitFor();
  assert.equal(
    await editor.getByRole('textbox', { name: 'Workflow name' }).inputValue(),
    'smoke',
  );
  const importedRoot = join(shareTarget, '.agents', 'workflows');
  assert.equal(
    await readFile(join(importedRoot, 'workflows', 'smoke.md'), 'utf8'),
    sharedWorkflow,
  );
  assert.equal(
    await readFile(join(importedRoot, 'steps', 'smoke-check.md'), 'utf8'),
    sharedStep,
  );
  await editor.locator('[data-editor-node="smoke-check"]').waitFor();
  await shareShot('imported-editor');
  assert.equal(
    (await fullSessions(restartedPage)).some(session =>
      session.directory.startsWith(shareTarget),
    ),
    false,
    'Importing starts nothing',
  );
  await editor
    .getByRole('button', { name: 'Close graph editor', exact: true })
    .click();

  await restartedPage
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  const shareSettings = restartedPage.getByRole('dialog', {
    name: 'Settings',
    exact: true,
  });
  await shareSettings
    .getByRole('button', { name: 'Sharing', exact: true })
    .click();
  const sharingPage = shareSettings.getByRole('region', {
    name: 'Sharing',
    exact: true,
  });
  await sharingPage.getByText(sharedUrl, { exact: true }).waitFor();
  await shareShot('settings');
  await sharingPage
    .getByRole('button', { name: 'Revoke', exact: true })
    .click();
  await restartedPage
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Revoke link', exact: true })
    .click();
  await sharingPage.getByText('No shared links', { exact: true }).waitFor();
  await shareShot('revoked');
  assert.equal((await readSharedBundle(shareId)).status, 404);
  if (shareServer.fake) {
    assert.equal(shareServer.shares.size, 0);
    assert.deepEqual(
      shareServer.requests
        .filter(item => item.method === 'DELETE')
        .map(item => [item.path, item.authorization]),
      [[`/api/shares/${shareId}`, `Bearer ${uploaded.revokeToken}`]],
    );
  }
  await restartedPage.keyboard.press('Escape');
  await shareSettings.waitFor({ state: 'hidden' });
  await restartedPage
    .getByRole('button', { name: 'Workflows', exact: true })
    .click();
  await workflowsView.waitFor();
  await workflowsView
    .getByLabel('Project folder', { exact: true })
    .fill(workflowProject);
  await workflowsView
    .getByRole('button', { name: 'Read', exact: true })
    .click();
  console.log(
    JSON.stringify({
      workflowSharing: {
        shareId,
        uploadedSteps: uploaded.bundle.steps.length,
        imported: 'smoke',
        revoked: true,
      },
    }),
  );
  console.log(
    JSON.stringify({
      graphEditor: {
        steps: savedGraph.steps.map(step => step.name),
        edges: savedGraph.graph.edges.length,
        layoutKeys: Object.keys(savedGraph.layout).length,
      },
    }),
  );
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1280, 900),
  );
  const automationShell = restartedPage.getByRole('navigation', {
    name: 'Primary',
    exact: true,
  });
  await automationShell
    .getByRole('button', { name: 'Automations', exact: true })
    .click();
  await restartedPage
    .getByRole('button', { name: 'New automation' })
    .first()
    .click();
  const automationEditor = restartedPage.locator('[data-automation-editor]');
  assert.equal(await automationEditor.getAttribute('data-placement'), 'center');
  const selectRitual = async name => {
    await automationEditor
      .getByRole('combobox', { name: 'Starter template' })
      .click();
    await restartedPage.getByRole('option', { name, exact: true }).click();
    await automationEditor.getByText('Templates start paused.').waitFor();
    assert.equal(
      await automationEditor
        .getByRole('switch', { name: 'Active', exact: true })
        .getAttribute('aria-checked'),
      'false',
    );
  };
  const ritualShot = async name => {
    const folder = process.env.NESVO_RITUALS_SCREENSHOT_DIR;
    if (!folder) return;
    await restartedPage
      .locator('[data-slot="select-content"]')
      .waitFor({ state: 'detached' });
    await restartedPage.evaluate(
      () =>
        new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const encoded = await application.evaluate(async ({ BrowserWindow }) => {
      const image =
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(
          undefined,
          { stayHidden: true, stayAwake: true },
        );
      return image.toPNG().toString('base64');
    });
    await writeFile(
      join(folder, `rituals-${name}.png`),
      Buffer.from(encoded, 'base64'),
    );
  };
  await selectRitual('Daily error triage');
  assert.equal(
    await automationEditor
      .getByRole('switch', { name: 'Use browser' })
      .getAttribute('aria-checked'),
    'true',
  );
  await ritualShot('browser-template');
  await selectRitual('Dependency update maintenance');
  assert.equal(
    await automationEditor
      .getByRole('switch', { name: 'Edit files in a worktree' })
      .getAttribute('aria-checked'),
    'true',
  );
  await ritualShot('writable-template');
  await automationEditor
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await restartedPage
    .getByRole('button', { name: 'New automation' })
    .first()
    .click();
  await automationEditor.getByLabel('Name').fill('Smoke automation');
  const automationPrompt = automationEditor.getByLabel('Prompt');
  assert.equal(
    await automationPrompt.evaluate(
      element => getComputedStyle(element).resize,
    ),
    'none',
  );
  await automationPrompt.fill('/');
  const automationSkill = restartedPage.getByRole('option', {
    name: 'Fixture Codex instructions',
    exact: true,
  });
  await automationSkill.waitFor();
  assert.equal(
    await automationEditor
      .getByRole('button', { name: 'Create', exact: true })
      .isDisabled(),
    true,
  );
  await automationSkill.click();
  await automationEditor
    .getByLabel('Selected skill: Fixture Codex instructions')
    .waitFor();
  await automationPrompt.fill('Summarize the fixture folder.');
  await automationEditor.getByRole('radio', { name: 'Daily' }).click();
  const automationClock = new Date();
  const automationTime = `${String((automationClock.getHours() + 21) % 24).padStart(2, '0')}:00`;
  await automationEditor
    .getByLabel('Time', { exact: true })
    .fill(automationTime);
  await automationEditor
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await automationEditor.waitFor({ state: 'hidden' });
  await restartedPage
    .getByRole('region', { name: 'Automation: Smoke automation' })
    .waitFor();
  await automationShell
    .getByRole('button', { name: 'Automations', exact: true })
    .click();
  const automationRow = restartedPage
    .locator('[data-automation-id]')
    .filter({ hasText: 'Smoke automation' });
  await automationRow.hover();
  await automationRow
    .getByRole('button', { name: 'Run Smoke automation now' })
    .click();
  await automationRow.getByText('Completed', { exact: true }).waitFor({
    timeout: 20000,
  });
  await automationRow
    .getByRole('button', { name: 'Open automation: Smoke automation' })
    .click();
  await restartedPage
    .locator('[data-run-status="completed"]')
    .getByText('Done', { exact: true })
    .waitFor();
  const automationShot = async (target, name) => {
    if (!process.env.NESVO_SCREENSHOT) return;
    for (const scheme of ['dark', 'light']) {
      await target.evaluate(
        value => window.nesvo.setColorScheme(value),
        scheme,
      );
      await target.evaluate(
        () =>
          new Promise(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const encoded = await application.evaluate(async ({ BrowserWindow }) => {
        const image =
          await BrowserWindow.getAllWindows()[0].webContents.capturePage(
            undefined,
            { stayHidden: true, stayAwake: true },
          );
        return image.toPNG().toString('base64');
      });
      await writeFile(
        process.env.NESVO_SCREENSHOT.replace(
          /\.png$/,
          `-automations-${name}-${scheme}.png`,
        ),
        Buffer.from(encoded, 'base64'),
      );
    }
    await target.evaluate(() => window.nesvo.setColorScheme('dark'));
  };
  const automationResult = () =>
    restartedPage
      .getByRole('article')
      .filter({ hasText: 'Automation · Smoke automation' });
  await automationShell
    .getByRole('button', { name: 'Inbox', exact: true })
    .click();
  await automationResult().waitFor({ state: 'hidden' });
  const [smokeAutomation] = await restartedPage.evaluate(() =>
    window.nesvo.scheduledJobs.list('local'),
  );
  const smokeRuns = await restartedPage.evaluate(
    id => window.nesvo.scheduledJobs.listRuns('local', id, null),
    smokeAutomation.id,
  );
  assert.equal(smokeRuns.runs.length, 1);
  assert.equal(smokeRuns.runs[0].status, 'completed');
  assert.equal(smokeRuns.runs[0].trigger, 'manual');
  assert.ok(smokeRuns.runs[0].reviewId);
  const automationSession = (
    await restartedPage.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === smokeRuns.runs[0].sessionId);
  assert.match(automationSession.title, /^Smoke automation · /);
  assert.equal(automationSession.scheduledJobId, smokeAutomation.id);
  assert.equal(automationSession.messages.at(-1).outcome.kind, 'done');
  const openAutomationDetail = async () => {
    await automationShell
      .getByRole('button', { name: 'Automations', exact: true })
      .click();
    await restartedPage
      .locator('[data-automation-id]')
      .filter({ hasText: 'Smoke automation' })
      .getByRole('button', { name: 'Open automation: Smoke automation' })
      .click();
    return restartedPage.getByRole('region', {
      name: 'Automation: Smoke automation',
    });
  };
  const automationDetail = await openAutomationDetail();
  await automationDetail
    .locator('[data-run-status="completed"]')
    .getByText('Done', { exact: true })
    .waitFor();
  const savedReviews = await restartedPage.evaluate(() =>
    window.nesvo.listReviews(),
  );
  const savedReview = savedReviews.find(
    review => review.id === smokeRuns.runs[0].reviewId,
  );
  assert.equal(savedReview.status, 'done');
  await automationShot(restartedPage, 'detail-completed');
  await automationDetail
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await restartedPage.locator('[data-automation-editor]').waitFor();
  await automationShot(restartedPage, 'editor');
  await restartedPage.keyboard.press('Escape');
  await restartedPage
    .locator('[data-automation-editor]')
    .waitFor({ state: 'hidden' });
  await automationShell
    .getByRole('button', { name: 'Automations', exact: true })
    .click();
  await automationShot(restartedPage, 'list');
  const smokeDatabase = join(directory, 'host', 'nesvo.sqlite');
  const readAutomationRow = () => {
    const database = new DatabaseSync(smokeDatabase, { readOnly: true });
    try {
      return {
        ...database
          .prepare(
            'SELECT next_run_at AS nextRunAt FROM scheduled_jobs WHERE id = ?',
          )
          .get(smokeAutomation.id),
      };
    } finally {
      database.close();
    }
  };
  const seedNextRunAt = (nextRunAt, id = smokeAutomation.id) => {
    const database = new DatabaseSync(smokeDatabase);
    try {
      database
        .prepare('UPDATE scheduled_jobs SET next_run_at = ? WHERE id = ?')
        .run(nextRunAt, id);
    } finally {
      database.close();
    }
  };
  const restartApplication = async () => {
    assert.deepEqual(errors, []);
    await application.close();
    application = undefined;
    await Promise.all([...providerPids, hostPid].map(waitDead));
    hostPid = undefined;
  };
  const relaunchApplication = async () => {
    application = await launchApplication();
    const relaunched = await application.firstWindow();
    relaunched.setDefaultTimeout(20000);
    relaunched.on('pageerror', error => errors.push(error.message));
    await relaunched.emulateMedia({ reducedMotion: 'reduce' });
    hostPid = JSON.parse(await readFile(pidFile, 'utf8')).host;
    assert.equal(typeof hostPid, 'number');
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1280, 900),
    );
    return relaunched;
  };
  const listAutomationState = relaunched =>
    relaunched.evaluate(
      async id => ({
        runs: (await window.nesvo.scheduledJobs.listRuns('local', id, null))
          .runs,
        sessions: await window.nesvo.listSessions(),
        reviews: await window.nesvo.listReviews(),
      }),
      smokeAutomation.id,
    );
  const beforeMissed = await listAutomationState(restartedPage);
  await restartApplication();
  const upcomingOccurrence = Date.parse(readAutomationRow().nextRunAt);
  assert.ok(upcomingOccurrence > Date.now());
  const missedFrom = new Date(upcomingOccurrence);
  missedFrom.setDate(missedFrom.getDate() - 2);
  seedNextRunAt(missedFrom.toISOString());
  const missedPage = await relaunchApplication();
  await missedPage
    .getByRole('button', { name: 'Automations', exact: true })
    .click();
  await missedPage
    .locator('[data-automation-id]')
    .filter({ hasText: 'Smoke automation' })
    .getByRole('button', { name: 'Open automation: Smoke automation' })
    .click();
  const missedDetail = missedPage.getByRole('region', {
    name: 'Automation: Smoke automation',
  });
  await missedDetail
    .locator('[data-run-status="skipped"]')
    .getByText('Skipped · 2 missed', { exact: true })
    .waitFor();
  const afterMissed = await listAutomationState(missedPage);
  assert.equal(afterMissed.runs.length, beforeMissed.runs.length + 1);
  const missedRun = afterMissed.runs.find(run => run.status === 'skipped');
  assert.deepEqual(
    [
      missedRun.trigger,
      missedRun.reason,
      missedRun.missedCount,
      missedRun.sessionId,
    ],
    ['schedule', 'missed', 2, null],
  );
  assert.deepEqual(
    afterMissed.sessions.map(session => session.id).toSorted(),
    beforeMissed.sessions.map(session => session.id).toSorted(),
  );
  assert.deepEqual(
    afterMissed.reviews.map(review => review.id).toSorted(),
    beforeMissed.reviews.map(review => review.id).toSorted(),
  );
  assert.ok(Date.parse(readAutomationRow().nextRunAt) > Date.now());
  await automationShot(missedPage, 'detail-skipped');
  console.log(
    JSON.stringify({
      automations: {
        name: smokeAutomation.name,
        schedule: smokeAutomation.schedule,
        run: smokeRuns.runs[0].status,
        savedResult: savedReview.status,
        missed: [missedRun.status, missedRun.missedCount],
      },
    }),
  );
  await restartApplication();
  await writeFile(usageControl, JSON.stringify({ 'Claude Code': 'exhausted' }));
  seedNextRunAt(new Date(Date.now() - 10_000).toISOString());
  const limitedPage = await relaunchApplication();
  await limitedPage
    .getByRole('navigation', { name: 'Primary', exact: true })
    .getByRole('button', { name: 'Automations', exact: true })
    .click();
  await limitedPage
    .locator('[data-automation-id]')
    .filter({ hasText: 'Smoke automation' })
    .getByRole('button', { name: 'Open automation: Smoke automation' })
    .click();
  await limitedPage
    .locator('[data-run-status="unavailable"]')
    .getByText(/^Unavailable · limit until \d\d:\d\d$/)
    .waitFor();
  const afterLimit = await listAutomationState(limitedPage);
  assert.equal(afterLimit.runs.length, afterMissed.runs.length + 1);
  const limitedRun = afterLimit.runs.find(run => run.status === 'unavailable');
  assert.deepEqual(
    [
      limitedRun.trigger,
      limitedRun.reason,
      limitedRun.sessionId,
      limitedRun.reviewId,
    ],
    ['schedule', 'limit', null, null],
  );
  assert.ok(Date.parse(limitedRun.resetAt) > Date.now());
  assert.deepEqual(
    afterLimit.sessions.map(session => session.id).toSorted(),
    beforeMissed.sessions.map(session => session.id).toSorted(),
  );
  assert.deepEqual(
    afterLimit.reviews.map(review => review.id).toSorted(),
    beforeMissed.reviews.map(review => review.id).toSorted(),
  );
  await automationShot(limitedPage, 'detail-limit');
  await refuseSecondInstance();
  assert.equal(
    (await listAutomationState(limitedPage)).runs.length,
    afterLimit.runs.length,
  );
  console.log(
    JSON.stringify({
      automationLimit: { status: limitedRun.status, reason: limitedRun.reason },
    }),
  );
  const savedWindowState = JSON.parse(
    await readFile(join(directory, 'window-state.json'), 'utf8'),
  );
  assert.deepEqual(
    [savedWindowState.width, savedWindowState.height],
    [1280, 900],
  );
  const beforeHostCrash = await listAutomationState(limitedPage);
  const crashedHostPid = hostPid;
  process.kill(crashedHostPid);
  await waitDead(crashedHostPid);
  let restartedLocal;
  for (let attempt = 0; attempt < 300; attempt++) {
    restartedLocal = (
      await limitedPage.evaluate(() => window.nesvo.listComputers())
    ).find(computer => computer.id === 'local');
    hostPid = JSON.parse(await readFile(pidFile, 'utf8')).host;
    if (restartedLocal.status === 'connected' && hostPid !== crashedHostPid)
      break;
    await delay(100);
  }
  assert.equal(restartedLocal.status, 'connected');
  assert.notEqual(hostPid, crashedHostPid);
  const afterHostCrash = await listAutomationState(limitedPage);
  assert.deepEqual(
    afterHostCrash.sessions.map(session => session.id).toSorted(),
    beforeHostCrash.sessions.map(session => session.id).toSorted(),
  );
  assert.equal(afterHostCrash.runs.length, beforeHostCrash.runs.length);
  const mainLog = await readFile(join(directory, 'logs', 'main.log'), 'utf8');
  assert.match(mainLog, /The local host exited/);
  assert.match(mainLog, /Reconnecting Local in 1000 ms/);
  console.log(
    JSON.stringify({
      localHostRestart: { crashedHostPid, restartedHostPid: hostPid },
    }),
  );
  const checkFolder = join(directory, 'change-check');
  await mkdir(checkFolder);
  const checkSource = join(checkFolder, 'source.txt');
  await writeFile(checkSource, 'baseline');
  await writeFile(
    join(checkFolder, 'check.cjs'),
    "process.stdout.write(require('node:fs').readFileSync('source.txt'));",
  );
  await writeFile(usageControl, '{}');
  await limitedPage
    .getByRole('navigation', { name: 'Primary', exact: true })
    .getByRole('button', { name: 'Automations', exact: true })
    .click();
  await limitedPage
    .getByRole('button', { name: 'New automation' })
    .first()
    .click();
  const changeEditor = limitedPage.locator('[data-automation-editor]');
  await changeEditor.getByLabel('Name').fill('Smoke change trigger');
  await changeEditor.getByLabel('Prompt').fill('Summarize the fixture folder.');
  await changeEditor
    .getByRole('button', { name: 'Location', exact: true })
    .click();
  const checkLocation = limitedPage.getByRole('textbox', {
    name: 'Working directory',
  });
  await checkLocation.fill(checkFolder);
  await checkLocation.press('Enter');
  await changeEditor
    .getByRole('switch', { name: 'Run only when this changes' })
    .click();
  assert.equal(
    await changeEditor
      .getByRole('switch', { name: 'Ask before starting' })
      .isChecked(),
    true,
  );
  await changeEditor
    .getByLabel('Check command')
    .fill(JSON.stringify([process.execPath, 'check.cjs']));
  await changeEditor.getByLabel('Daily run cap').fill('1');
  await changeEditor
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await changeEditor.waitFor({ state: 'hidden' });
  const changedJobId = await limitedPage.evaluate(
    async () =>
      (await window.nesvo.scheduledJobs.list('local')).find(
        job => job.name === 'Smoke change trigger',
      )?.id,
  );
  assert.ok(changedJobId);
  await restartApplication();
  seedNextRunAt(new Date(Date.now() - 10000).toISOString(), changedJobId);
  const baselinePage = await relaunchApplication();
  await baselinePage.getByText('Baseline saved.', { exact: true }).waitFor();
  await restartApplication();
  await writeFile(checkSource, 'changed');
  seedNextRunAt(new Date(Date.now() - 10000).toISOString(), changedJobId);
  const changePage = await relaunchApplication();
  await changePage.getByRole('button', { name: 'Inbox', exact: true }).click();
  const startRequest = changePage.getByRole('article', {
    name: 'Automation start: Smoke change trigger',
  });
  await startRequest.waitFor();
  const beforeStart = await changePage.evaluate(
    id => window.nesvo.scheduledJobs.listRuns('local', id, null),
    changedJobId,
  );
  assert.deepEqual(beforeStart.runs, []);
  await automationShot(changePage, 'change-start');
  await startRequest
    .getByRole('button', { name: 'Start', exact: true })
    .click();
  await startRequest.waitFor({ state: 'hidden' });
  const changeResultDeadline = Date.now() + 20_000;
  let changeResultSaved = false;
  while (Date.now() < changeResultDeadline && !changeResultSaved) {
    changeResultSaved = await changePage.evaluate(async id => {
      const [run] = (
        await window.nesvo.scheduledJobs.listRuns('local', id, null)
      ).runs;
      return (
        run?.status === 'completed' &&
        (await window.nesvo.listReviews()).some(
          review => review.id === run.reviewId && review.status === 'done',
        )
      );
    }, changedJobId);
    if (!changeResultSaved) await delay(50);
  }
  assert.ok(
    changeResultSaved,
    'The approved automation did not save its Done result',
  );
  assert.equal(
    await changePage
      .getByRole('article')
      .filter({ hasText: 'Automation · Smoke change trigger' })
      .count(),
    0,
  );
  console.log(
    JSON.stringify({ automationChangeTrigger: 'approved and saved as Done' }),
  );
  await smokeGateRuleFlow({
    application,
    page: changePage,
    directory,
    shots: process.env.NESVO_GATE_RULE_SCREENSHOT_DIR,
  });
  await changePage
    .getByRole('button', { name: 'Close graph editor', exact: true })
    .click();
  await smokePortableCheck({
    application,
    page: changePage,
    directory,
    home: env.NESVO_WORKFLOWS_HOME,
  });
  await smokeConfigurationInbox(application, changePage);
  await smokeConfigurationProfile(application, changePage);
  assert.deepEqual(errors, []);
  await application.close();
  application = undefined;
  await waitDead(hostPid);
  hostPid = undefined;
  const commands = (await readFile(env.NESVO_TEST_COMMAND_LOG, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.ok(commands.length > 0);
  assert.ok(commands.every(command => command.forbidden === false));
  console.log(
    JSON.stringify({
      result: 'passed',
      provider: 'Claude Code and Codex delegation fixtures',
      platform: process.platform,
      electron: versions.electron,
      node: versions.node,
      hostPid: closedHostPid,
    }),
  );
}

try {
  await smokeDesktop();
} catch (error) {
  smokeFailure = error;
  const failurePage = application?.windows()[0];
  if (failurePage) {
    const state = await failurePage
      .evaluate(async () => ({
        sessions: (await window.nesvo.listSessions()).map(session => ({
          id: session.id,
          title: session.title,
          providerSessionId: session.providerSessionId,
          runId: session.runId,
          status: session.status,
          error: session.error,
          messages: session.messages.slice(-2).map(message => ({
            author: message.author,
            state: message.state,
            body: message.body.slice(0, 500),
            skill: message.skill,
          })),
        })),
        location: localStorage.getItem('nesvo.workspace-location.v1'),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(
          node => node.textContent,
        ),
      }))
      .catch(() => null);
    const log = await readFile(
      join(directory, 'logs', 'main.log'),
      'utf8',
    ).catch(() => '');
    const rendererErrors = log
      .split('\n')
      .filter(line => / ERROR Window /.test(line))
      .slice(-5);
    console.error(JSON.stringify({ desktopFailure: state, rendererErrors }));
  }
  throw error;
} finally {
  try {
    await shareServer.close();
    await application?.close();
    if (hostPid) await waitDead(hostPid);
    await Promise.all([...providerPids].map(waitDead));
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } catch (cleanupError) {
    if (!smokeFailure) throw cleanupError;
    console.error(
      JSON.stringify({
        cleanupFailure: String(cleanupError?.message ?? cleanupError),
      }),
    );
  }
}
