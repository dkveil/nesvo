#!/usr/bin/env node
// Controlled original-CLI fixture. It never calls a model or loads user settings.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const codex = path.basename(process.argv[1]).startsWith('codex');
if (process.argv.includes('--version')) {
  if (
    process.env.NESVO_TEST_CALLERS &&
    fs.existsSync(path.join(process.env.NESVO_TEST_CALLERS, '.fixture-slow-version'))
  )
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
  console.log(codex ? '0.156.0' : '2.1.303-scoped-fixture');
  process.exit(0);
}
if (codex && process.argv.includes('app-server')) {
  // Owned JSON-lines account/config/quota fixture. No login, turn or model RPC.
  const directory = process.env.NESVO_TEST_CALLERS;
  if (!directory || !path.isAbsolute(directory)) process.exit(2);
  const source = path.join(directory, '.fixture-quota.json');
  const records = path.join(directory, '.fixture-quota-reads.jsonl');
  const lines = require('node:readline').createInterface({ input: process.stdin });
  const lifetime = setTimeout(() => process.exit(0), 12000);
  let initialized = false;
  let notified = false;
  let accountRead = false;
  let configRead = false;
  let requested = false;
  const normalizedPath = value => {
    const absolute = path.resolve(value);
    return process.platform === 'win32' ? path.toNamespacedPath(absolute).toLowerCase() : absolute;
  };
  const samePath = (first, second) => normalizedPath(first) === normalizedPath(second);
  let configuration;
  try {
    if (fs.statSync(source).size > 65536) throw new Error('Oversized owned fixture');
    const root = JSON.parse(fs.readFileSync(source, 'utf8'));
    configuration =
      Object.entries(root.contexts ?? {}).find(([cwd]) => samePath(cwd, process.cwd()))?.[1] ??
      root;
  } catch {
    configuration = null;
  }
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  const error = id =>
    send({
      id,
      error: { code: -32000, message: 'PRIVATE_QUOTA_PROVIDER_ERROR_DO_NOT_EXPOSE' },
    });
  lines.on('line', line => {
    if (Buffer.byteLength(line) > 16384) return process.exit(2);
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return process.exit(2);
    }
    const params = request.params;
    const record = () =>
      fs.appendFileSync(
        records,
        `${JSON.stringify({
          pid: process.pid,
          method: request.method,
          id: request.id ?? null,
          cwd: process.cwd(),
          home: process.env.CODEX_HOME ?? null,
          params,
        })}\n`,
      );
    if (request.method === 'initialize' && request.id === 1 && !initialized) {
      initialized = true;
      record();
      const result = {
        codexHome: configuration?.reportedHome ?? process.env.CODEX_HOME,
        platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
        platformOs: process.platform,
      };
      if (configuration?.readerVersion !== null)
        result.userAgent = configuration?.readerVersion ?? 'codex/0.156.0-owned-fixture';
      send({ id: request.id, result });
      return;
    }
    if (request.method === 'initialized' && initialized && request.id === undefined) {
      notified = true;
      record();
      return;
    }
    if (
      request.method === 'account/read' &&
      request.id === 2 &&
      notified &&
      !accountRead &&
      params &&
      Object.keys(params).length === 1 &&
      params.refreshToken === false
    ) {
      accountRead = true;
      record();
      if (!configuration || configuration.accountMode === 'error') error(request.id);
      else if (configuration.accountMode !== 'hang')
        send({
          id: request.id,
          result: configuration.accountResult ?? {
            requiresOpenaiAuth: true,
            account: {
              type: 'chatgpt',
              email: 'PRIVATE_QUOTA_EMAIL_DO_NOT_EXPOSE@example.invalid',
              planType: 'plus',
            },
          },
        });
      return;
    }
    if (
      request.method === 'config/read' &&
      request.id === 3 &&
      accountRead &&
      !configRead &&
      params &&
      Object.keys(params).length === 2 &&
      typeof params.cwd === 'string' &&
      samePath(params.cwd, process.cwd()) &&
      params.includeLayers === false
    ) {
      configRead = true;
      record();
      if (!configuration || configuration.configMode === 'error') error(request.id);
      else if (configuration.configMode !== 'hang')
        send({
          id: request.id,
          result: configuration.configResult ?? {
            config: { model_provider: 'openai', forced_login_method: 'chatgpt' },
            origins: {
              model_provider: {
                name: { type: 'user', file: path.join(process.env.CODEX_HOME, 'config.toml') },
                version: configuration.configVersion ?? 'fixture-route-v1',
              },
            },
          },
        });
      return;
    }
    if (
      request.method !== 'account/rateLimits/read' ||
      request.id !== 4 ||
      !configRead ||
      requested ||
      request.params === null ||
      typeof request.params !== 'object' ||
      Object.keys(request.params).length !== 0
    ) {
      error(request.id ?? null);
      return;
    }
    requested = true;
    record();
    if (!configuration) {
      error(request.id);
      return;
    }
    const heldAt = Date.now();
    const answer = () => {
      if (
        configuration.mode === 'heldSnapshot' &&
        !fs.existsSync(path.join(directory, '.fixture-quota-release'))
      ) {
        if (Date.now() - heldAt >= 5000) error(request.id);
        else setTimeout(answer, 25);
        return;
      }
      if (configuration.mode === 'hang') return;
      if (configuration.mode === 'oversize') {
        process.stdout.write(`${'x'.repeat(256 * 1024 + 1)}\n`);
        return;
      }
      if (['sparseOnly', 'sparseThenError'].includes(configuration.mode)) {
        send({
          method: 'account/rateLimits/updated',
          params: { rateLimits: configuration.result?.rateLimits ?? {} },
        });
        if (configuration.mode === 'sparseOnly') return;
      }
      if (configuration.mode === 'error' || configuration.mode === 'sparseThenError') {
        error(request.id);
        return;
      }
      send({ id: request.id, result: configuration.result });
    };
    const delay = Number.isInteger(configuration.delayMs)
      ? Math.max(0, Math.min(configuration.delayMs, 3000))
      : 0;
    setTimeout(answer, delay);
  });
  lines.on('close', () => {
    clearTimeout(lifetime);
    process.exit(0);
  });
  return;
}
const id = process.env.NESVO_SESSION_ID;
if (!/^[a-f0-9]{32}$/.test(id || '')) throw new Error('Missing fixture process identity');
const directory = process.env.NESVO_TEST_CALLERS;
fs.writeFileSync(
  path.join(directory, `${id}.launch-argv.json`),
  JSON.stringify(process.argv.slice(2)),
);
const editorRedraw = fs.existsSync(path.join(process.cwd(), '.fixture-editor-redraw'));
const editorRedrawDelay = fs.existsSync(path.join(process.cwd(), '.fixture-slow-redraw'))
  ? 3000
  : 600;
const editorBlocked =
  editorRedraw &&
  fs.readFileSync(path.join(process.cwd(), '.fixture-editor-redraw'), 'utf8') === 'working';
if (
  !fs.readFileSync(process.env.NESVO_AGENT_SKILL, 'utf8').includes('NESVO_HARNESS_INSTRUCTIONS_V11')
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
    !instruction.includes('NESVO_HARNESS_INSTRUCTIONS_V11') ||
    !instruction.includes('# Run policy and native control reference') ||
    !instruction.includes('# Run context and owner constraints reference') ||
    !instruction.includes('## Opt-in coordinator notices')
  )
    throw new Error('Launch-local harness was not loaded by the controlled provider');
}
const settings = codex ? null : JSON.parse(process.argv[process.argv.indexOf('--settings') + 1]);
if (!codex) {
  fs.writeFileSync(
    path.join(directory, `${id}.native-permissions.json`),
    JSON.stringify(settings.permissions?.allow ?? []),
  );
}
// The fixture consumes only the host's bounded literal inline shape, not arbitrary TOML.
const codexHook = codex
  ? JSON.parse(
      process.argv
        .find((arg, index) => process.argv[index - 1] === '-c' && arg.startsWith('hooks='))
        .match(/command=("(?:[^"\\]|\\.)*")/)[1],
    )
  : null;
if (codex && !process.argv.includes('--no-daemon'))
  throw new Error('Codex must own its local executor');
let turn = 0;
function subprocessFailure(label, result) {
  // Only controlled fixture child output is included; keep PTY diagnostics bounded.
  return new Error(
    `${label}: ${JSON.stringify({
      status: result.status ?? null,
      signal: result.signal ?? null,
      error: result.error
        ? {
            name: result.error.name,
            code: result.error.code ?? null,
            message: result.error.message.slice(0, 512),
          }
        : null,
      stdout: String(result.stdout ?? '').slice(0, 1024),
      stderr: String(result.stderr ?? '').slice(0, 1024),
    })}`,
  );
}
function hook(name, extra = {}) {
  if (editorRedraw) return; // Explicit screen-only provider, no structured evidence.
  const commands = codex ? [{ command: codexHook, args: [] }] : settings.hooks[name][0].hooks;
  for (const command of commands) {
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
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.status !== 0)
      throw subprocessFailure(`Fixture lifecycle helper failed (${name})`, result);
    if (result.stdout.length) {
      const output = JSON.parse(result.stdout.toString('utf8'));
      if (name !== 'SessionStart' || output.hookSpecificOutput?.hookEventName !== 'SessionStart')
        throw new Error('Unexpected lifecycle output');
      fs.appendFileSync(
        path.join(directory, `${id}.recovery.jsonl`),
        JSON.stringify({ source: extra.source, output }) + '\n',
      );
    }
  }
}
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const announceReady = () => {
  hook('SessionStart', { source: 'startup' });
  if (!codex) hook('Stop');
  if (editorRedraw) drawEditor();
};
function drawEditor() {
  process.stdout.write('\x1b[2J\x1b[H❯ draft\r\n? for shortcuts\x1b[1;8H');
}
function fixtureCli(args) {
  const result = spawnSync(process.env.NESVO_CLI, args, {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (result.status !== 0)
    throw subprocessFailure(`Managed task CLI failed (${args.slice(0, 2).join(' ')})`, result);
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
  // Observed original Claude marks expanded multiline pastes in this envelope.
  // Keep native input unchanged; only its hook payload carries the wrapper.
  hook('UserPromptSubmit', {
    prompt:
      !codex && prompt.includes('\n')
        ? `\n\n<pasted_content id="f558">\n${prompt}\n</pasted_content id="f558">\n`
        : prompt,
  });
  if (prompt === 'fixture-compact') {
    hook('SessionStart', { source: 'compact' });
    process.stdout.write('FIXTURE_CONTEXT_COMPACTED\r\n');
    hook('Stop');
    return;
  }
  if (prompt.startsWith('Nesvo run update ')) {
    const run = prompt.match(/Run ([a-f0-9]{32}), wake batch ([a-f0-9]{32})/);
    if (!run) throw new Error('Missing fixed host wake identities');
    const batch = fixtureCli(['run', 'wake', 'batch', run[1], run[2], '--json']);
    const inbox = fixtureCli(['run', 'inbox', 'read', run[1], '--json']);
    // Model behavior is not simulated: this controlled endpoint reads actual
    // scoped CLI metadata, records evidence, and deliberately performs no ACK.
    fs.appendFileSync(
      path.join(directory, `${id}.wake-inputs.jsonl`),
      JSON.stringify({ prompt, batch, inbox }) + '\n',
    );
    process.stdout.write(`FIXTURE_WAKE_RECEIVED ${run[2]}\r\n`);
    hook('Stop');
    return;
  }
  if (prompt === 'hold-response') {
    hook('PreToolUse', { tool_name: 'controlled_hold' });
    process.stdout.write('FIXTURE_HOLDING_RESPONSE\r\n');
    return; // Remains working until an explicit native Ctrl+C from this test.
  }
  if (prompt === 'held-natural-response') {
    hook('PreToolUse', { tool_name: 'controlled_hold' });
    process.stdout.write('FIXTURE_HOLDING_NATURAL_RESPONSE\r\n');
    const release = path.join(directory, `${id}.release`);
    const deadline = Date.now() + 20000;
    const finish = () => {
      if (fs.existsSync(release) || Date.now() >= deadline) {
        process.stdout.write('FIXTURE_NATURAL_RESPONSE_FINISHED\r\n');
        hook('Stop');
      } else setTimeout(finish, 50);
    };
    setTimeout(finish, 50);
    return;
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
        setTimeout(drawEditor, editorRedrawDelay);
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
// Start the input consumer before startup hooks can publish semantic readiness.
setImmediate(() => {
  process.stdout.write('\x1b[?2004hSCOPE_FIXTURE_READY\r\n');
  if (fs.existsSync(path.join(process.cwd(), '.fixture-defer-ready')))
    setTimeout(announceReady, 2500);
  else announceReady();
});
