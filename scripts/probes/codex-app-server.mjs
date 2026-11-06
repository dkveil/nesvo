import { createRecorder, fixturePath, killTree, parseArgs, repoRoot, spawnJsonLines, withTimeout } from './lib.mjs';

const options = parseArgs(process.argv.slice(2));
const CLIENT_INFO = { name: 'nesvo-probe', title: 'Nesvo probe', version: '0.0.0' };

const approvalResponse = (method, params) => {
  if (method === 'item/permissions/requestApproval') return { permissions: params.permissions ?? {}, scope: 'turn' };
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'accept' };
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') return { decision: 'approved' };
  return null;
};

const openSession = () => {
  const recorder = createRecorder();
  const pending = new Map();
  const waiters = [];
  let nextId = 1;
  const proc = spawnJsonLines('codex', ['app-server'], {
    cwd: repoRoot,
    onMessage: (message) => {
      recorder.record('in', message);
      if (message.id != null && message.method) {
        const result = approvalResponse(message.method, message.params ?? {});
        if (result) {
          const response = { id: message.id, result };
          recorder.record('out', response);
          proc.send(response);
        }
        return;
      }
      if (message.id != null && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
        return;
      }
      waiters.filter((waiter) => waiter.method === message.method).forEach((waiter) => waiter.resolve(message));
    },
  });
  const request = (method, params) =>
    withTimeout(
      new Promise((resolveRequest) => {
        const id = nextId++;
        pending.set(id, resolveRequest);
        const payload = { id, method, params };
        recorder.record('out', payload);
        proc.send(payload);
      }),
      options.timeoutMs,
      method,
    );
  const notify = (method, params) => {
    const payload = params ? { method, params } : { method };
    recorder.record('out', payload);
    proc.send(payload);
  };
  const waitFor = (method) =>
    withTimeout(new Promise((resolveWait) => waiters.push({ method, resolve: resolveWait })), options.timeoutMs, method);
  const close = () => {
    proc.child.stdin.end();
    killTree(proc.child);
  };
  return { recorder, request, notify, waitFor, close, stderr: proc.stderr };
};

const startTurn = async (session, threadId, text) => {
  const completed = session.waitFor('turn/completed');
  await session.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
  return completed;
};

const first = openSession();
let threadId;
try {
  await first.request('initialize', { clientInfo: CLIENT_INFO });
  first.notify('initialized');
  const started = await first.request('thread/start', { cwd: repoRoot, approvalPolicy: 'untrusted' });
  threadId = started.result?.thread?.id;
  if (!threadId) throw new Error(`no thread id: ${JSON.stringify(started)}`);
  await first.request('skills/list', { cwds: [repoRoot] });
  await startTurn(first, threadId, 'Run the shell command `echo nesvo-probe` and then reply with one short sentence confirming the output.');
} finally {
  first.recorder.save(fixturePath('codex', options.os, 'session.jsonl'));
  first.close();
}
console.log(`thread ${threadId}, ${first.recorder.entries.length} entries`);

const second = openSession();
try {
  await second.request('initialize', { clientInfo: CLIENT_INFO });
  second.notify('initialized');
  await second.request('thread/resume', { threadId, cwd: repoRoot, approvalPolicy: 'untrusted' });
  await startTurn(second, threadId, 'Which command did you run earlier? Answer in one short sentence.');
} finally {
  second.recorder.save(fixturePath('codex', options.os, 'resume.jsonl'));
  second.close();
}
console.log(`resume ${second.recorder.entries.length} entries`);
process.exit(0);
