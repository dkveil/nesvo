import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helpers = join(repository, 'scripts', 'remote-smoke');
const temporaryRoot = await realpath(tmpdir());
const directory = await realpath(
  await mkdtemp(join(temporaryRoot, 'nesvo-remote-')),
);
const profile = join(directory, 'profile');
const sshDirectory = join(profile, 'SSH profile');
const identityFile = join(sshDirectory, 'identity_ed25519');
const knownHostsFile = join(sshDirectory, 'known_hosts');
const runId = randomUUID();
const image = `nesvo-remote-smoke:${runId}`;
const name = `nesvo-remote-${runId}`;
const screenshotDirectory = process.env.NESVO_REMOTE_SCREENSHOTS;
const requireDesktop = createRequire(
  join(repository, 'apps', 'desktop', 'package.json'),
);
const executablePath =
  process.env.NESVO_PACKAGED_EXECUTABLE || requireDesktop('electron');
let application;
let page;
let container;
let imageBuilt = false;
let remoteId;
let remoteHealth;
let failure;
let evidence;
const pageErrors = [];

function bounded(operation, description, milliseconds = 20_000) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function command(
  binary,
  args,
  { input, timeout = 30_000, allowFailure = false } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: repository,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', value => {
      stdout = (stdout + value).slice(-2_000_000);
    });
    child.stderr.on('data', value => {
      stderr = (stderr + value).slice(-2_000_000);
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
            `${binary} ${args[0]} failed (${code ?? signal}): ${stderr || stdout}`,
          ),
        );
      else resolve({ code, signal, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const docker = (args, options) => command('docker', args, options);
const remoteNode = async (code, args = []) => {
  const result = await docker([
    'exec',
    '--user',
    '1000:1000',
    container,
    'node',
    '-e',
    code,
    ...args,
  ]);
  return result.stdout.trim();
};
const remoteJson = async (code, args) =>
  JSON.parse(await remoteNode(code, args));
const remoteTurns = () =>
  remoteJson(
    "const f=require('node:fs');const p='/var/lib/nesvo/turns.jsonl';console.log(JSON.stringify(f.existsSync(p)?f.readFileSync(p,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[]))",
  );
const remotePids = () =>
  remoteJson(
    "console.log(require('node:fs').readFileSync('/var/lib/nesvo/codex-pids.json','utf8'))",
  );
const remoteActors = pids =>
  remoteJson(
    "const f=require('node:fs');console.log(JSON.stringify(JSON.parse(process.argv[1]).map(pid=>{try{process.kill(pid,0);return f.readFileSync('/proc/'+pid+'/environ','utf8').split('\\0').includes('NESVO_DATA_DIR=/var/lib/nesvo')}catch{return false}})))",
    [JSON.stringify(pids)],
  );
const hostSnapshot = hostId =>
  page.evaluate(
    async hostId => ({
      sessions: await window.nesvo.listSessions(hostId),
      reviews: await window.nesvo.listReviews(hostId),
    }),
    hostId,
  );
const session = async (hostId, id) =>
  (await hostSnapshot(hostId)).sessions.find(value => value.id === id);
const review = async (hostId, id) =>
  (await hostSnapshot(hostId)).reviews.find(value => value.id === id);
const byId = values =>
  values.toSorted((left, right) => left.id.localeCompare(right.id));

async function waitFor(read, predicate, description, milliseconds = 20_000) {
  const deadline = Date.now() + milliseconds;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await delay(80);
  }
  assert.fail(`${description}: ${JSON.stringify(value)}`);
}

const waitState = (hostId, id, status) =>
  waitFor(
    () => session(hostId, id),
    value => value?.status === status,
    `Session ${hostId}/${id} expected ${status}`,
  );
const waitApproval = (hostId, id, runId) =>
  waitFor(
    () => session(hostId, id),
    value => value?.runId === runId && value.pendingApprovals.length === 1,
    'Operation approval missing',
  );
const waitReview = (hostId, runId) =>
  waitFor(
    () => hostSnapshot(hostId),
    value =>
      value.reviews.some(
        review => review.runId === runId && review.status === 'pending',
      ),
    'Pending review missing',
  ).then(value => value.reviews.find(review => review.runId === runId));
const send = (hostId, sessionId, text, messageId = randomUUID()) =>
  page.evaluate(
    ({ hostId, input }) => window.nesvo.sendMessage(input, hostId),
    { hostId, input: { sessionId, messageId, text } },
  );
const create = (hostId, title, mode = 'read-only') =>
  page.evaluate(
    ({ hostId, input }) => window.nesvo.createSession(input, hostId),
    {
      hostId,
      input: {
        title,
        provider: 'Codex',
        model: 'fixture-codex',
        mode,
        directory: '',
      },
    },
  );
const computers = () => page.evaluate(() => window.nesvo.listComputers());
const computer = async id => (await computers()).find(value => value.id === id);

async function connectRemote() {
  const connected = await page.evaluate(
    id => window.nesvo.connectComputer(id),
    remoteId,
  );
  assert.equal(connected.status, 'connected');
  assert.equal(connected.instanceId, remoteHealth.instanceId);
  return connected;
}

async function disconnectRemote() {
  const disconnected = await page.evaluate(
    id => window.nesvo.disconnectComputer(id),
    remoteId,
  );
  assert.equal(disconnected.status, 'disconnected');
}

async function selectSession(hostId, sessionId) {
  await page
    .locator(`button[data-host-id="${hostId}"][data-session-id="${sessionId}"]`)
    .click();
  await page
    .getByRole('region', { name: 'Conversation', exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole('region', { name: 'Conversation', exact: true })
      .getAttribute('data-host-id'),
    hostId,
  );
}

const inboxRow = (label, hostId) =>
  page
    .getByRole('article', { name: label, exact: true })
    .and(page.locator(`[data-host-id="${hostId}"]`));
const openInbox = async () => {
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await page.getByRole('region', { name: 'Inbox', exact: true }).waitFor();
};

async function screenshot(filename) {
  if (!screenshotDirectory) return;
  await page.evaluate(
    () =>
      new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await delay(100);
  await mkdir(screenshotDirectory, { recursive: true });
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

async function remoteBridge(request) {
  return remoteJson(
    "const {spawn}=require('node:child_process');const {createInterface}=require('node:readline');const request=JSON.parse(process.argv[1]);const child=spawn(process.execPath,['/workspace/apps/host/dist/main.js','connect'],{env:{...process.env,NESVO_RUNTIME_DIR:'/run/nesvo-host'}});let result;let errors='';const timer=setTimeout(()=>{child.kill();process.exitCode=1},10000);child.stderr.on('data',chunk=>errors+=chunk);createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line);if(message.type==='connected')child.stdin.write(JSON.stringify(request)+'\\n');else if(message.id===request.id){result=message;child.stdin.end()}});child.on('close',code=>{clearTimeout(timer);if(code!==0||!result){console.error(errors||'Remote bridge did not return a response');process.exitCode=1}else console.log(JSON.stringify(result))})",
    [JSON.stringify({ ...request, id: randomUUID() })],
  );
}

async function launchApplication() {
  const env = {
    ...process.env,
    NESVO_SMOKE_TEST: '1',
    NESVO_DATA_DIR: profile,
    NESVO_TEST_PID_FILE: join(profile, 'processes.json'),
    NESVO_CLAUDE_EXECUTABLE: join(
      repository,
      'apps',
      'host',
      'tests',
      'claude-fixture.mjs',
    ),
    NESVO_CODEX_EXECUTABLE: join(
      repository,
      'apps',
      'host',
      'tests',
      'codex-fixture.mjs',
    ),
    NESVO_FIXTURE_PID_FILE: join(profile, 'claude-pids.json'),
    NESVO_CODEX_FIXTURE_PID_FILE: join(profile, 'codex-pids.json'),
    NESVO_CODEX_FIXTURE_PID_DIR: join(profile, 'worker-pids'),
    NESVO_CODEX_FIXTURE_STATE_DIR: join(profile, 'codex-state'),
    CLAUDE_CONFIG_DIR: join(profile, 'claude-config'),
    CODEX_HOME: join(profile, 'codex-config'),
    NESVO_TEST_SKILLS_HOME: join(profile, 'skills-home'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath,
    args: process.env.NESVO_PACKAGED_EXECUTABLE
      ? []
      : [join(repository, 'apps', 'desktop')],
    env,
    timeout: 30_000,
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Computers', exact: true }).waitFor();
  await waitFor(
    () => computer('local'),
    value => value?.status === 'connected',
    'Local host did not connect',
  );
}

async function verifyServiceUnit() {
  const paths = await remoteJson(
    `const f=require('node:fs');const p='/home/node/unit path % $ "quote"';const n='/home/node/node path % $';f.mkdirSync(p,{recursive:true});f.mkdirSync(n,{recursive:true});const node=n+'/node % $ executable';const invalidNode=p+'/invalid-node';const entry=p+'/entry % $ "main".mjs';for(const target of[node,invalidNode]){f.copyFileSync(process.execPath,target);f.chmodSync(target,0o755)}f.symlinkSync('/workspace/apps/host/dist/main.js',entry);const slash=String.fromCharCode(92);console.log(JSON.stringify({node,invalidNode,entry,data:p+'/data'+slash+'literal',runtime:p+'/runtime'+slash+'literal',unit:p+'/nesvo-smoke.service'}))`,
  );
  const rejected = await docker(
    [
      'exec',
      '--user',
      '1000:1000',
      '-e',
      `NESVO_DATA_DIR=${paths.data}`,
      '-e',
      `NESVO_RUNTIME_DIR=${paths.runtime}`,
      container,
      paths.invalidNode,
      paths.entry,
      'service-unit',
    ],
    { allowFailure: true },
  );
  assert.equal(rejected.code, 1);
  assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /must not contain quotes or backslashes/);
  const generated = await docker([
    'exec',
    '--user',
    '1000:1000',
    '-e',
    `NESVO_DATA_DIR=${paths.data}`,
    '-e',
    `NESVO_RUNTIME_DIR=${paths.runtime}`,
    container,
    paths.node,
    paths.entry,
    'service-unit',
  ]);
  assert.match(generated.stdout, /\[Service\]/);
  assert.match(generated.stdout, /%%/);
  await docker(
    [
      'exec',
      '--user',
      '1000:1000',
      '-i',
      container,
      'node',
      '-e',
      "const f=require('node:fs');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>f.writeFileSync(process.argv[1],text))",
      paths.unit,
    ],
    { input: generated.stdout },
  );
  await docker([
    'exec',
    '--user',
    '1000:1000',
    '-e',
    'HOME=/home/node',
    '-e',
    'XDG_RUNTIME_DIR=/run/nesvo-host',
    container,
    'systemd-analyze',
    '--user',
    'verify',
    paths.unit,
  ]);
}

try {
  await mkdir(sshDirectory, { recursive: true, mode: 0o700 });
  await mkdir(join(profile, '.git'), { recursive: true });
  const localSkill = join(
    profile,
    'claude-config',
    'skills',
    'local-smoke',
    'SKILL.md',
  );
  await mkdir(dirname(localSkill), { recursive: true });
  await writeFile(
    localSkill,
    '---\nname: Local smoke instructions\ndescription: Metadata from the isolated local fixture host.\n---\nLOCAL_SMOKE_INSTRUCTIONS\n',
  );
  await command('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    'nesvo-remote-smoke',
    '-f',
    identityFile,
  ]);
  await command('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    'nesvo-wrong-host',
    '-f',
    join(sshDirectory, 'wrong_host'),
  ]);
  if (process.platform === 'win32') {
    const account = (await command('whoami.exe', [])).stdout.trim();
    await command('icacls.exe', [
      identityFile,
      '/inheritance:r',
      '/grant:r',
      `${account}:(R)`,
    ]);
  } else await chmod(identityFile, 0o600);
  await writeFile(knownHostsFile, '');
  console.log(JSON.stringify({ phase: 'building-isolated-sshd', image }));
  await docker(
    [
      'build',
      '--label',
      `nesvo.remote-smoke=${runId}`,
      '-t',
      image,
      '-f',
      join(helpers, 'Dockerfile'),
      helpers,
    ],
    { timeout: 300_000 },
  );
  imageBuilt = true;
  container = (
    await docker([
      'run',
      '-d',
      '--init',
      '--name',
      name,
      '--label',
      `nesvo.remote-smoke=${runId}`,
      '-p',
      '127.0.0.1::22',
      '--mount',
      `type=bind,src=${repository},dst=/workspace,readonly`,
      '--mount',
      `type=bind,src=${identityFile}.pub,dst=/smoke-authorized-key.pub,readonly`,
      image,
    ])
  ).stdout.trim();
  assert.match(container, /^[a-f0-9]{64}$/);
  const port = Number(
    (await docker(['port', container, '22/tcp'])).stdout
      .trim()
      .match(/^127\.0\.0\.1:(\d+)$/)?.[1],
  );
  assert.ok(Number.isInteger(port) && port > 0 && port !== 8789);
  remoteHealth = await waitFor(
    async () => {
      const logs = await docker(['logs', container]);
      for (const line of (logs.stdout + '\n' + logs.stderr).split('\n')) {
        try {
          const message = JSON.parse(line);
          if (message.type === 'daemon-ready') return message.health;
        } catch {}
      }
      return null;
    },
    value => value?.status === 'ready',
    'Container daemon did not become ready',
    30_000,
  );
  await waitFor(
    () =>
      new Promise(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port });
        const finish = value => {
          socket.destroy();
          resolve(value);
        };
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.setTimeout(300, () => finish(false));
      }),
    Boolean,
    'Owned SSH port did not listen',
  );
  const ownership = await remoteJson(
    "const f=require('node:fs');const pid=Number(f.readFileSync('/run/nesvo-daemon.pid','utf8'));console.log(JSON.stringify({pid,uid:Number(/^Uid:\\s+(\\d+)/m.exec(f.readFileSync('/proc/'+pid+'/status','utf8'))[1])}))",
  );
  assert.equal(ownership.uid, 1000);
  await verifyServiceUnit();
  const publicHostKey = (
    await docker(['exec', container, 'cat', '/run/ssh-host/host_ed25519.pub'])
  ).stdout
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  const correctHostRecord = `[127.0.0.1]:${port} ${publicHostKey}\n`;
  const wrongPublicKey = (
    await readFile(join(sshDirectory, 'wrong_host.pub'), 'utf8')
  )
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  await launchApplication();
  assert.deepEqual(
    (await computers()).map(value => value.id),
    ['local'],
  );
  const target = {
    name: 'Isolated SSH host',
    hostname: '127.0.0.1',
    username: 'node',
    port,
    identityFile,
    knownHostsFile,
    entryPath: '/workspace/apps/host/dist/main.js',
    runtimeDirectory: '/run/nesvo-host',
  };
  const remote = await page.evaluate(
    input => window.nesvo.addComputer(input),
    target,
  );
  remoteId = remote.id;
  assert.equal(remote.kind, 'ssh');
  await assert.rejects(
    page.evaluate(id => window.nesvo.connectComputer(id), remoteId),
    /host key|host identification|known_hosts/i,
  );
  assert.equal((await computer(remoteId)).status, 'error');
  assert.equal(await readFile(knownHostsFile, 'utf8'), '');
  await writeFile(knownHostsFile, correctHostRecord);
  await connectRemote();
  const localUsage = await page.evaluate(() =>
    window.nesvo.providerUsage({ provider: 'Codex' }),
  );
  const remoteUsage = await page.evaluate(
    hostId => window.nesvo.providerUsage({ provider: 'Codex' }, hostId),
    remoteId,
  );
  assert.equal(localUsage.status, 'ready');
  assert.deepEqual(
    localUsage.windows.map(window => window.usedPercent),
    [25, 40],
  );
  assert.equal(remoteUsage.status, 'unavailable');
  assert.deepEqual(remoteUsage.windows, []);
  assert.ok(remoteUsage.detail);
  for (const usage of [localUsage, remoteUsage]) {
    assert.equal(usage.provider, 'Codex');
    assert.equal(usage.source, 'codex-app-server');
    assert.deepEqual(usage.account, {
      label: 'fixture@example.invalid',
      plan: 'plus',
    });
  }
  assert.deepEqual(await remoteTurns(), []);
  await disconnectRemote();
  await assert.rejects(
    page.evaluate(
      hostId => window.nesvo.providerUsage({ provider: 'Codex' }, hostId),
      remoteId,
    ),
    /connect|offline|disconnected/i,
  );
  assert.equal((await computer(remoteId)).status, 'disconnected');
  assert.deepEqual(
    await page.evaluate(() =>
      window.nesvo.providerUsage({ provider: 'Codex' }),
    ),
    localUsage,
  );
  await writeFile(knownHostsFile, `[127.0.0.1]:${port} ${wrongPublicKey}\n`);
  await assert.rejects(
    page.evaluate(id => window.nesvo.connectComputer(id), remoteId),
    /host key|host identification|known_hosts/i,
  );
  assert.equal((await computer(remoteId)).status, 'error');
  assert.equal((await computer(remoteId)).instanceId, remoteHealth.instanceId);
  assert.equal(
    await readFile(knownHostsFile, 'utf8'),
    `[127.0.0.1]:${port} ${wrongPublicKey}\n`,
  );
  await writeFile(knownHostsFile, correctHostRecord);
  await connectRemote();
  await page.getByRole('button', { name: 'Computers', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Computers', exact: true })
    .getByRole('region', { name: 'Computer: Isolated SSH host', exact: true })
    .waitFor();
  await screenshot('01-computers.png');
  await page.keyboard.press('Escape');

  const title = 'Two-host review';
  const parent = await create(remoteId, title);
  assert.equal(parent.hostId, remoteId);
  await remoteNode(
    "require('node:fs').mkdirSync(process.argv[1]+'/.git',{recursive:true});require('node:fs').writeFileSync(process.argv[1]+'/target.txt','Remote workspace fixture.\\n')",
    [parent.directory],
  );
  const parentRun = await send(
    remoteId,
    parent.id,
    'fixture:delegate-two-hold',
  );
  const plan = await waitFor(
    () => session(remoteId, parent.id),
    value => value?.runId === parentRun.runId && value.delegations.length === 2,
    'Remote worker proposals missing',
  );
  await page.evaluate(
    ({ hostId, input }) => window.nesvo.decideDelegation(input, hostId),
    {
      hostId: remoteId,
      input: {
        sessionId: parent.id,
        runId: plan.runId,
        delegationId: plan.delegations[0].id,
        decision: 'accept',
      },
    },
  );
  const worker = await waitFor(
    () => hostSnapshot(remoteId),
    value =>
      value.sessions.some(
        session =>
          session.parentId === parent.id &&
          session.status === 'running' &&
          session.messages.at(-1)?.body.includes('is waiting.'),
      ),
    'Remote worker did not start',
  ).then(value =>
    value.sessions.find(
      session => session.parentId === parent.id && session.status === 'running',
    ),
  );
  const workerPids = await remotePids();
  assert.equal(workerPids.sessionId, worker.providerSessionId);
  const workerTurns = await remoteTurns();
  await disconnectRemote();
  assert.equal((await computer('local')).status, 'connected');
  assert.deepEqual(await remoteActors([workerPids.pid, workerPids.childPid]), [
    true,
    true,
  ]);
  const local = await create('local', title);
  await mkdir(join(local.directory, '.git'), { recursive: true });
  await writeFile(
    join(local.directory, 'target.txt'),
    'Local workspace fixture.\n',
  );
  await send('local', local.id, 'fixture:stream');
  await waitState('local', local.id, 'completed');
  const localReview = await waitReview(
    'local',
    (await session('local', local.id)).runId,
  );
  assert.equal(localReview.hostId, 'local');
  await connectRemote();
  const reconnectedWorker = await session(remoteId, worker.id);
  for (const key of [
    'id',
    'runId',
    'providerSessionId',
    'parentId',
    'parentRunId',
  ])
    assert.equal(reconnectedWorker[key], worker[key]);
  assert.equal(reconnectedWorker.status, 'running');
  assert.deepEqual(await remoteTurns(), workerTurns);
  await disconnectRemote();
  const detachedWorker = await session(remoteId, worker.id);
  assert.equal(detachedWorker.status, 'running');
  const stoppedResponse = await remoteBridge({
    method: 'stop-run',
    input: { sessionId: worker.id, runId: worker.runId },
  });
  assert.equal(stoppedResponse.type, 'session');
  const authoritativeWorker = await waitFor(
    () => remoteBridge({ method: 'list-sessions' }),
    value =>
      value.type === 'sessions' &&
      value.sessions.some(
        session => session.id === worker.id && session.status === 'stopped',
      ),
    'Detached worker did not stop through the independent bridge',
  ).then(value => value.sessions.find(session => session.id === worker.id));
  assert.ok(authoritativeWorker.revision > detachedWorker.revision);
  assert.deepEqual(await session(remoteId, worker.id), detachedWorker);
  assert.equal((await computer(remoteId)).status, 'disconnected');
  await connectRemote();
  const caughtUpWorker = await session(remoteId, worker.id);
  assert.equal(caughtUpWorker.id, authoritativeWorker.id);
  assert.equal(caughtUpWorker.runId, authoritativeWorker.runId);
  assert.equal(
    caughtUpWorker.providerSessionId,
    authoritativeWorker.providerSessionId,
  );
  assert.equal(caughtUpWorker.revision, authoritativeWorker.revision);
  assert.equal(caughtUpWorker.status, 'stopped');
  assert.deepEqual(caughtUpWorker.messages, authoritativeWorker.messages);
  assert.deepEqual(await remoteTurns(), workerTurns);
  await waitFor(
    () => remoteActors([workerPids.pid, workerPids.childPid]),
    values => values.every(value => !value),
    'Remote worker descendants survived Stop',
  );
  await page.evaluate(
    ({ hostId, input }) => window.nesvo.decideDelegation(input, hostId),
    {
      hostId: remoteId,
      input: {
        sessionId: parent.id,
        runId: plan.runId,
        delegationId: plan.delegations[1].id,
        decision: 'decline',
      },
    },
  );
  await waitState(remoteId, parent.id, 'completed');
  const parentReview = await waitReview(remoteId, plan.runId);
  assert.equal(parentReview.hostId, remoteId);
  const aggregate = await page.evaluate(() => window.nesvo.listSessions());
  assert.equal(
    aggregate.filter(
      session =>
        session.title === title && ['local', remoteId].includes(session.hostId),
    ).length,
    2,
  );
  await selectSession(remoteId, parent.id);
  await page
    .getByRole('button', { name: 'New session', exact: true })
    .first()
    .click();
  assert.equal(
    (
      await page
        .getByRole('dialog', { name: 'New session', exact: true })
        .getByRole('combobox', { name: 'Computer', exact: true })
        .innerText()
    ).trim(),
    'Local',
  );
  await page.keyboard.press('Escape');
  const reads = await page.evaluate(
    async ({ localId, remoteId, localSessionId, remoteSessionId }) => ({
      local: await window.nesvo.readWorkspaceFile(
        { sessionId: localSessionId, path: 'target.txt' },
        localId,
      ),
      remote: await window.nesvo.readWorkspaceFile(
        { sessionId: remoteSessionId, path: 'target.txt' },
        remoteId,
      ),
      localSkills: await window.nesvo.discoverSkills(
        { sessionId: localSessionId },
        localId,
      ),
      remoteSkills: await window.nesvo.discoverSkills(
        { sessionId: remoteSessionId },
        remoteId,
      ),
    }),
    {
      localId: 'local',
      remoteId,
      localSessionId: local.id,
      remoteSessionId: parent.id,
    },
  );
  assert.equal(reads.local.text, 'Local workspace fixture.\n');
  assert.equal(reads.remote.text, 'Remote workspace fixture.\n');
  assert.ok(
    reads.localSkills.skills.some(
      skill => skill.name === 'Local smoke instructions',
    ),
  );
  assert.equal(
    reads.localSkills.skills.some(
      skill => skill.name === 'Remote smoke instructions',
    ),
    false,
  );
  assert.ok(
    reads.remoteSkills.skills.some(
      skill => skill.name === 'Remote smoke instructions',
    ),
  );
  assert.equal(
    reads.remoteSkills.skills.some(
      skill => skill.name === 'Local smoke instructions',
    ),
    false,
  );
  await assert.rejects(
    page.evaluate(input => window.nesvo.readWorkspaceFile(input, 'local'), {
      sessionId: parent.id,
      path: 'target.txt',
    }),
  );
  await page.getByRole('button', { name: 'Open files', exact: true }).click();
  const files = page.getByRole('region', {
    name: 'Workspace files',
    exact: true,
  });
  await files
    .getByRole('button', { name: 'Open file target.txt', exact: true })
    .click();
  await files
    .getByRole('region', { name: 'File preview', exact: true })
    .locator('[data-line]')
    .filter({ hasText: 'Remote workspace fixture.' })
    .first()
    .waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open skills', exact: true }).click();
  const skills = page.getByRole('region', {
    name: 'Session skills',
    exact: true,
  });
  await skills
    .getByLabel('Details for Remote smoke instructions', { exact: true })
    .waitFor();
  assert.equal(
    await skills
      .getByLabel('Details for Local smoke instructions', { exact: true })
      .count(),
    0,
  );
  await page.keyboard.press('Escape');

  const operation = await create(remoteId, 'SSH operation', 'supervised');
  const operationRun = await send(
    remoteId,
    operation.id,
    'fixture:approval-hold',
  );
  const operationPending = await waitApproval(
    remoteId,
    operation.id,
    operationRun.runId,
  );
  const operationPids = await remotePids();
  await disconnectRemote();
  assert.deepEqual(
    await remoteActors([operationPids.pid, operationPids.childPid]),
    [true, true],
  );
  await connectRemote();
  assert.deepEqual(
    (await session(remoteId, operation.id)).pendingApprovals,
    operationPending.pendingApprovals,
  );
  await selectSession('local', local.id);
  const localBeforeDecision = await hostSnapshot('local');
  await openInbox();
  const operationRow = inboxRow('Operation approval: SSH operation', remoteId);
  await operationRow.waitFor();
  await screenshot('02-host-scoped-inbox.png');
  await operationRow.getByRole('button', { name: 'Deny', exact: true }).click();
  await waitState(remoteId, operation.id, 'completed');
  await waitFor(
    () => remoteActors([operationPids.pid, operationPids.childPid]),
    values => values.every(value => !value),
    'Approval descendants survived denial',
  );
  await inboxRow(
    `Review result: ${title}, version ${parentReview.version}`,
    remoteId,
  )
    .getByRole('button', { name: 'Accept result', exact: true })
    .click();
  const acceptedRemote = await waitFor(
    () => review(remoteId, parentReview.id),
    value => value?.status === 'accepted',
    'Remote result was not accepted',
  );
  assert.deepEqual(
    byId((await hostSnapshot('local')).sessions),
    byId(localBeforeDecision.sessions),
  );
  assert.deepEqual(
    byId((await hostSnapshot('local')).reviews),
    byId(localBeforeDecision.reviews),
  );
  assert.equal((await review('local', localReview.id)).status, 'pending');

  const pendingRun = await send(
    remoteId,
    operation.id,
    'fixture:approval-hold',
  );
  const pendingBeforeClose = await waitApproval(
    remoteId,
    operation.id,
    pendingRun.runId,
  );
  const persistentPids = await remotePids();
  const turnsBeforeClose = await remoteTurns();
  await application.close();
  application = undefined;
  assert.deepEqual(
    await remoteActors([persistentPids.pid, persistentPids.childPid]),
    [true, true],
  );
  await launchApplication();
  const cachedComputer = await computer(remoteId);
  assert.equal(cachedComputer.status, 'disconnected');
  assert.equal(cachedComputer.instanceId, remoteHealth.instanceId);
  assert.deepEqual(cachedComputer.ssh, target);
  const cachedPending = await session(remoteId, operation.id);
  assert.equal(cachedPending.runId, pendingBeforeClose.runId);
  assert.deepEqual(
    cachedPending.pendingApprovals,
    pendingBeforeClose.pendingApprovals,
  );
  assert.equal((await computer(remoteId)).status, 'disconnected');
  assert.deepEqual(await remoteTurns(), turnsBeforeClose);
  assert.deepEqual(await review(remoteId, parentReview.id), acceptedRemote);
  assert.equal((await review('local', localReview.id)).status, 'pending');
  await screenshot('03-reopened-offline-cache.png');
  await connectRemote();
  const resumedPending = await session(remoteId, operation.id);
  assert.equal(
    resumedPending.providerSessionId,
    pendingBeforeClose.providerSessionId,
  );
  assert.deepEqual(
    resumedPending.pendingApprovals,
    pendingBeforeClose.pendingApprovals,
  );
  assert.deepEqual(await remoteTurns(), turnsBeforeClose);
  await page.evaluate(id => window.nesvo.removeComputer(id), remoteId);
  assert.equal(
    (await computers()).some(value => value.id === remoteId),
    false,
  );
  assert.deepEqual(
    await remoteActors([persistentPids.pid, persistentPids.childPid]),
    [true, true],
  );
  const persistedDaemon = await remoteJson(
    "const f=require('node:fs');const pid=Number(f.readFileSync('/run/nesvo-daemon.pid','utf8'));process.kill(pid,0);console.log(JSON.stringify({pid}))",
  );
  assert.equal(persistedDaemon.pid, ownership.pid);
  assert.equal(await readFile(knownHostsFile, 'utf8'), correctHostRecord);
  assert.deepEqual(pageErrors, []);
  evidence = {
    result: 'passed',
    platform: process.platform,
    transport: 'actual SSH to isolated Linux daemon',
    remoteInstanceId: remoteHealth.instanceId,
    localSessionId: local.id,
    remoteParentId: parent.id,
    remoteWorkerId: worker.id,
    acceptedReviewId: acceptedRemote.id,
    pendingApprovalId: pendingBeforeClose.pendingApprovals[0].id,
    strictHostKeys: true,
    systemdUnitVerified: true,
    noReconnectReplay: true,
    authoritativeCatchUp: true,
    hostScopedProviderUsage: true,
    offlineUsageRejected: true,
    removePreservedDaemon: true,
  };
} catch (error) {
  failure = error;
  if (page)
    console.error(
      JSON.stringify({
        computers: await computers()
          .then(values =>
            values.map(value => ({
              id: value.id,
              name: value.name,
              status: value.status,
              error: value.error,
            })),
          )
          .catch(() => null),
      }),
    );
  if (container)
    console.error(
      (
        await docker(['logs', '--tail', '15', container], {
          allowFailure: true,
        }).catch(() => ({ stderr: 'Owned container diagnostics unavailable.' }))
      ).stderr,
    );
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
  await attempt(async () => {
    if (!container) return;
    const inspected = await docker(
      [
        'inspect',
        '--format',
        '{{ index .Config.Labels "nesvo.remote-smoke" }}',
        container,
      ],
      { allowFailure: true },
    );
    if (inspected.code === 0) {
      assert.equal(inspected.stdout.trim(), runId);
      await docker(['stop', '--time', '15', container], {
        allowFailure: true,
        timeout: 25_000,
      });
      const removed = await docker(['rm', '-f', container], {
        allowFailure: true,
      });
      assert.equal(removed.code, 0, removed.stderr);
    } else if (!/No such object|No such container/i.test(inspected.stderr)) {
      throw new Error(
        `Owned container could not be inspected: ${inspected.stderr}`,
      );
    }
  });
  await attempt(async () => {
    if (!imageBuilt) return;
    const inspected = await docker(
      [
        'image',
        'inspect',
        '--format',
        '{{ index .Config.Labels "nesvo.remote-smoke" }}',
        image,
      ],
      { allowFailure: true },
    );
    if (inspected.code !== 0 && /No such image/i.test(inspected.stderr)) return;
    assert.equal(inspected.code, 0, inspected.stderr);
    assert.equal(inspected.stdout.trim(), runId);
    await docker(['image', 'rm', image]);
  });
  await attempt(async () => {
    const actual = await realpath(directory);
    assert.equal(actual, directory, 'Owned temporary directory changed');
    assert.equal((await lstat(directory)).isSymbolicLink(), false);
    assert.equal(
      dirname(actual),
      temporaryRoot,
      'Refusing a path outside the temporary root',
    );
    assert.ok(basename(actual).startsWith('nesvo-remote-'));
    await rm(actual, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  if (failure || errors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      'Remote smoke failed or owned cleanup was incomplete',
    );
}
console.log(JSON.stringify(evidence));
