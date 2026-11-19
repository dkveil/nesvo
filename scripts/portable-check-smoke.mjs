import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const workflow = 'portable-smoke';
const step = 'verify-tests';

async function write(root, path, text) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

const testScript = failing =>
  [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    'const add = (total: number, entry: number) => total + entry;',
    "test('applies the entry to the balance', () => assert.equal(add(35, 7), " +
      (failing ? 43 : 42) +
      '));',
  ].join('\n');

const empty = '---\nworkflow: portable-smoke\n---\nTest the project change.\n';
const saveManifest = (folder, preferred) =>
  write(
    folder,
    'package.json',
    JSON.stringify({
      name: 'portable-typescript',
      packageManager: 'npm@11',
      type: 'module',
      scripts: {
        ...(preferred ? { test: 'node --test balance.test.ts' } : {}),
        'test:ci': 'node --test balance.test.ts',
      },
    }),
  );

export async function smokePortableCheck({
  application,
  page,
  directory,
  home,
  shots,
  demo = false,
  kotlin,
  shotSize = [1280, 800],
}) {
  await write(
    home,
    'steps/verify-tests.md',
    [
      '---',
      'name: verify-tests',
      'type: check',
      'phase: pre-done',
      'intent: tests',
      'preferred: { typescript: { runner: package-script, script: test }, kotlin: { runner: gradle-wrapper, task: test } }',
      'timeout: 2m',
      'on_fail: fix',
      '---',
      'Run the project tests that cover the changed behavior. Record evidence that the suite ran.',
      '',
    ].join('\n'),
  );
  await write(
    home,
    'workflows/portable-smoke.md',
    '---\nname: portable-smoke\nsteps: [verify-tests]\n---\n',
  );
  const typescript = join(directory, 'portable-typescript');
  await saveManifest(typescript, false);
  await write(typescript, 'balance.test.ts', testScript(false));

  const start = async folder => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        return await page.evaluate(
          directory =>
            window.nesvo.workflows.runSteps('local', {
              directory,
              specPath: 'nesvo-task.md',
            }),
          folder,
        );
      } catch (error) {
        if (
          !String(error).includes(
            'This computer is offline or still synchronizing. Connect before sending a command.',
          )
        )
          throw error;
        await delay(200);
      }
    }
    const computers = await page.evaluate(() => window.nesvo.listComputers());
    assert.fail(
      'The local host kept refusing to dispatch the portable check. ' +
        JSON.stringify(
          computers.map(({ id, status, lastError }) => ({
            id,
            status,
            lastError,
          })),
        ),
    );
  };
  const run = async (folder, expected) => {
    await write(folder, 'nesvo-task.md', empty);
    const started = await start(folder);
    const deadline = Date.now() + 120000;
    do {
      const detail = await page.evaluate(
        id => window.nesvo.workflows.getRun('local', id),
        started.id,
      );
      if (!['pending', 'checking'].includes(detail.run.status)) {
        assert.equal(
          detail.steps[0].state,
          expected,
          JSON.stringify(detail.steps),
        );
        return detail;
      }
      await delay(80);
    } while (Date.now() < deadline);
    assert.fail('Portable check did not settle');
  };

  await page.waitForFunction(async () =>
    (await window.nesvo.listComputers()).some(
      computer =>
        computer.id === 'local' &&
        computer.status === 'connected' &&
        computer.capabilities.includes('portable-checks'),
    ),
  );
  const adapted = await run(typescript, 'passed');
  assert.deepEqual(
    adapted.steps[0].result.check.invocations.map(entry => entry.outcome),
    ['setup-mismatch', 'passed'],
  );
  const screenshots = async name => {
    if (!shots) return;
    const [width, height] = await page.evaluate(() => [
      innerWidth,
      innerHeight,
    ]);
    assert.deepEqual([width, height], shotSize);
    await page.evaluate(
      () =>
        new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await delay(250);
    const png = await application.evaluate(async ({ BrowserWindow }) => {
      const image =
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(
          undefined,
          { stayHidden: true, stayAwake: true },
        );
      return image.toPNG().toString('base64');
    });
    const bytes = Buffer.from(png, 'base64');
    assert.deepEqual(
      [bytes.readUInt32BE(16), bytes.readUInt32BE(20)],
      shotSize,
    );
    await writeFile(join(shots, name + '.png'), bytes);
  };
  if (shots) {
    await mkdir(shots, { recursive: true });
    await application.evaluate(({ BrowserWindow }, [width, height]) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window.isMaximized()) window.unmaximize();
      window.setContentSize(width, height);
    }, shotSize);
    await page.waitForFunction(
      ([width, height]) => innerWidth === width && innerHeight === height,
      shotSize,
    );
  }
  await page.evaluate(() => window.nesvo.setColorScheme('dark'));
  const list = page.getByRole('region', { name: 'Workflows', exact: true });
  if (!(await list.isVisible()))
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  await list.getByLabel('Project folder', { exact: true }).fill(typescript);
  await list.getByRole('button', { name: 'Read', exact: true }).click();
  const openEditor = () =>
    list.getByRole('button', { name: 'Edit ' + workflow, exact: true }).click();
  await openEditor();
  const editor = page.getByRole('region', {
    name: 'Graph editor',
    exact: true,
  });
  const node = editor.locator('[data-editor-node="' + step + '"]');
  const lastRun = editor.getByRole('button', { name: 'Last run', exact: true });
  if ((await lastRun.getAttribute('aria-pressed')) === 'true')
    await lastRun.click();
  await node.click();
  assert.equal(
    await editor.getByLabel('TypeScript script').inputValue(),
    'test',
  );
  assert.equal(
    await editor.getByLabel('Kotlin Gradle task').inputValue(),
    'test',
  );
  await editor.getByLabel('Acceptance criteria').waitFor();
  const inspector = editor.getByRole('complementary', { name: 'Inspector' });
  assert.equal(await inspector.getAttribute('data-slot'), 'side-panel');
  await inspector
    .getByRole('button', { name: 'Close inspector', exact: true })
    .waitFor();
  assert.match(
    await inspector.evaluate(node =>
      node.style.getPropertyValue('--panel-width'),
    ),
    /^\d+px$/,
  );
  await editor.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await screenshots('check-step-inspector');
  await lastRun.click();
  await editor.getByRole('region', { name: 'Check evidence' }).waitFor();
  const evidence = editor.getByRole('region', { name: 'Check evidence' });
  await evidence.getByText('npm run test:ci', { exact: true }).waitFor();
  await evidence
    .getByText('The script is absent from package.json.', { exact: true })
    .first()
    .waitFor();
  await evidence.getByText(/Node test runner reported/).waitFor();
  await screenshots('check-last-run');
  await editor
    .getByRole('button', { name: 'Close graph editor', exact: true })
    .click();
  const results = [adapted];
  if (demo) {
    await saveManifest(typescript, true);
    await write(typescript, 'balance.test.ts', testScript(true));
    const failed = await run(typescript, 'failed');
    assert.equal(failed.steps[0].result.check.invocations.length, 1);
    results.push(failed);
    if (shots) {
      await openEditor();
      if ((await lastRun.getAttribute('aria-pressed')) !== 'true')
        await lastRun.click();
      await node.and(editor.locator('[data-run-state="failed"]')).click();
      await evidence.getByText('npm run test', { exact: true }).waitFor();
      await evidence.getByText(/Exit code 1/).waitFor();
      await editor
        .getByRole('button', { name: 'Fit graph', exact: true })
        .click();
      await screenshots('check-failed-run');
      await editor
        .getByRole('button', { name: 'Close graph editor', exact: true })
        .click();
    }

    if (kotlin) results.push(await run(kotlin, 'passed'));

    const python = join(directory, 'portable-python');
    await write(
      python,
      '.github/workflows/tests.yml',
      'jobs:\n  suite:\n    steps:\n      - name: Test the balance\n        run: python -m unittest -v\n',
    );
    await write(
      python,
      'test_balance.py',
      [
        'import unittest',
        '',
        'def add(total, entry):',
        '    return total + entry',
        '',
        'class BalanceTest(unittest.TestCase):',
        '    def test_applies_entry(self):',
        '        self.assertEqual(add(35, 7), 42)',
        '',
      ].join('\n'),
    );
    results.push(await run(python, 'passed'));
  }
  if (demo && shots) {
    const names = [
      'inspect-stack',
      'typescript-tests',
      'kotlin-tests',
      'shared-review',
    ];
    for (const name of names)
      await write(
        home,
        `steps/${name}.md`,
        `---\nname: ${name}\ntype: command\nphase: pre-done\n${name === 'shared-review' ? 'join: reached\n' : ''}---\necho ${name}\n`,
      );
    await write(
      home,
      'workflows/conditional-smoke.md',
      [
        '---',
        'name: conditional-smoke',
        `steps: [${names.join(', ')}]`,
        'edges:',
        `  - 'inspect-stack -> typescript-tests when stack == "typescript"'`,
        `  - 'inspect-stack -> kotlin-tests when stack == "kotlin"'`,
        '  - typescript-tests -> shared-review',
        '  - kotlin-tests -> shared-review',
        '---',
        '',
      ].join('\n'),
    );
    await write(
      typescript,
      'nesvo-task.md',
      '---\nworkflow: conditional-smoke\n---\nVerify the conditional graph.\n',
    );
    const started = await start(typescript);
    const settled = async runId => {
      const deadline = Date.now() + 30_000;
      do {
        const current = await page.evaluate(
          id => window.nesvo.workflows.getRun('local', id),
          runId,
        );
        if (
          ['passed', 'failed', 'needs-attention', 'awaiting-human'].includes(
            current.run.status,
          )
        )
          return current;
        await delay(80);
      } while (Date.now() < deadline);
      assert.fail('The workflow did not settle.');
    };
    const observed = await settled(started.id);
    assert.equal(observed.run.status, 'passed', JSON.stringify(observed.steps));
    assert.equal(
      observed.steps.find(item => item.name === 'kotlin-tests').state,
      'unreached',
    );
    assert.equal(
      observed.steps.find(item => item.name === 'shared-review').state,
      'passed',
    );
    await list.getByRole('button', { name: 'Read', exact: true }).click();
    await list
      .getByRole('button', { name: 'Edit conditional-smoke', exact: true })
      .click();
    if ((await lastRun.getAttribute('aria-pressed')) !== 'true')
      await lastRun.click();
    await editor
      .locator('[data-editor-node="kotlin-tests"][data-run-state="unreached"]')
      .click();
    await editor.getByText(/Not reached: a condition/).waitFor();
    await editor
      .getByRole('button', { name: 'Fit graph', exact: true })
      .click();
    await screenshots('d83-2-conditional-route');
    if (['3', '4', '5', '6', '7'].includes(process.env.NESVO_D90_STAGE)) {
      await editor
        .getByRole('button', { name: 'Close graph editor', exact: true })
        .click();
      await write(
        home,
        'steps/deep-review.md',
        '---\nname: deep-review\ntype: agent\nphase: pre-done\n---\nfixture:verdict-pass\n',
      );
      await write(
        home,
        'workflows/lane-smoke.md',
        '---\nname: lane-smoke\nsteps: [deep-review]\nlanes: { light: { omit: deep-review }, full: {} }\n---\n',
      );
      const specPath = '.agents/tasks/lane-smoke.md';
      await write(
        typescript,
        specPath,
        '---\nworkflow: lane-smoke\n---\nA small documentation task.\n',
      );
      const task = await page.evaluate(
        ({ directory, specPath }) =>
          window.nesvo.workflows.startTask('local', {
            directory,
            specPath,
            workflowName: 'lane-smoke',
            provider: 'Claude Code',
            model: 'sonnet',
            mode: 'read-only',
            isolation: 'none',
            gateProvider: 'Claude Code',
            gateModel: 'sonnet',
          }),
        { directory: typescript, specPath },
      );
      const light = await settled(task.id);
      assert.equal(light.run.status, 'passed', JSON.stringify(light.run));
      assert.equal(light.run.lane?.effective, 'light');
      await list.getByRole('button', { name: 'Read', exact: true }).click();
      await list
        .getByRole('button', { name: 'Edit lane-smoke', exact: true })
        .click();
      if ((await lastRun.getAttribute('aria-pressed')) !== 'true')
        await lastRun.click();
      await editor
        .locator('[data-editor-node="deep-review"][data-run-state="unreached"]')
        .click();
      await editor.getByText(/Light lane/).waitFor();
      await editor
        .getByRole('button', { name: 'Fit graph', exact: true })
        .click();
      await screenshots('d83-3-light-lane');
    }
    if (['4', '5', '6', '7'].includes(process.env.NESVO_D90_STAGE)) {
      await editor
        .getByRole('button', { name: 'Close graph editor', exact: true })
        .click();
      await write(
        home,
        'steps/choose-gate.md',
        `---\nname: choose-gate\ntype: human\nphase: pre-done\ndelegate: unavailable-policy\ndecision: {kind: choice, options: [{id: manual, label: Manual}, {id: automatic, label: Automatic}]}\n---\nChoose how to handle the review.\n`,
      );
      await write(
        home,
        'workflows/typed-smoke.md',
        `---\nname: typed-smoke\nsteps: [choose-gate]\n${['5', '6', '7'].includes(process.env.NESVO_D90_STAGE) ? 'decision_memory: review\n' : ''}---\n`,
      );
      const specPath = '.agents/tasks/typed-smoke.md';
      await write(
        typescript,
        specPath,
        '---\nworkflow: typed-smoke\n---\nPrepare a choice.\n',
      );
      const task = await page.evaluate(
        ({ directory, specPath }) =>
          window.nesvo.workflows.startTask('local', {
            directory,
            specPath,
            workflowName: 'typed-smoke',
            provider: 'Claude Code',
            model: 'sonnet',
            mode: 'read-only',
            isolation: 'none',
            gateProvider: 'Claude Code',
            gateModel: 'sonnet',
          }),
        { directory: typescript, specPath },
      );
      const waiting = await settled(task.id);
      assert.equal(
        waiting.run.status,
        'awaiting-human',
        JSON.stringify(waiting.run),
      );
      await list.getByRole('button', { name: 'Read', exact: true }).click();
      await list
        .getByRole('button', { name: 'Edit typed-smoke', exact: true })
        .click();
      if ((await lastRun.getAttribute('aria-pressed')) !== 'true')
        await lastRun.click();
      await editor
        .locator(
          '[data-editor-node="choose-gate"][data-run-state="awaiting-human"]',
        )
        .click();
      await editor.getByText('Needs approval', { exact: true }).waitFor();
      const form = editor.getByRole('form', { name: 'Gate decision' });
      await form.getByRole('combobox').click();
      await page.getByRole('option', { name: 'Manual', exact: true }).click();
      await screenshots('d83-4-typed-decision');
      await form
        .getByRole('button', { name: 'Confirm decision', exact: true })
        .click();
      await form.waitFor({ state: 'hidden' });
      const confirmed = await settled(task.id);
      assert.equal(confirmed.run.status, 'passed');
      assert.equal(confirmed.steps[0].decision.answer.option, 'manual');
      if (['5', '6', '7'].includes(process.env.NESVO_D90_STAGE)) {
        const proposal = await page.evaluate(async runId => {
          const overview = await window.nesvo.gateRules(
            { action: 'read', runId },
            'local',
          );
          return overview.proposals.find(item => item.origin === 'precedent');
        }, task.id);
        assert.ok(proposal);
        await page.evaluate(
          proposal =>
            window.nesvo.gateRules(
              {
                action: 'decide',
                decision: {
                  action: 'accept',
                  proposalId: proposal.id,
                  revision: proposal.revision,
                  decisionId: crypto.randomUUID(),
                },
              },
              'local',
            ),
          proposal,
        );
        await editor
          .getByRole('button', { name: 'Lessons & decisions', exact: true })
          .click();
        const memory = editor.getByRole('region', {
          name: 'Lessons and decisions',
        });
        await memory
          .getByText(/The operator chose Approve at choose-gate/)
          .waitFor();
        await memory.getByRole('button', { name: 'Open source run' }).waitFor();
        await screenshots('d90-decision-memory');
        if (['6', '7'].includes(process.env.NESVO_D90_STAGE)) {
          await memory
            .getByRole('combobox', { name: 'Filter by step' })
            .click();
          await page
            .getByRole('option', { name: 'choose-gate', exact: true })
            .click();
          const autonomy = memory.getByRole('region', {
            name: 'Gate autonomy',
          });
          await autonomy.getByText(/Level 0/).waitFor();
          await autonomy.getByLabel('Minimum agreements').fill('1');
          await autonomy
            .getByRole('button', { name: 'Save thresholds', exact: true })
            .click();
          await autonomy
            .getByRole('button', { name: 'Review level change', exact: true })
            .click();
          await autonomy.getByText(/Proposed level 1/).waitFor();
          await screenshots('d90-autonomy');
          await autonomy
            .getByRole('button', { name: 'Accept level 1', exact: true })
            .click();
          await autonomy.getByText(/Level 1/).waitFor();
          if (process.env.NESVO_D90_STAGE === '7') {
            const trust = memory.getByRole('region', { name: 'Gate trust' });
            await trust
              .getByLabel('Why is this gate human?')
              .fill('The reviewer must confirm the approval path.');
            await trust
              .getByRole('button', { name: 'Save trust record' })
              .click();
            await trust
              .getByRole('button', { name: 'Show 1 decision case' })
              .click();
            await trust
              .getByText('Still needed me (1)', { exact: true })
              .waitFor();
            await screenshots('d90-trust-cases');
            await editor.locator('[data-editor-node="choose-gate"]').click();
            await editor
              .getByRole('complementary', { name: 'Inspector' })
              .getByLabel('Why is this gate human?')
              .waitFor();
            await editor
              .getByRole('button', { name: 'Open assistant' })
              .click();
            const assistant = page.locator('[data-assistant-dock]');
            await assistant
              .getByRole('button', {
                name: 'What would I need to make this gate more autonomous?',
              })
              .click();
            await assistant
              .getByText(
                '0 past cases in the trusted branch, 1 in the human branch.',
              )
              .waitFor();
            await screenshots('d90-trust-assistant');
            await assistant
              .getByRole('button', { name: 'Dismiss', exact: true })
              .click();
            await assistant
              .getByText(/dismissed suggestion will stay hidden/)
              .waitFor();
          }
        }
      }
    }
  }
  for (const detail of results) {
    const result = detail.steps[0].result;
    console.log(
      JSON.stringify({
        portableCheck: detail.run.workflow.name,
        global: detail.run.workflow.source.scope === 'global',
        stack: detail.run.projectProfile.stack,
        runStatus: detail.run.status,
        invocations: result.check.invocations,
      }),
    );
  }
}
