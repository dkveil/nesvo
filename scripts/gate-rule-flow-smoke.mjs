import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

export async function smokeGateRuleFlow({
  application,
  page,
  directory,
  shots,
}) {
  const project = join(directory, 'gate-rule-project');
  const root = join(project, '.agents', 'workflows');
  const spec = join(project, '.agents', 'tasks', 'logging.md');
  const ruleFile = join(root, 'gate-rules', 'rule-0001.md');
  await Promise.all(
    ['steps', 'workflows'].map(folder =>
      mkdir(join(root, folder), { recursive: true }),
    ),
  );
  await mkdir(join(spec, '..'), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, 'steps', 'review.md'),
      '---\nname: review\ntype: agent\nphase: pre-done\non_fail: stop\n---\nfixture:gate-rule-verdict\n',
    ),
    writeFile(
      join(root, 'steps', 'approve.md'),
      '---\nname: approve\ntype: human\nphase: pre-done\n---\nReview the change.\n',
    ),
    writeFile(
      join(root, 'workflows', 'logging.md'),
      '---\nname: logging\nsteps: [review, approve]\n---\n',
    ),
    writeFile(
      spec,
      '---\nworkflow: logging\ntitle: Update application logging\n---\nUse the shared logger.\n',
    ),
  ]);
  await promisify(execFile)('git', ['init', '-q', project], {
    windowsHide: true,
  });

  const screenshot = async name => {
    if (!shots) return;
    await mkdir(shots, { recursive: true });
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.webContents.setBackgroundThrottling(false);
      if (!window.isVisible()) window.showInactive();
    });
    await page.screenshot({
      path: join(shots, name + '.png'),
      animations: 'disabled',
    });
  };
  const start = () =>
    page.evaluate(
      ({ project, spec }) =>
        window.nesvo.workflows.startTask('local', {
          directory: project,
          specPath: spec,
          workflowName: 'logging',
          provider: 'Claude Code',
          model: 'sonnet',
          mode: 'read-only',
          isolation: 'none',
          gateProvider: 'Claude Code',
          gateModel: 'sonnet',
        }),
      { project, spec },
    );
  const detail = id =>
    page.evaluate(runId => window.nesvo.workflows.getRun('local', runId), id);
  const waitForRun = async (id, match) => {
    const deadline = Date.now() + 30_000;
    let current;
    while (Date.now() < deadline) {
      current = await detail(id);
      const result = match(current);
      if (result) return result;
      await delay(100);
    }
    throw new Error(`Workflow state not reached: ${JSON.stringify(current)}`);
  };
  const decision = async (runId, kind, comment, previous = null) => {
    const step = await waitForRun(
      runId,
      ({ run, steps }) =>
        run.status === 'awaiting-human' &&
        steps.findLast(
          step =>
            step.name === 'approve' &&
            step.id !== previous &&
            step.state === 'awaiting-human',
        ),
    );
    await page.evaluate(
      input => window.nesvo.workflows.decideGate('local', input),
      {
        runId,
        stepId: step.id,
        reviewId: step.reviewId,
        version: step.reviewVersion,
        decision: kind,
        comment,
        decisionId: randomUUID(),
      },
    );
    return step.id;
  };
  const quote = 'Application messages must use the shared logger.';
  const source = await start();
  const fix = await decision(source.id, 'fix', quote);
  await decision(source.id, 'accept', '', fix);
  await page.getByRole('button', { name: /^Inbox/ }).click();
  const row = page.getByRole('article', { name: 'Gate rule proposal' });
  await row
    .getByText(`From your Fix comment: “${quote}”`, { exact: true })
    .waitFor({ timeout: 30_000 });
  await screenshot('inbox-proposal');
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await row
    .getByRole('textbox', { name: 'Rule', exact: true })
    .fill('Use the shared logger for every application message.');
  await row.getByRole('button', { name: 'Save rule', exact: true }).click();
  await row.waitFor({ state: 'hidden' });
  const toast = page
    .locator('[data-slot="toast"]')
    .filter({ hasText: 'Gate rule saved' });
  await toast.getByRole('button', { name: 'Undo', exact: true }).waitFor();
  assert.match(
    await readFile(ruleFile, 'utf8'),
    /Use the shared logger for every application message/,
  );
  await toast.getByRole('button', { name: 'Dismiss', exact: true }).click();

  const verify = async () => {
    const run = await start();
    await waitForRun(
      run.id,
      ({ run, steps }) =>
        run.status === 'failed' &&
        steps.some(step =>
          step.result?.evidence.some(item => item.rule === 'rule-0001'),
        ),
    );
  };
  await verify();
  await verify();
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  const workflows = page.getByRole('region', {
    name: 'Workflows',
    exact: true,
  });
  await workflows.getByLabel('Project folder', { exact: true }).fill(project);
  await workflows.getByRole('button', { name: 'Read', exact: true }).click();
  await workflows
    .getByRole('button', { name: 'Edit logging', exact: true })
    .click();
  const editor = page.getByRole('region', {
    name: 'Graph editor',
    exact: true,
  });
  await editor.locator('[data-editor-node="review"]').click();
  const inspector = editor.getByRole('complementary', {
    name: 'Inspector',
    exact: true,
  });
  const rules = inspector.getByRole('region', {
    name: 'Gate rules',
    exact: true,
  });
  await rules.getByText('Delivered 2', { exact: true }).waitFor();
  await rules.getByText('Cited 2', { exact: true }).waitFor();
  await rules
    .getByText('Keeps failing, consider a check', { exact: true })
    .waitFor();
  await screenshot('step-inspector-gate-rules');
  await rules.getByRole('button', { name: 'Undo', exact: true }).click();
  await rules.getByText('No gate rules assigned.', { exact: true }).waitFor();
  await assert.rejects(readFile(ruleFile), { code: 'ENOENT' });
}
