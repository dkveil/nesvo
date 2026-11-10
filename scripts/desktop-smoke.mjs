import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';

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
const executablePath =
  process.env.NESVO_PACKAGED_EXECUTABLE || requireDesktop('electron');
const env = {
  ...process.env,
  NESVO_SMOKE_TEST: '1',
  NESVO_DATA_DIR: directory,
  NESVO_TEST_PID_FILE: pidFile,
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
};
delete env.ELECTRON_RUN_AS_NODE;
let application;
let hostPid;
const byId = values =>
  values.toSorted((left, right) => left.id.localeCompare(right.id));
const launchArgs = process.env.NESVO_PACKAGED_EXECUTABLE
  ? []
  : [resolve('apps/desktop')];
const launchApplication = () =>
  electron.launch({
    executablePath,
    args: launchArgs,
    env,
    timeout: 30000,
  });
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
try {
  await writeFile(usageControl, '{}');
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
  application = await launchApplication();
  const page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
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
    await page.getByRole('button', { name: /^Inbox/ }).click();
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
    if (!process.env.NESVO_SCREENSHOT) return;
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
      process.env.NESVO_SCREENSHOT.replace(/\.png$/, suffix + '.png'),
      Buffer.from(encoded, 'base64'),
    );
  };
  const waitState = async (id, status) => {
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
      if (session?.status === status) return session;
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
  const waitReview = async (sessionId, afterVersion = 0) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const reviews = await page.evaluate(() => window.nesvo.listReviews());
      const review = reviews.find(
        review =>
          review.sessionId === sessionId &&
          review.version > afterVersion &&
          review.status === 'pending',
      );
      if (review) return review;
      await delay(100);
    }
    assert.fail(
      `No pending review for session ${sessionId} after version ${afterVersion}`,
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
      const bars = section.getByRole('progressbar');
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
  const threadDetailsToggle = page.getByRole('button', {
    name: 'Thread details',
    exact: true,
  });
  await threadDetailsToggle.click();
  const threadDetails = page.getByRole('complementary', {
    name: 'Thread details',
    exact: true,
  });
  assert.equal(
    await threadDetails
      .locator('[data-provider-indicator="Claude Code"]')
      .getAttribute('aria-label'),
    'Claude Code limits: Weekly, 38.8% remaining',
  );
  assert.equal(
    await threadDetails.locator('[data-provider-indicator]').count(),
    2,
  );
  await threadDetailsToggle.click();
  await threadDetails.waitFor({ state: 'hidden' });
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
    .getByText(/without a reasoning effort setting/)
    .waitFor();
  assert.equal(
    await claudeReasoning.getAttribute('data-effort-support'),
    'unsupported',
  );
  assert.equal(await claudeReasoning.getByRole('button').count(), 0);
  await modelSearch.press('Escape');
  await modelPicker.waitFor({ state: 'hidden' });
  await waitForFocus(modelChip);
  await modelChip.click();
  await modelSearch.fill('son');
  await modelSearch.press('ArrowDown');
  await modelSearch.press('Enter');
  await modelPicker.waitFor({ state: 'hidden' });
  assert.equal(await modelChip.getAttribute('title'), 'Claude Code · Sonnet');
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
  assert.deepEqual(await readSkillsTrace(), []);
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
  await page.getByRole('button', { name: 'Choose skill', exact: true }).click();
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
  await waitReview(first.id);
  const beforeDuplicate = await page.evaluate(async () => ({
    sessions: await window.nesvo.listSessions(),
    reviews: await window.nesvo.listReviews(),
  }));
  const firstStatePath = join(
    firstCompleted.directory,
    `.nesvo-fixture-${firstCompleted.providerSessionId}.json`,
  );
  const firstTurnState = await readFile(firstStatePath, 'utf8');
  const originalPidFile = await readFile(pidFile, 'utf8');
  const duplicateApp = spawn(
    executablePath,
    process.platform === 'linux' ? ['--no-sandbox', ...launchArgs] : launchArgs,
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
  assert.equal(await newThread.locator('[data-branch-kind]').count(), 0);
  await chooseLocation(directory);
  await newThread
    .locator('[data-thread-project]', { hasText: /^nesvo-desktop-/ })
    .waitFor();
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
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .inputValue(),
    'First session draft',
  );
  await page.reload();
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await message('Fixture streamed reply.').waitFor();
  await sharedInstructionsBadge.waitFor();
  await page.getByRole('button', { name: 'Choose skill', exact: true }).click();
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
  await newThread
    .getByRole('button', { name: 'Permissions', exact: true })
    .click();
  assert.equal(
    await permissionsPicker
      .getByRole('radio', { name: 'Workspace edits', exact: true })
      .getAttribute('aria-disabled'),
    'true',
  );
  await permissionsPicker
    .getByText('Claude runs read-only analysis in Nesvo', { exact: false })
    .waitFor();
  assert.equal(
    await permissionsPicker
      .getByRole('radio', { name: /auto|full access/i })
      .count(),
    0,
  );
  await page.keyboard.press('Escape');
  await permissionsPicker.waitFor({ state: 'hidden' });
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
    await messageEditor.inputValue(),
    '/fixture-claude-instructions',
  );
  await messageEditor.fill('');
  await page.getByRole('button', { name: 'Choose skill', exact: true }).click();
  await projectSkillOption.waitFor();
  assert.equal(
    await skillPicker
      .getByRole('option', { name: 'Fixture user skill', exact: true })
      .getAttribute('aria-disabled'),
    'true',
  );
  await page
    .getByRole('textbox', { name: 'Filter skills', exact: true })
    .fill('fixture-claude-instructions');
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
  await navigation.getByRole('button', { name: /^Prototype analysis/ }).click();
  await page
    .getByRole('heading', { name: 'Prototype analysis', exact: true, level: 1 })
    .waitFor();
  const unrelatedBeforeApproval = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === first.id);
  await openInbox();
  const operationRow = page.getByRole('article', {
    name: `Operation approval: ${codex.title}`,
    exact: true,
  });
  await operationRow.getByText(/fixture write approved marker/).waitFor();
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
  const restoredActivitySession = (
    await page.evaluate(() => window.nesvo.listSessions())
  ).find(session => session.id === codex.id);
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
  await page.getByRole('button', { name: 'Choose skill', exact: true }).click();
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
  await message('Codex fixture initial reply.').waitFor();
  await waitState(orchestrator.id, 'completed');
  const proposal = title =>
    page
      .getByRole('region', { name: 'Worker proposal', exact: true })
      .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
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
    .getByRole('button', { name: 'Open worker session', exact: true })
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
  await proposal('Fixture worker A')
    .getByRole('button', { name: 'Open worker session', exact: true })
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
  const introReview = await waitReview(writingSession.id);
  await send('fixture:review-write');
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
  const reviewPanel = review => conversation.locator(`#review-${review.id}`);
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
    const opener = reviewPanel(review).getByRole('button', {
      name: `View diff for version ${review.version}`,
      exact: true,
    });
    await opener.click();
    return { opener, patch: await checkSavedDiff(review, before, after) };
  };
  const closeSavedDiff = async opener => {
    await page.keyboard.press('Escape');
    await diffPanel.waitFor({ state: 'hidden' });
    await waitForFocus(opener);
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
    await conversation.locator(`#review-${review.id}[open]`).waitFor();
    assert.notEqual(await reviewPanel(review).getAttribute('open'), null);
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
  await closeSavedDiff(initialDiff.opener);
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
  if ((await reviewPanel(initialReview).getAttribute('open')) === null) {
    await reviewPanel(initialReview)
      .getByLabel(`Open version ${initialReview.version}`, { exact: true })
      .click();
    await conversation.locator(`#review-${initialReview.id}[open]`).waitFor();
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
  await closeSavedDiff(historicalDiff.opener);
  const correctedDiff = await openSavedDiff(
    correctedReview,
    'initial agent text',
    'corrected agent text',
  );
  await screenshot('-correction');
  await closeSavedDiff(correctedDiff.opener);
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
  await page.getByRole('combobox', { name: 'View', exact: true }).click();
  await page.getByRole('option', { name: 'History', exact: true }).click();
  await reviewRow(correctedReview)
    .getByText(`Result · v${correctedReview.version} · Accepted`, {
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
  if ((await reviewPanel(initialReview).getAttribute('open')) === null) {
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
    .getByRole('textbox', { name: 'Search sessions' })
    .fill('nonexistent session');
  await page.getByText('No matching sessions.').waitFor();
  await page.getByRole('textbox', { name: 'Search sessions' }).fill('');
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
  const sidebarToggle = page.getByRole('button', {
    name: 'Toggle sidebar',
    exact: true,
  });
  await sidebarToggle.click();
  await navigation.waitFor({ state: 'hidden' });
  assert.equal(await sidebarToggle.getAttribute('aria-pressed'), 'false');
  await waitForFocus(sidebarToggle);
  await page.keyboard.press('Control+b');
  await navigation.waitFor({ state: 'visible' });
  assert.equal(await sidebarToggle.getAttribute('aria-pressed'), 'true');
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
  await details.getByText(directory, { exact: true }).waitFor();
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
  if ((await reviewPanel(correctedReview).getAttribute('open')) === null) {
    await reviewPanel(correctedReview)
      .getByLabel(`Open version ${correctedReview.version}`, { exact: true })
      .click();
  }
  const compactDiff = await openSavedDiff(
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
  await closeSavedDiff(compactDiff.opener);
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
  if ((await reviewPanel(initialReview).getAttribute('open')) === null)
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
  for (const trace of await readUsageTrace()) {
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
  await restartedPage.keyboard.press('Escape');
  await restartedDiff.waitFor({ state: 'hidden' });
  await restartedPage.getByRole('button', { name: /^Inbox/ }).click();
  const restartedInbox = restartedPage.getByRole('region', {
    name: 'Inbox',
    exact: true,
  });
  await restartedInbox.waitFor();
  await restartedPage
    .getByRole('combobox', { name: 'View', exact: true })
    .click();
  await restartedPage
    .getByRole('option', { name: 'Pending', exact: true })
    .click();
  await restartedInbox
    .getByRole('article', {
      name: `Review result: ${pendingResult.title}, version ${pendingResult.version}`,
      exact: true,
    })
    .filter({ hasText: pendingResult.summary })
    .waitFor();
  await restartedPage
    .getByRole('combobox', { name: 'View', exact: true })
    .click();
  await restartedPage
    .getByRole('option', { name: 'History', exact: true })
    .click();
  const restartedAccepted = restartedInbox.getByRole('article', {
    name: `Review result: ${correctedReview.title}, version ${correctedReview.version}`,
    exact: true,
  });
  await restartedAccepted
    .getByText(`Result · v${correctedReview.version} · Accepted`, {
      exact: true,
    })
    .waitFor();
  await restartedAccepted
    .getByRole('button', {
      name: `Open session: ${writingSession.title}`,
      exact: true,
    })
    .click();
  await restartedPage.locator(`#review-${correctedReview.id}[open]`).waitFor();
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
    .getByRole('button', { name: 'Continue conversation', exact: true })
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
  assert.deepEqual(errors, []);
  await application.close();
  application = undefined;
  await waitDead(hostPid);
  hostPid = undefined;
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
} catch (error) {
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
    console.error(JSON.stringify({ desktopFailure: state }));
  }
  throw error;
} finally {
  await application?.close();
  if (hostPid) await waitDead(hostPid);
  await Promise.all([...providerPids].map(waitDead));
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
