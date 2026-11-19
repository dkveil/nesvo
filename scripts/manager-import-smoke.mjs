import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import {
  agentDeckImportFixture,
  t3ImportFixture,
} from '../apps/host/tests/manager-import-fixture.mjs';

export async function smokeManagerImport() {
  const temp = await realpath(tmpdir());
  const directory = await realpath(
    await mkdtemp(join(temp, 'nesvo-d86-desktop-')),
  );
  const difference = relative(temp, directory);
  assert.match(difference, /^nesvo-d86-desktop-[A-Za-z0-9]+$/);
  const screenshotDirectory = process.env.NESVO_D86_SCREENSHOTS;
  const t3 = join(directory, 't3');
  const deck = join(directory, 'agent-deck');
  const claude = join(directory, 'claude');
  const codex = join(directory, 'codex');
  const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
  let app;
  let fixture;
  try {
    fixture = await t3ImportFixture(t3, claude);
    await agentDeckImportFixture(deck, codex, fixture);
    const launch = show =>
      electron.launch({
        executablePath: requireDesktop('electron'),
        args: [
          ...(screenshotDirectory
            ? ['--remote-debugging-port=9246', '--force-device-scale-factor=1']
            : []),
          resolve('apps/desktop'),
        ],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: undefined,
          NESVO_DATA_DIR: directory,
          NESVO_SMOKE_TEST: '1',
          NESVO_TEST_MODE: '1',
          NESVO_TEST_SHOW_ONBOARDING: show ? '1' : '0',
          NESVO_WORK_LAPTOP_MODE: '0',
          NESVO_CLAUDE_EXECUTABLE: resolve(
            'apps/host/tests/claude-fixture.mjs',
          ),
          NESVO_CODEX_EXECUTABLE: resolve('apps/host/tests/codex-fixture.mjs'),
          NESVO_FIXTURE_PID_FILE: join(directory, 'claude.pid'),
          NESVO_CODEX_FIXTURE_PID_FILE: join(directory, 'codex.pid'),
          CLAUDE_CONFIG_DIR: claude,
          CODEX_HOME: codex,
          T3CODE_HOME: t3,
          NESVO_TEST_AGENT_DECK_ROOT: deck,
        },
        timeout: 30_000,
      });
    app = await launch(true);
    let page = await app.firstWindow();
    page.setDefaultTimeout(20_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const shot = async name => {
      if (!screenshotDirectory) return;
      await mkdir(screenshotDirectory, { recursive: true });
      await page.mouse.move(40, 52);
      for (const [width, height] of [
        [1280, 800],
        [1920, 1080],
      ]) {
        await app.evaluate(
          ({ BrowserWindow }, size) => {
            BrowserWindow.getAllWindows()[0].setContentSize(
              size.width,
              size.height,
            );
          },
          { width, height },
        );
        await page.waitForFunction(
          size => innerWidth === size.width && innerHeight === size.height,
          { width, height },
        );
        const image = await app.evaluate(async ({ BrowserWindow }) => {
          const capture =
            await BrowserWindow.getAllWindows()[0].webContents.capturePage(
              undefined,
              { stayHidden: true, stayAwake: true },
            );
          return {
            size: capture.getSize(),
            png: capture.toPNG().toString('base64'),
          };
        });
        assert.deepEqual(image.size, { width, height });
        await writeFile(
          join(screenshotDirectory, `d86-${name}-${width}x${height}.png`),
          Buffer.from(image.png, 'base64'),
        );
      }
    };
    const guide = page.getByRole('main', { name: 'Getting started' });
    await guide
      .getByRole('button', { name: 'Get started', exact: true })
      .click();
    await guide.getByRole('button', { name: 'Continue', exact: true }).click();
    await guide
      .getByRole('heading', {
        name: 'We found T3 Code with 1 project and 6 sessions',
        exact: true,
      })
      .waitFor();
    await guide
      .getByRole('button', { name: 'Skip import', exact: true })
      .waitFor();
    const source = guide.getByRole('combobox', { name: 'Source' });
    await source.click();
    await page.getByRole('option', { name: 'Agent Deck', exact: true }).click();
    const deckHeading = guide.getByRole('heading', {
      name: /^We found Agent Deck with /,
    });
    await deckHeading.waitFor();
    await guide.getByRole('button', { name: 'Back', exact: true }).click();
    await guide.getByRole('button', { name: 'Continue', exact: true }).click();
    await deckHeading.waitFor();
    assert.equal(await source.innerText(), 'Agent Deck');
    await source.click();
    await page.getByRole('option', { name: 'T3 Code', exact: true }).click();
    if (screenshotDirectory) {
      const response = await fetch('http://127.0.0.1:9246/json/version');
      assert.ok(response.ok);
    }
    await shot('onboarding');
    await guide
      .getByRole('button', { name: 'Expand Release workspace' })
      .click();
    const importAction = guide.getByRole('button', {
      name: 'Import selected',
      exact: true,
    });
    assert.ok(await importAction.isDisabled());
    assert.ok(
      await guide
        .getByRole('checkbox', { name: 'Select Old worktree' })
        .isDisabled(),
    );
    await guide
      .getByText('Worktree removed, resumes in the project folder.', {
        exact: true,
      })
      .waitFor();
    const project = guide.getByRole('checkbox', {
      name: 'Select Release workspace',
      exact: true,
    });
    await project.check();
    assert.equal(
      await guide
        .getByRole('checkbox', {
          name: 'Select Removed worktree with history and resume in the project folder',
          exact: true,
        })
        .isChecked(),
      false,
    );
    await project.uncheck();
    await guide
      .getByRole('checkbox', { name: 'Select Release notes', exact: true })
      .check();
    await shot('picker');
    await importAction.click();
    await guide
      .getByText('1 imported · 0 already in Nesvo · 0 skipped', { exact: true })
      .waitFor();
    await shot('result');
    await guide.getByRole('button', { name: 'Continue', exact: true }).click();
    await guide
      .getByRole('heading', { name: 'Computers', exact: true })
      .waitFor();
    await guide.getByRole('button', { name: 'Skip', exact: true }).click();

    const archived = () =>
      page.getByRole('list', { name: 'Archived sessions' });
    const checkArchive = async () => {
      const section = page.getByRole('button', {
        name: 'Archived (1)',
        exact: true,
      });
      await section.waitFor();
      if ((await section.getAttribute('aria-expanded')) === 'false')
        await section.click();
      await archived()
        .getByRole('button', { name: /^Release notes/ })
        .waitFor();
      const sessions = await page.evaluate(() => window.nesvo.listSessions());
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].providerSessionId, fixture.nativeId);
      assert.equal(sessions[0].mode, 'read-only');
      assert.equal(sessions[0].archivedAt, fixture.archivedAt);
      assert.ok(sessions[0].groupId);
      return sessions[0].id;
    };
    const id = await checkArchive();
    await app.close();
    app = undefined;
    app = await launch(false);
    page = await app.firstWindow();
    page.setDefaultTimeout(20_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await checkArchive(), id);
    await archived()
      .getByRole('button', { name: /^Release notes/ })
      .click();
    await page
      .getByText('Draft release notes for the example project.', {
        exact: true,
      })
      .waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', {
      name: 'Settings',
      exact: true,
    });
    await settings.getByRole('button', { name: 'Import', exact: true }).click();
    await settings
      .getByRole('button', { name: 'Expand Release workspace' })
      .click();
    await settings.getByText(/Already in Nesvo/).waitFor();
    await shot('settings');
    await settings
      .getByRole('checkbox', { name: 'Select Release notes', exact: true })
      .check();
    await settings
      .getByRole('button', { name: 'Import selected', exact: true })
      .click();
    await settings
      .getByText('0 imported · 1 already in Nesvo · 0 skipped', { exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(
        async () => (await window.nesvo.listSessions()).length,
      ),
      1,
    );
    console.log(
      JSON.stringify({
        result: 'passed',
        scenario: 'manager import fixtures',
        platform: process.platform,
      }),
    );
  } finally {
    await app?.close();
    fixture?.db.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

if (import.meta.main) await smokeManagerImport();
