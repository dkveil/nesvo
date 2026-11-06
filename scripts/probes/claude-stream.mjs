import { fileURLToPath } from 'node:url';
import { createRecorder, fixturePath, killTree, parseArgs, repoRoot, spawnJsonLines, withTimeout } from './lib.mjs';

const EXPECTED_COMMAND = 'echo nesvo-probe';
const options = parseArgs(process.argv.slice(2));
const PROBE_SETTINGS_PATH = fileURLToPath(new URL('./claude-probe-settings.json', import.meta.url));

const runTurn = async ({ prompt, resumeSessionId }) => {
  const recorder = createRecorder();
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default'];
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  args.push('--permission-prompt-tool', 'stdio', '--setting-sources', 'project', '--settings', PROBE_SETTINGS_PATH);
  let sessionId = null;
  let settle;
  const finished = new Promise((resolveFinished) => (settle = resolveFinished));
  const proc = spawnJsonLines('claude', args, {
    cwd: repoRoot,
    onMessage: (message) => {
      recorder.record('in', message);
      if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
      if (message.type === 'control_request' && message.request?.subtype === 'can_use_tool') {
        const isExpectedCall = message.request.tool_name === 'Bash' && message.request.input?.command === EXPECTED_COMMAND;
        const decision = isExpectedCall
          ? { behavior: 'allow', updatedInput: message.request.input }
          : { behavior: 'deny', message: 'probe only allows the expected echo command' };
        const response = {
          type: 'control_response',
          response: { subtype: 'success', request_id: message.request_id, response: decision },
        };
        recorder.record('out', response);
        proc.send(response);
      }
      if (message.type === 'result') settle();
    },
    onExit: settle,
  });
  const userMessage = { type: 'user', message: { role: 'user', content: prompt } };
  recorder.record('out', userMessage);
  proc.send(userMessage);
  try {
    await withTimeout(finished, options.timeoutMs, 'result');
  } finally {
    proc.child.stdin.end();
    setTimeout(() => killTree(proc.child), 3000).unref();
  }
  return { recorder, sessionId, stderr: proc.stderr() };
};

const first = await runTurn({
  prompt: 'Run the Bash command `echo nesvo-probe` and then reply with one short sentence confirming the output.',
});
first.recorder.save(fixturePath('claude', options.os, 'session.jsonl'));
console.log(`session ${first.sessionId}, ${first.recorder.entries.length} entries`);
if (!first.sessionId) throw new Error(`no session id; stderr: ${first.stderr}`);

const second = await runTurn({
  resumeSessionId: first.sessionId,
  prompt: 'Which command did you run earlier? Answer in one short sentence.',
});
second.recorder.save(fixturePath('claude', options.os, 'resume.jsonl'));
console.log(`resume ${second.sessionId}, ${second.recorder.entries.length} entries`);
process.exit(0);
