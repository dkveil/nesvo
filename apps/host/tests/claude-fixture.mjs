import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';

const args = process.argv.slice(2);
const flags = [
  '--print',
  '--input-format',
  '--output-format',
  '--verbose',
  '--include-partial-messages',
  '--permission-mode',
  '--permission-prompts',
  '--tools',
  '--allowedTools',
  '--strict-mcp-config',
  '--mcp-config',
  '--settings',
  '--session-id',
  '--resume',
  '--model',
  '--no-session-persistence',
];
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const runEnvironment = () => ({
  NESVO_RUN_ID: process.env.NESVO_RUN_ID ?? null,
  NESVO_PROJECT_ROOT: process.env.NESVO_PROJECT_ROOT ?? null,
});

if (args.length === 1 && args[0] === '--version') {
  console.log('2.1.0 (Claude Code fixture)');
} else if (args.length === 1 && args[0] === '--help') {
  console.log(flags.join('\n'));
} else if (args.join(' ') === 'auth status --json') {
  emit({ loggedIn: true, authMethod: 'fixture', apiProvider: 'fixture' });
} else if (args[args.indexOf('--input-format') + 1] === 'stream-json') {
  const switches = new Set([
    '--print',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
  ]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    assert.ok(flags.includes(flag), `Unexpected usage argument: ${flag}`);
    assert.equal(values.has(flag), false);
    values.set(flag, switches.has(flag) ? true : args[++index]);
  }
  for (const flag of switches) assert.equal(values.get(flag), true, flag);
  for (const [flag, expected] of [
    ['--input-format', 'stream-json'],
    ['--output-format', 'stream-json'],
    ['--permission-mode', 'plan'],
    ['--permission-prompts', 'none'],
    ['--tools', ''],
    ['--mcp-config', '{"mcpServers":{}}'],
    ['--settings', '{"disableAllHooks":true}'],
  ])
    assert.equal(values.get(flag), expected, flag);
  assert.equal(values.size, switches.size + 7);
  const methods = [];
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line);
    assert.equal(frame.type, 'control_request');
    assert.match(frame.request_id, /^[0-9a-f-]{36}$/);
    methods.push(frame.request.subtype);
    let response;
    if (methods.length === 1) {
      assert.deepEqual(frame.request, {
        subtype: 'initialize',
        hooks: {},
        sdkMcpServers: [],
      });
      response = {
        account: {
          email: 'claude-fixture@example.invalid',
          organization: 'Fixture organization',
          subscriptionType: 'max',
        },
      };
    } else {
      assert.equal(methods.length, 2);
      assert.deepEqual(frame.request, {
        subtype: 'get_usage',
        skip_behaviors: true,
      });
      if (process.env.NESVO_FIXTURE_USAGE_LOG)
        writeFileSync(
          process.env.NESVO_FIXTURE_USAGE_LOG,
          JSON.stringify({
            provider: 'Claude Code',
            pid: process.pid,
            methods,
          }) + '\n',
          { flag: 'a' },
        );
      const control = process.env.NESVO_FIXTURE_USAGE_CONTROL
        ? JSON.parse(
            readFileSync(process.env.NESVO_FIXTURE_USAGE_CONTROL, 'utf8'),
          )
        : {};
      await setTimeout(150);
      response =
        control['Claude Code'] === 'unavailable'
          ? { subscription_type: 'max', rate_limits_available: false }
          : {
              subscription_type: 'max',
              rate_limits_available: true,
              rate_limits: {
                five_hour: {
                  utilization: control['Claude Code']?.startsWith('exhausted')
                    ? 100
                    : 23.5,
                  resets_at:
                    control['Claude Code'] === 'exhausted'
                      ? '2099-01-02T03:04:05.000Z'
                      : control['Claude Code'] === 'exhausted-past'
                        ? '2020-01-02T03:04:05.000Z'
                        : '2030-01-02T03:04:05.000Z',
                },
                seven_day: {
                  utilization: 61.25,
                  resets_at: '2030-01-07T03:04:05.000Z',
                },
              },
            };
    }
    emit({
      type: 'control_response',
      response: { subtype: 'success', request_id: frame.request_id, response },
    });
  }
  assert.deepEqual(methods, ['initialize', 'get_usage']);
} else {
  const switches = new Set([
    '--print',
    '--verbose',
    '--include-partial-messages',
    '--strict-mcp-config',
  ]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    assert.ok(flags.includes(flag), `Unexpected argument: ${flag}`);
    assert.equal(values.has(flag), false, `Repeated flag: ${flag}`);
    values.set(flag, switches.has(flag) ? true : args[++index]);
  }
  for (const flag of switches) assert.equal(values.get(flag), true, flag);
  for (const [flag, expected] of [
    ['--input-format', 'text'],
    ['--output-format', 'stream-json'],
    ['--permission-mode', 'plan'],
    ['--permission-prompts', 'none'],
    ['--tools', 'Read,Glob,Grep'],
    ['--allowedTools', 'Read,Glob,Grep'],
    ['--mcp-config', '{"mcpServers":{}}'],
    ['--settings', '{"disableAllHooks":true}'],
  ])
    assert.equal(values.get(flag), expected, flag);
  assert.notEqual(values.has('--session-id'), values.has('--resume'));
  if (process.env.NESVO_FIXTURE_LAUNCH_LOG)
    writeFileSync(
      process.env.NESVO_FIXTURE_LAUNCH_LOG,
      JSON.stringify({
        provider: 'Claude Code',
        cwd: process.cwd(),
        args,
        environment: runEnvironment(),
      }) + '\n',
      { flag: 'a' },
    );
  const resumed = values.has('--resume');
  const sessionId = values.get(resumed ? '--resume' : '--session-id');
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  if (values.has('--model'))
    assert.ok(['opus', 'sonnet', 'haiku'].includes(values.get('--model')));
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  assert.ok(prompt.trim(), 'Prompt must arrive through stdin');
  if (
    prompt.startsWith(
      'The user explicitly selected the following file as shared instructions',
    )
  ) {
    const path = JSON.parse(/^Source file: (.+)$/m.exec(prompt)[1]);
    const hash = /^Source file SHA-256: ([a-f0-9]{64})$/m.exec(prompt)[1];
    const instructions =
      /<shared-skill-instructions>\n([\s\S]*?)\n<\/shared-skill-instructions>/.exec(
        prompt,
      )[1];
    assert.match(instructions, /FIXTURE_CODEX_SHARED_MARKER/);
    assert.equal(
      hash,
      createHash('sha256').update(readFileSync(path)).digest('hex'),
    );
    assert.match(prompt, /not a native skill invocation/);
    assert.match(
      prompt,
      /Existing provider tools and permissions remain unchanged/,
    );
    assert.ok(
      prompt.includes(
        `Base directory for relative resource references: ${JSON.stringify(join(path, '..'))}`,
      ),
    );
    if (process.env.NESVO_FIXTURE_SKILL_LOG)
      writeFileSync(
        process.env.NESVO_FIXTURE_SKILL_LOG,
        JSON.stringify({
          sessionId,
          resumed,
          path,
          hash,
          instructions,
          prompt,
        }) + '\n',
        { flag: 'a' },
      );
    prompt = prompt.slice(
      prompt.lastIndexOf('\nUser request:\n') + '\nUser request:\n'.length,
    );
  }
  const statePath = join(process.cwd(), `.nesvo-fixture-${sessionId}.json`);
  assert.equal(existsSync(statePath), resumed, 'Resume must retain CLI state');
  const turn = resumed
    ? JSON.parse(readFileSync(statePath, 'utf8')).turn + 1
    : 1;
  writeFileSync(statePath, JSON.stringify({ turn }));
  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: `fixture-${values.get('--model') ?? 'default'}`,
    tools: ['Read', 'Glob', 'Grep'],
  });
  emit({ type: 'assistant', parent_tool_use_id: 'fixture-subagent' });
  const messageId = `fixture-message-${turn}`;
  const stream = event => emit({ type: 'stream_event', event });
  const toolId = `fixture-read-${turn}`;
  const startRead = () => {
    const block = {
      type: 'tool_use',
      id: toolId,
      name: 'Read',
      input: { file_path: 'sample.txt' },
    };
    stream({ type: 'content_block_start', index: 1, content_block: block });
    emit({
      type: 'assistant',
      message: { id: `fixture-tool-${turn}`, content: [block] },
    });
  };
  const finishRead = failed =>
    emit({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolId,
            is_error: failed,
            content: failed
              ? 'ENOENT: sample.txt was not found; API_TOKEN=fixture-secret'
              : 'private file contents are not activity output',
          },
        ],
      },
    });
  const start = text => {
    stream({ type: 'message_start', message: { id: messageId } });
    stream({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    });
  };
  const finish = (text, isError = false, reported = {}) => {
    stream({ type: 'content_block_stop', index: 0 });
    stream({ type: 'message_stop' });
    emit({
      type: 'assistant',
      message: {
        id: messageId,
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    });
    emit({
      type: 'result',
      subtype: 'success',
      is_error: isError,
      result: text,
      session_id: sessionId,
      ...reported,
    });
  };
  const command = prompt.split('\n')[0].trim();
  if (command === 'fixture:hold' || command === 'fixture:hold-exit') {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'ignore',
        windowsHide: true,
        detached: process.platform === 'linux',
      },
    );
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    assert.ok(process.env.NESVO_FIXTURE_PID_FILE);
    writeFileSync(
      process.env.NESVO_FIXTURE_PID_FILE,
      JSON.stringify({ pid: process.pid, childPid: child.pid, sessionId }),
    );
    start('Fixture is waiting.');
    startRead();
    if (command === 'fixture:hold-exit') {
      await setTimeout(2500);
      process.exit(73);
    }
    setInterval(() => {}, 1000);
  } else if (command === 'fixture:fail') {
    emit({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        rateLimitType: 'five_hour',
      },
    });
    emit({
      type: 'assistant',
      error: 'rate_limit',
      message: {
        id: messageId,
        content: [{ type: 'text', text: 'Fixture account limit reached.' }],
      },
    });
    emit({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Fixture account limit reached.',
    });
  } else if (command === 'fixture:limit') {
    emit({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        rateLimitType: 'five_hour',
        resetsAt: Date.parse('2099-01-02T03:04:05.000Z') / 1000,
      },
    });
    emit({
      type: 'assistant',
      error: 'rate_limit',
      message: {
        id: messageId,
        content: [{ type: 'text', text: 'Fixture account limit reached.' }],
      },
    });
    emit({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Fixture account limit reached.',
    });
  } else if (command === 'fixture:result-fail') {
    start('Fixture unsuccessful result.');
    startRead();
    finishRead(true);
    finish('Fixture unsuccessful result.', true);
  } else if (command === 'fixture:stream') {
    start('Fixture streamed ');
    startRead();
    await setTimeout(300);
    stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'reply.' },
    });
    finishRead(false);
    finish('Fixture streamed reply.', false, {
      duration_ms: 2310,
      total_cost_usd: 0.0421,
      usage: {
        input_tokens: 1200,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 4000,
        output_tokens: 350,
      },
    });
  } else {
    const text = `Fixture ${resumed ? 'resumed' : 'initial'} reply.`;
    start(text);
    finish(text);
  }
}
