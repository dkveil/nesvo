#!/usr/bin/env node
// Controlled original-CLI fixture. It never calls a model or loads user settings.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const codex = path.basename(process.argv[1]).startsWith('codex');
if (process.argv.includes('--version')) {
  console.log(codex ? '0.156.0' : '2.1.303-scoped-fixture');
  process.exit(0);
}
const id = process.env.NESVO_SESSION_ID;
if (!/^[a-f0-9]{32}$/.test(id || '')) throw new Error('Missing fixture process identity');
const directory = process.env.NESVO_TEST_CALLERS;
const editorRedraw = fs.existsSync(path.join(process.cwd(), '.fixture-editor-redraw'));
const editorBlocked =
  editorRedraw &&
  fs.readFileSync(path.join(process.cwd(), '.fixture-editor-redraw'), 'utf8') === 'working';
if (
  !fs.readFileSync(process.env.NESVO_AGENT_SKILL, 'utf8').includes('NESVO_HARNESS_INSTRUCTIONS_V8')
)
  throw new Error('Missing versioned launch-local harness instructions');
fs.writeFileSync(path.join(directory, `${id}.txt`), process.env.NESVO_AGENT_CONTEXT);
if (process.argv.includes('--mcp-config')) {
  const config = JSON.parse(
    fs.readFileSync(process.argv[process.argv.indexOf('--mcp-config') + 1], 'utf8'),
  );
  const instruction = fs.readFileSync(
    process.argv[process.argv.indexOf('--append-system-prompt-file') + 1],
    'utf8',
  );
  if (
    config.mcpServers.nesvo.env.NESVO_AGENT_CONTEXT !== process.env.NESVO_AGENT_CONTEXT ||
    !instruction.includes('NESVO_HARNESS_INSTRUCTIONS_V8')
  )
    throw new Error('Launch-local harness was not loaded by the controlled provider');
}
const settings = codex ? null : JSON.parse(process.argv[process.argv.indexOf('--settings') + 1]);
// The fixture consumes only the host's bounded literal inline shape, not arbitrary TOML.
const codexHook = codex
  ? JSON.parse(process.argv[process.argv.indexOf('-c') + 1].match(/command=("(?:[^"\\]|\\.)*")/)[1])
  : null;
if (codex && !process.argv.includes('--no-daemon'))
  throw new Error('Codex must own its local executor');
let turn = 0;
function hook(name, extra = {}) {
  if (editorRedraw) return; // Explicit screen-only provider, no structured evidence.
  const command = codex ? { command: codexHook, args: [] } : settings.hooks[name][0].hooks[0];
  const result = spawnSync(command.command, command.args, {
    shell: codex, // Trusted host-produced command, payload stays on stdin.
    windowsHide: true,
    timeout: 5000,
    input: JSON.stringify({
      hook_event_name: name,
      session_id: `fixture-${id}`,
      agent_id: '',
      ...(codex && name !== 'SessionStart' ? { turn_id: `turn-${turn}` } : {}),
      ...extra,
    }),
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  if (result.status !== 0) throw new Error('Fixture lifecycle helper failed');
}
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdout.write('\x1b[?2004hSCOPE_FIXTURE_READY\r\n');
const announceReady = () => {
  hook('SessionStart', { source: 'startup' });
  if (!codex) hook('Stop');
  if (editorRedraw) drawEditor();
};
function drawEditor() {
  process.stdout.write('\x1b[2J\x1b[H❯ draft\r\n? for shortcuts\x1b[1;8H');
}
if (fs.existsSync(path.join(process.cwd(), '.fixture-defer-ready')))
  setTimeout(announceReady, 2500);
else announceReady();
function fixtureCli(args) {
  const result = spawnSync(process.env.NESVO_CLI, args, {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (result.status !== 0) throw new Error(`Managed task CLI failed: ${result.stdout}`);
  return JSON.parse(result.stdout);
}
function reportTask(outcome = 'succeeded') {
  const context = fixtureCli(['run', 'context', '--json']);
  const file = path.join(directory, `${id}.report-input.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      outcome,
      summary: 'Controlled fixture result',
      files: [],
      artifacts: [],
      checks: [
        {
          name: 'fixture',
          outcome: outcome === 'succeeded' ? 'passed' : 'skipped',
          details: 'Controlled result path exercised',
        },
      ],
      limitations: ['Controlled fixture only; no model or code validation'],
    }),
  );
  const report = fixtureCli([
    'run',
    'report',
    context.data.attempt.id,
    '--key',
    'fixture-result',
    '--file',
    file,
    '--json',
  ]);
  fs.writeFileSync(path.join(directory, `${id}.result.json`), JSON.stringify(report));
}
function submit(prompt) {
  turn++;
  hook('UserPromptSubmit', { prompt });
  if (prompt === 'hold-response') {
    hook('PreToolUse', { tool_name: 'controlled_hold' });
    process.stdout.write('FIXTURE_HOLDING_RESPONSE\r\n');
    return; // Remains working until an explicit native Ctrl+C from this test.
  }
  if (prompt === 'spawn-child') {
    // Inherit only this managed process's scoped context. No owner pairing flag.
    const result = spawnSync(
      process.env.NESVO_CLI,
      [
        'session',
        'create',
        'Scoped child',
        '--key',
        'agent-child-once',
        '--program',
        'claude',
        '--json',
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 10000 },
    );
    if (result.status !== 0) throw new Error('Managed CLI child creation failed');
    fs.writeFileSync(path.join(directory, `${id}.child.json`), result.stdout);
  }
  if (prompt === 'question-task') {
    const context = fixtureCli(['run', 'context', '--json']);
    const question = path.join(directory, `${id}.question.txt`);
    fs.writeFileSync(
      question,
      'Continue the controlled fixture result? This is task data, not a native permission request.',
    );
    const asked = fixtureCli([
      'run',
      'decision',
      'ask',
      context.data.attempt.id,
      '--key',
      'fixture-question',
      '--audience',
      'owner',
      '--question-file',
      question,
      '--timeout-ms',
      '60000',
      '--json',
    ]);
    const questionResult = path.join(directory, `${id}.question.json`);
    fs.writeFileSync(`${questionResult}.tmp`, JSON.stringify(asked));
    fs.renameSync(`${questionResult}.tmp`, questionResult);
    process.stdout.write('FIXTURE_AWAITING_DECISION\r\n');
    hook('PreToolUse', { tool_name: 'AskUserQuestion' });
    const until = Date.now() + 60000;
    const inspectDecision = () => {
      const decision = fixtureCli([
        'run',
        'decision',
        'get',
        context.data.run.id,
        asked.data.decision.id,
        '--json',
      ]).data.decision;
      if (
        decision.state === 'answered' ||
        ['expired', 'canceled'].includes(decision.state) ||
        Date.now() >= until
      ) {
        reportTask(decision.state === 'answered' ? 'succeeded' : 'blocked');
        process.stdout.write('FIXTURE_RESPONSE question-task\r\n');
        hook('Stop');
      } else setTimeout(inspectDecision, 500);
    };
    setTimeout(inspectDecision, 500);
    return;
  }
  if (prompt === 'report-task') reportTask();
  process.stdout.write(`FIXTURE_RESPONSE ${prompt}\r\n`);
  hook('Stop');
}
let pending = '';
let draft = '';
process.stdin.on('data', text => {
  pending += text;
  while (pending.length) {
    if (pending.startsWith('\x1b[200~')) {
      const end = pending.indexOf('\x1b[201~', 6);
      if (end < 0) return;
      draft += pending.slice(6, end);
      pending = pending.slice(end + 6);
      if (editorRedraw) {
        process.stdout.write(
          editorBlocked
            ? '\x1b[2J\x1b[HPASTE_PENDING_REDRAW\r\nThinking (esc to interrupt)'
            : '\x1b[2J\x1b[HPASTE_PENDING_REDRAW\r\n',
        );
        setTimeout(drawEditor, 600);
      }
    } else if (/^[\r\n]/.test(pending)) {
      pending = pending.slice(1);
      const prompt = draft;
      draft = '';
      if (prompt) submit(prompt);
    } else if (pending[0] === '\x03') {
      pending = pending.slice(1);
      draft = '';
      hook(codex ? 'Interrupt' : 'Stop');
    } else if (pending[0] === '\x1b') {
      const escape = pending.match(/^\x1b\[[0-9;?]*[A-Za-z~]/);
      if (!escape) return;
      pending = pending.slice(escape[0].length);
    } else {
      let end = pending.search(/[\x1b\r\n\x03]/);
      if (end < 0) end = pending.length;
      draft += pending.slice(0, end);
      pending = pending.slice(end);
    }
  }
});
process.stdin.resume();
