import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serial = process.env.NESVO_ANDROID_SERIAL;
assert.match(serial ?? '', /^emulator-\d+$/, 'Set NESVO_ANDROID_SERIAL');
const client = process.env.NESVO_MOBILE_CLIENT ?? 'development';
assert.ok(
  ['development', 'expo-go'].includes(client),
  'NESVO_MOBILE_CLIENT must be development or expo-go',
);
const appPackage =
  client === 'expo-go' ? 'host.exp.exponent' : 'dev.dkveil.nesvomobile';
const expoUrl = process.env.NESVO_MOBILE_EXPO_URL ?? process.env.NESVO_EXPO_URL;
if (client === 'expo-go') {
  assert.ok(expoUrl, 'Set NESVO_MOBILE_EXPO_URL to the owned Metro launch URL');
  const launchUrl = new URL(expoUrl);
  assert.equal(launchUrl.protocol, 'exp:');
  assert.ok(['127.0.0.1', 'localhost'].includes(launchUrl.hostname));
}
const metroPort = Number(
  client === 'expo-go'
    ? new URL(expoUrl).port
    : (process.env.NESVO_MOBILE_METRO_PORT ?? '8095'),
);
assert.ok(Number.isInteger(metroPort) && metroPort > 0 && metroPort !== 8789);
const sdk =
  process.env.ANDROID_HOME ??
  join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const adbPath = join(
  sdk,
  'platform-tools',
  process.platform === 'win32' ? 'adb.exe' : 'adb',
);
const temporaryRoot = await realpath(tmpdir());
const directory = await realpath(
  await mkdtemp(join(temporaryRoot, 'nesvo-mobile-')),
);
const runId = randomUUID();
const hierarchyPath = `/sdcard/nesvo-mobile-${runId}.xml`;
const screenshotDirectory = process.env.NESVO_MOBILE_SCREENSHOTS;
const requireDesktop = createRequire(
  join(repository, 'apps', 'desktop', 'package.json'),
);
const executablePath = requireDesktop('electron');
const reversed = new Set();
let application;
let page;
let failure;
let evidence;
let paired = false;
const pageErrors = [];
let screen;
const phase = value => console.log(JSON.stringify({ phase: value }));
const launchTimeout = 120_000;

function command(
  binary,
  args,
  { timeout = 30_000, allowFailure = false } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: repository,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    let bytes = 0;
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= 8 * 1024 * 1024) stdout.push(chunk);
      else child.kill();
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 && !allowFailure)
        reject(
          new Error(
            `${basename(binary)} ${args[0]} failed (${code ?? signal}).`,
          ),
        );
      else resolve({ code, signal, stdout: Buffer.concat(stdout), stderr });
    });
  });
}

const adb = (args, options) =>
  command(adbPath, ['-s', serial, ...args], options);
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const decodeXml = value =>
  value
    .replace(/&#(\d+);/g, (_match, number) =>
      String.fromCodePoint(Number(number)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

async function hierarchy() {
  try {
    await adb(['shell', 'uiautomator', 'dump', hierarchyPath]);
    const xml = (await adb(['exec-out', 'cat', hierarchyPath])).stdout.toString(
      'utf8',
    );
    assert.ok(
      xml.includes('<hierarchy'),
      'Android did not return a UI hierarchy',
    );
    return [...xml.matchAll(/<node\b([^>]+)>/g)].map(match =>
      Object.fromEntries(
        [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [
          name,
          decodeXml(value),
        ]),
      ),
    );
  } finally {
    await adb(['shell', 'rm', '-f', hierarchyPath], { allowFailure: true });
  }
}

async function waitFor(read, predicate, description, milliseconds = 30_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(150);
  }
  assert.fail(description);
}

function findNode(values, label, { includes = false, enabled = true } = {}) {
  const candidates = enabled
    ? values.filter(value => value.enabled === 'true')
    : values;
  const matches = value =>
    includes
      ? value?.includes(label)
      : value === label || value?.endsWith(`:id/${label}`);
  for (const attribute of ['resource-id', 'content-desc', 'text']) {
    const found = candidates.find(value => matches(value[attribute]));
    if (found) return found;
  }
}

async function node(label, options) {
  const matches = values => findNode(values, label, options);
  return matches(
    await waitFor(
      hierarchy,
      values => !!matches(values),
      `Android control missing: ${label}`,
    ),
  );
}

async function scrollTo(label, direction = 'down', options) {
  await hideKeyboard();
  for (let attempt = 0; attempt < 8; attempt++) {
    const values = await hierarchy();
    const target = listTarget(values, label, options);
    if (target) return target;
    const candidate = findNode(values, label);
    const viewport = listViewport(values);
    const bounds = candidate && rectangle(candidate);
    await swipe(
      bounds && viewport
        ? bounds.bottom > viewport.bottom
          ? 'down'
          : bounds.top < viewport.top
            ? 'up'
            : direction
        : direction,
    );
  }
  assert.fail(`Android control not found while scrolling: ${label}`);
}

function rectangle(value) {
  const [left, top, right, bottom] = [...value.bounds.matchAll(/\d+/g)].map(
    match => Number(match[0]),
  );
  return { left, top, right, bottom };
}

function listViewport(values) {
  const list = [
    'conversation-list',
    'connections-list',
    'sessions-list',
    'computers-list',
  ]
    .map(label => findNode(values, label, { enabled: false }))
    .find(Boolean);
  return list ? rectangle(list) : null;
}

function listTarget(values, label, { readOnly = false } = {}) {
  let target = findNode(values, label);
  const viewport = listViewport(values);
  if (!target || !viewport) return null;
  const contains = (outer, inner) =>
    inner.left >= outer.left &&
    inner.right <= outer.right &&
    inner.top >= outer.top &&
    inner.bottom <= outer.bottom &&
    inner.right > inner.left &&
    inner.bottom > inner.top;
  if (!readOnly && target.clickable !== 'true') {
    const text = rectangle(target);
    target = values
      .filter(
        value =>
          value.clickable === 'true' &&
          value.enabled === 'true' &&
          contains(rectangle(value), text),
      )
      .sort((left, right) => {
        const area = value => {
          const box = rectangle(value);
          return (box.right - box.left) * (box.bottom - box.top);
        };
        return area(left) - area(right);
      })[0];
  }
  return target && contains(viewport, rectangle(target)) ? target : null;
}

async function tapInList(label, direction) {
  await scrollTo(label, direction);
  const target = listTarget(await hierarchy(), label);
  assert.ok(target, `Native list target moved outside its viewport: ${label}`);
  await tapTarget(target, label);
}

async function swipe(direction) {
  await hideKeyboard();
  const x = String(Math.floor(screen.width / 2));
  const upper = String(Math.floor(screen.height * 0.3));
  const lower = String(Math.floor(screen.height * 0.7));
  await adb([
    'shell',
    'input',
    'swipe',
    x,
    direction === 'down' ? lower : upper,
    x,
    direction === 'down' ? upper : lower,
    '300',
  ]);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  );
  assert.notEqual(port, 8789);
  return port;
}

async function tap(label, options) {
  const target = await node(label, options);
  await tapTarget(target, label);
}

async function tapTarget(target, label) {
  const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(target.bounds);
  assert.ok(bounds, `Android control has no bounds: ${label}`);
  const [, left, top, right, bottom] = bounds.map(Number);
  assert.ok(right > left && bottom > top);
  await adb([
    'shell',
    'input',
    'tap',
    String(Math.floor((left + right) / 2)),
    String(Math.floor((top + bottom) / 2)),
  ]);
}

async function fill(label, value) {
  assert.match(value, /^[\x20-\x7e]+$/);
  await tap(label);
  await adb(['shell', 'input', 'keycombination', '113', '29']);
  await adb(['shell', 'input', 'keyevent', '67']);
  await waitFor(
    hierarchy,
    values => {
      const input = findNode(values, label);
      return input && (!input.text || input.text === input.hint);
    },
    `Native input did not clear: ${label}`,
  );
  await adb(['shell', `input text ${shellQuote(value.replaceAll(' ', '%s'))}`]);
  await waitFor(
    hierarchy,
    values => findNode(values, label)?.text === value,
    `Native input did not receive its expected value: ${label}`,
  );
  await hideKeyboard();
}

async function keyboardVisible() {
  const state = (
    await adb(['shell', 'dumpsys', 'input_method'])
  ).stdout.toString('utf8');
  return (
    /mInputShown=true/.test(state) ||
    [...state.matchAll(/mImeWindowVis=(0x[\da-f]+|\d+)/gi)].some(
      match => (Number(match[1]) & 2) !== 0,
    )
  );
}

async function hideKeyboard() {
  if (!(await keyboardVisible())) return;
  await adb(['shell', 'input', 'keyevent', '4']);
  await waitFor(
    keyboardVisible,
    value => !value,
    'Android keyboard did not hide',
    5000,
  );
}

async function phoneSend(text) {
  await fill('Message', text);
  await tap('send-message');
  await hideKeyboard();
}

async function openPairForm() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const values = await hierarchy();
    if (
      findNode(values, 'React Native dev menu', { enabled: false }) &&
      findNode(values, 'Close')
    ) {
      await dismissExpoMenu();
      continue;
    }
    if (findNode(values, 'Pairing link')) return;
    const action = findNode(values, 'open-pair');
    if (action) {
      await tapTarget(action, 'Pair computer');
      await node('Pairing link');
      return;
    }
    await adb(['shell', 'input', 'keyevent', '4']);
  }
  assert.fail('Android could not return to its pairing screen');
}

async function dismissExpoMenu(milliseconds) {
  const values = await waitFor(
    hierarchy,
    values =>
      (findNode(values, 'React Native dev menu', { enabled: false }) &&
        findNode(values, 'Close')) ||
      ['Connections', 'Pairing link', 'Message'].some(label =>
        findNode(values, label, { enabled: false }),
      ),
    'Android did not display the mobile application',
    milliseconds,
  );
  const close = findNode(values, 'Close');
  if (!findNode(values, 'React Native dev menu', { enabled: false }) || !close)
    return;
  await tapTarget(close, 'Close Expo Go developer menu');
  await waitFor(
    hierarchy,
    values =>
      !(
        findNode(values, 'React Native dev menu', { enabled: false }) &&
        findNode(values, 'Close')
      ),
    'Expo Go developer menu stayed open',
  );
}

async function launchApplication() {
  await adb([
    'shell',
    client === 'expo-go'
      ? `am start -W -a android.intent.action.VIEW -d ${shellQuote(expoUrl)} ${appPackage}`
      : `am start -W -n ${appPackage}/.MainActivity`,
  ]);
  await dismissExpoMenu(launchTimeout);
}

async function foregroundActivity() {
  const state = (
    await adb(['shell', 'dumpsys', 'activity', 'activities'])
  ).stdout.toString('utf8');
  return /topResumedActivity=.*?\{[^}]*\s(\S+\/\S+)/.exec(state)?.[1] ?? null;
}

async function screenshot(filename) {
  if (!screenshotDirectory || !paired) return;
  await mkdir(screenshotDirectory, { recursive: true });
  const result = await adb(['exec-out', 'screencap', '-p']);
  assert.equal(result.stdout.subarray(1, 4).toString('ascii'), 'PNG');
  await writeFile(join(screenshotDirectory, filename), result.stdout);
}

async function desktopScreenshot(filename) {
  if (!screenshotDirectory || !paired) return;
  const modal = page.getByRole('dialog', { name: 'Phone access', exact: true });
  await modal.waitFor({ state: 'visible' });
  assert.equal(
    await modal
      .getByRole('textbox', { name: 'Pairing link', exact: true })
      .count(),
    0,
  );
  await mkdir(screenshotDirectory, { recursive: true });
  await page.evaluate(
    () =>
      new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await delay(200);
  const encoded = await application.evaluate(async ({ BrowserWindow }) =>
    (
      await BrowserWindow.getAllWindows()[0].webContents.capturePage(
        undefined,
        { stayHidden: true, stayAwake: true },
      )
    )
      .toPNG()
      .toString('base64'),
  );
  await writeFile(
    join(screenshotDirectory, filename),
    Buffer.from(encoded, 'base64'),
  );
}

async function reverse(port) {
  const name = `tcp:${port}`;
  const rules = (await adb(['reverse', '--list'])).stdout
    .toString('utf8')
    .trim()
    .split('\n');
  const previous = rules
    .map(line => line.trim().split(/\s+/))
    .find(parts => parts[1] === name);
  if (previous) {
    assert.equal(previous[2], name);
    return;
  }
  await adb(['reverse', name, name]);
  reversed.add(name);
}

const sessions = () => page.evaluate(() => window.nesvo.listSessions('local'));
const session = async id => (await sessions()).find(value => value.id === id);
const waitState = (id, status) =>
  waitFor(
    () => session(id),
    value => value?.status === status,
    `Desktop session did not become ${status}`,
  );
const turns = async () => {
  try {
    return (await readFile(join(directory, 'turns.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

try {
  assert.equal(
    (await adb(['get-state'])).stdout.toString('utf8').trim(),
    'device',
  );
  const avd = (await adb(['emu', 'avd', 'name'])).stdout
    .toString('utf8')
    .trim()
    .split(/\r?\n/)[0]
    .trim();
  assert.equal(avd, 'Nesvo_D66', 'Refusing to operate an unrelated emulator');
  const size = [
    ...(await adb(['shell', 'wm', 'size'])).stdout
      .toString('utf8')
      .matchAll(/(\d+)x(\d+)/g),
  ].at(-1);
  assert.ok(size);
  screen = { width: Number(size[1]), height: Number(size[2]) };
  assert.match(
    (
      await adb(['shell', 'pm', 'path', appPackage], { allowFailure: true })
    ).stdout.toString('utf8'),
    /^package:/,
    `Install ${appPackage} on the emulator before the scenario`,
  );
  const gatewayPort = await freePort();
  await reverse(metroPort);
  await mkdir(join(directory, '.git'));
  phase('launching-isolated-desktop');
  const env = {
    ...process.env,
    NESVO_SMOKE_TEST: '1',
    NESVO_DATA_DIR: directory,
    NESVO_TEST_PID_FILE: join(directory, 'processes.json'),
    NESVO_MOBILE_PORT: String(gatewayPort),
    NESVO_CLAUDE_EXECUTABLE: join(
      repository,
      'apps/host/tests/claude-fixture.mjs',
    ),
    NESVO_CODEX_EXECUTABLE: join(
      repository,
      'apps/host/tests/codex-fixture.mjs',
    ),
    NESVO_FIXTURE_PID_FILE: join(directory, 'claude-pids.json'),
    NESVO_CODEX_FIXTURE_PID_FILE: join(directory, 'codex-pids.json'),
    NESVO_CODEX_FIXTURE_STATE_DIR: join(directory, 'codex-state'),
    NESVO_CODEX_FIXTURE_RUN_LOG: join(directory, 'turns.jsonl'),
    CLAUDE_CONFIG_DIR: join(directory, 'claude-config'),
    CODEX_HOME: join(directory, 'codex-config'),
    NESVO_TEST_SKILLS_HOME: join(directory, 'skills-home'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath,
    args: [join(repository, 'apps/desktop')],
    env,
    timeout: 30_000,
  });
  page = await application.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.getByRole('button', { name: 'Computers', exact: true }).waitFor();
  await page.evaluate(() => {
    window.mobileSmokeEvents = [];
    window.nesvo.subscribe(event => {
      if (event.type === 'session-changed')
        window.mobileSmokeEvents.push({
          at: Date.now(),
          session: event.session,
        });
    });
  });
  const createSession = (title, mode = 'read-only') =>
    page.evaluate(input => window.nesvo.createSession(input, 'local'), {
      title,
      provider: 'Codex',
      model: 'fixture-codex',
      mode,
      directory: '',
    });
  const desktopSend = (sessionId, text) =>
    page.evaluate(input => window.nesvo.sendMessage(input, 'local'), {
      sessionId,
      messageId: randomUUID(),
      text,
    });
  const conversation = await createSession('Phone conversation');
  const approvals = await createSession('Phone approvals', 'supervised');
  const workers = await createSession('Phone workers');
  await desktopSend(conversation.id, 'fixture:stream');
  const seeded = await waitState(conversation.id, 'completed');
  assert.equal(
    (await page.evaluate(() => window.nesvo.mobileStatus())).enabled,
    false,
  );
  const gateway = await page.evaluate(() => window.nesvo.enableMobile());
  assert.equal(gateway.enabled, true);
  assert.equal(Number(new URL(gateway.url).port), gatewayPort);
  await reverse(gatewayPort);
  const pairing = await page.evaluate(() => window.nesvo.pairMobile());
  phase('pairing-native-android');
  assert.equal(pairing.serverId, gateway.serverId);
  assert.equal(
    typeof pairing.link === 'string' &&
      pairing.link.startsWith('nesvo://pair#'),
    true,
  );
  if (client === 'development')
    await adb(['shell', 'am', 'force-stop', appPackage]);
  await launchApplication();
  await openPairForm();
  await fill('Pairing link', pairing.link);
  await fill('Device name', 'D66 emulator fixture');
  await tap('pair-computer');
  await node('Open computer: Local');
  paired = true;
  phase('reading-native-history');
  const connected = await waitFor(
    () => page.evaluate(() => window.nesvo.mobileStatus()),
    value =>
      value.clients === 1 &&
      value.devices.some(device => device.name === 'D66 emulator fixture'),
    'Android did not establish its authenticated event connection',
  );
  const device = connected.devices.find(
    device => device.name === 'D66 emulator fixture',
  );
  await page.getByRole('button', { name: 'Phone access', exact: true }).click();
  const access = page.getByRole('dialog', {
    name: 'Phone access',
    exact: true,
  });
  await access.waitFor({ state: 'visible' });
  await access.getByText(device.name, { exact: true }).waitFor();
  assert.equal(
    await access
      .getByRole('textbox', { name: 'Pairing link', exact: true })
      .count(),
    0,
  );
  await desktopScreenshot('desktop-phone-access.png');
  await page.keyboard.press('Escape');
  await access.waitFor({ state: 'hidden' });
  await tap('Open computer: Local');
  await tap('Open session: Phone conversation');
  await node(`message-${seeded.messages.at(-1).id}`);
  await node('Codex fixture streamed reply.', { includes: true });
  await screenshot('01-history.png');
  const initialTurns = await turns();
  await phoneSend('fixture:stream');
  const phoneReply = await waitFor(
    () => session(conversation.id),
    value => value.runId !== seeded.runId && value.status === 'completed',
    'Phone message did not complete on the desktop host',
  );
  assert.equal(phoneReply.providerSessionId, seeded.providerSessionId);
  assert.equal(phoneReply.messages.length, seeded.messages.length + 2);
  assert.equal(phoneReply.messages.at(-2).body, 'fixture:stream');
  assert.equal((await turns()).length, initialTurns.length + 1);
  const streamed = await page.evaluate(
    runId =>
      window.mobileSmokeEvents.filter(event => event.session.runId === runId),
    phoneReply.runId,
  );
  const partial = streamed.find(
    event =>
      event.session.status === 'running' &&
      event.session.messages.at(-1)?.body === 'Codex fixture streamed ',
  );
  const terminal = streamed.find(event => event.session.status === 'completed');
  assert.ok(partial && terminal && terminal.at - partial.at >= 100);
  await node(`message-${phoneReply.messages.at(-1).id}`);
  await screenshot('02-phone-message.png');
  phase('deciding-native-operation-approvals');
  await adb(['shell', 'input', 'keyevent', '4']);
  await tap('Open session: Phone approvals');
  const actionPath = providerSessionId =>
    join(
      approvals.directory,
      `.nesvo-codex-action-${providerSessionId}-command.json`,
    );
  const permissionIds = [];
  for (const [button, decision] of [
    ['allow-once', 'accept'],
    ['deny', 'decline'],
  ]) {
    const before = await session(approvals.id);
    await phoneSend('fixture:approve');
    const requested = await waitFor(
      () => session(approvals.id),
      value =>
        value.runId !== before.runId && value.pendingApprovals.length === 1,
      'Phone approval request missing',
    );
    const request = requested.pendingApprovals[0];
    permissionIds.push(request.id);
    await scrollTo(button);
    await screenshot(`03-${decision}.png`);
    await tapInList(button);
    const result = await waitState(approvals.id, 'completed');
    assert.equal(result.runId, requested.runId);
    assert.deepEqual(result.pendingApprovals, []);
    assert.ok(
      result.messages
        .at(-1)
        .body.includes(decision === 'accept' ? 'accepted' : 'declined'),
    );
    if (decision === 'accept') {
      const operation = JSON.parse(
        await readFile(actionPath(result.providerSessionId), 'utf8'),
      );
      assert.ok(request.id.endsWith(operation.requestId));
      assert.equal(operation.decision, 'accept');
      await rm(actionPath(result.providerSessionId));
    } else {
      await assert.rejects(readFile(actionPath(result.providerSessionId)), {
        code: 'ENOENT',
      });
    }
  }
  await adb(['shell', 'input', 'keyevent', '4']);
  await tap('Open session: Phone workers');
  phase('deciding-native-worker-proposals');
  await phoneSend('fixture:delegate');
  const plan = await waitFor(
    () => session(workers.id),
    value => value.delegations.length === 2,
    'Phone worker proposals missing',
  );
  assert.equal(
    (await sessions()).filter(value => value.parentId === workers.id).length,
    0,
  );
  const first = plan.delegations.find(
    value => value.title === 'Fixture worker A',
  );
  const second = plan.delegations.find(
    value => value.title === 'Fixture worker B',
  );
  await tapInList(`decline-worker-${second.id}`);
  await waitFor(
    () => session(workers.id),
    value =>
      value.delegations.find(value => value.id === second.id)?.status ===
      'declined',
    'Native worker decline did not reach its exact parent',
  );
  await tapInList(`approve-worker-${first.id}`);
  const group = await waitState(workers.id, 'completed');
  assert.equal(
    group.delegations.find(value => value.id === second.id).status,
    'declined',
  );
  const completedProposal = group.delegations.find(
    value => value.id === first.id,
  );
  assert.equal(completedProposal.status, 'completed');
  const child = await session(completedProposal.childSessionId);
  assert.equal(child.parentId, workers.id);
  assert.equal(child.parentRunId, plan.runId);
  assert.ok(group.messages.at(-1).body.includes(child.messages.at(-1).body));
  await node('send-message', { enabled: false });
  await screenshot('04-worker-decision.png');
  phase('reconnecting-active-run');
  await adb(['shell', 'input', 'keyevent', '4']);
  await tap('Open session: Phone conversation');
  await phoneSend('fixture:hold');
  const active = await waitFor(
    () => session(conversation.id),
    value =>
      value.status === 'running' &&
      value.runId !== phoneReply.runId &&
      value.messages.at(-1).body.includes('is waiting.'),
    'Phone hold did not start',
  );
  await node(`message-${active.messages.at(-1).id}`);
  await node('Codex fixture is waiting.', { includes: true });
  assert.equal((await session(conversation.id)).status, 'running');
  assert.equal((await session(conversation.id)).runId, active.runId);
  const pids = JSON.parse(
    await readFile(join(directory, 'codex-pids.json'), 'utf8'),
  );
  const beforeDisconnect = await turns();
  await page.evaluate(() => window.nesvo.disableMobile());
  await scrollTo('Reconnect', 'up');
  await node('Reconnect');
  assert.equal((await session(conversation.id)).runId, active.runId);
  assert.equal((await session(conversation.id)).status, 'running');
  for (const pid of [pids.pid, pids.childPid])
    assert.doesNotThrow(
      () => process.kill(pid, 0),
      'Gateway disconnect stopped an owned provider process',
    );
  await screenshot('05-offline.png');
  const enabled = await page.evaluate(() => window.nesvo.enableMobile());
  assert.equal(enabled.url, gateway.url);
  const reconnect = listTarget(await hierarchy(), 'Reconnect');
  if (reconnect) await tapTarget(reconnect, 'Reconnect');
  await waitFor(
    () => page.evaluate(() => window.nesvo.mobileStatus()),
    value => value.clients === 1,
    'Android did not reconnect to the restored gateway',
  );
  await node('Stop');
  assert.deepEqual(await turns(), beforeDisconnect);
  assert.equal(
    (await session(conversation.id)).providerSessionId,
    active.providerSessionId,
  );
  await tap('Stop');
  const stopped = await waitState(conversation.id, 'stopped');
  assert.equal(stopped.runId, active.runId);
  assert.equal(stopped.messages.at(-1).state, 'stopped');
  await waitFor(
    async () =>
      [pids.pid, pids.childPid].map(pid => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }),
    values => values.every(value => !value),
    'Mobile Stop left an owned provider process alive',
  );
  await scrollTo(`message-${stopped.messages.at(-1).id}`, 'down', {
    readOnly: true,
  });
  await node(`message-${stopped.messages.at(-1).id}`);
  await node('Stopped after', { includes: true });
  await screenshot('06-stopped.png');
  phase('restoring-native-secure-store');
  const beforeReopen = await sessions();
  const turnsBeforeReopen = await turns();
  await adb(['shell', 'am', 'force-stop', appPackage]);
  await waitFor(
    () => page.evaluate(() => window.nesvo.mobileStatus()),
    value => value.clients === 0,
    'Stopped Android app retained a gateway connection',
  );
  await launchApplication();
  await tap('Connections');
  await scrollTo(`connection-${gateway.serverId}`);
  await node(`connection-${gateway.serverId}`);
  await screenshot('07-saved-connection.png');
  await tapInList(`connection-${gateway.serverId}`);
  await node('Open computer: Local');
  await waitFor(
    () => page.evaluate(() => window.nesvo.mobileStatus()),
    value => value.clients === 1,
    'Saved Android credentials did not reconnect',
  );
  assert.deepEqual(await sessions(), beforeReopen);
  assert.deepEqual(await turns(), turnsBeforeReopen);
  phase('revoking-paired-device');
  await page.getByRole('button', { name: 'Phone access', exact: true }).click();
  await access
    .getByRole('button', { name: `Revoke ${device.name}`, exact: true })
    .click();
  await node('Revoked');
  const revoked = await page.evaluate(() => window.nesvo.mobileStatus());
  assert.deepEqual(revoked.devices, []);
  assert.equal(revoked.clients, 0);
  assert.deepEqual(await turns(), turnsBeforeReopen);
  await access.getByText('No paired devices yet.', { exact: true }).waitFor();
  await desktopScreenshot('desktop-revoked-device.png');
  await screenshot('08-revoked.png');
  await tap('Connections');
  await tapInList(`forget-${device.id}`);
  await waitFor(
    hierarchy,
    values =>
      !findNode(values, `connection-${gateway.serverId}`, { enabled: false }),
    'Revoked fixture connection was not removed',
  );
  assert.deepEqual(pageErrors, []);
  evidence = {
    result: 'passed',
    surface: 'Android emulator native UI and isolated Electron',
    client,
    appPackage,
    serial,
    android: (
      await adb(['shell', 'getprop', 'ro.build.version.release'])
    ).stdout
      .toString('utf8')
      .trim(),
    serverId: gateway.serverId,
    deviceId: device.id,
    hostId: 'local',
    sessionId: conversation.id,
    providerSessionId: stopped.providerSessionId,
    runId: stopped.runId,
    finalConversationStatus: stopped.status,
    approvalSessionId: approvals.id,
    approvalIds: permissionIds,
    workerParentId: workers.id,
    workerRunId: plan.runId,
    childSessionId: child.id,
    workerStatus: group.status,
    nativeTurnCount: turnsBeforeReopen.length,
    nativePartialRendered: true,
    fixtureProviders: true,
    sameProviderThread: true,
    reconnectWithoutReplay: true,
    hostWorkSurvivedDisconnect: true,
    secureStoreAfterForceStop: true,
    revokedDeviceDisconnected: true,
  };
} catch (error) {
  failure = error;
  if (page && screenshotDirectory) {
    await (async () => {
      const sessions = await page.evaluate(() =>
        window.nesvo.listSessions('local'),
      );
      const processes = JSON.parse(
        await readFile(join(directory, 'processes.json'), 'utf8'),
      );
      await mkdir(screenshotDirectory, { recursive: true });
      await writeFile(
        join(screenshotDirectory, 'failure-state.json'),
        JSON.stringify(
          {
            client,
            foreground: await foregroundActivity().catch(() => null),
            processes,
            sessions: sessions.map(value => ({
              id: value.id,
              hostId: value.hostId,
              runId: value.runId,
              status: value.status,
              error: value.error,
              providerSessionId: value.providerSessionId,
              providerInitialized: value.providerInitialized,
              revision: value.revision,
              pendingApprovalIds: value.pendingApprovals.map(value => value.id),
              delegations: value.delegations.map(value => ({
                id: value.id,
                runId: value.runId,
                status: value.status,
                childSessionId: value.childSessionId,
              })),
              lastMessage: value.messages.at(-1)
                ? {
                    id: value.messages.at(-1).id,
                    state: value.messages.at(-1).state,
                    body: value.messages.at(-1).body.slice(0, 300),
                  }
                : null,
            })),
          },
          null,
          2,
        ),
      );
    })().catch(() => {});
  }
  await screenshot('failure.png').catch(() => {});
} finally {
  const errors = [];
  const attempt = async operation => {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  };
  await attempt(() => application?.close());
  for (const name of reversed)
    await attempt(() => adb(['reverse', '--remove', name]));
  await attempt(() =>
    adb(['shell', 'rm', '-f', hierarchyPath], { allowFailure: true }),
  );
  await attempt(async () => {
    assert.equal(await realpath(directory), directory);
    assert.equal((await lstat(directory)).isSymbolicLink(), false);
    assert.equal(dirname(directory), temporaryRoot);
    assert.ok(basename(directory).startsWith('nesvo-mobile-'));
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  if (failure || errors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      'Mobile smoke failed or owned cleanup was incomplete',
    );
}
evidence.cleanupCompleted = true;
if (screenshotDirectory)
  await writeFile(
    join(screenshotDirectory, 'fixture-result.json'),
    JSON.stringify(evidence, null, 2),
  );
console.log(JSON.stringify(evidence));
