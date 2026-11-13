import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const runEnvironment = () => ({
  NESVO_RUN_ID: process.env.NESVO_RUN_ID ?? null,
  NESVO_PROJECT_ROOT: process.env.NESVO_PROJECT_ROOT ?? null,
});
const isolatedConfig = {
  mcp_servers: {},
  features: {
    hooks: false,
    plugins: false,
    apps: false,
    multi_agent: false,
    multi_agent_v2: false,
  },
};

if (args.length === 1 && args[0] === '--version') {
  console.log('codex-cli 0.156.0');
} else {
  assert.equal(args[0], 'app-server');
  for (let index = 1; index < args.length; index += 2) {
    assert.ok(
      ['--listen', '--disable', '-c', '--config'].includes(args[index]),
    );
    assert.ok(args[index + 1]);
    if (args[index] === '--listen') assert.equal(args[index + 1], 'stdio://');
  }
  const lines = createInterface({ input: process.stdin });
  let initialized = false;
  let acknowledged = false;
  let experimentalApi = false;
  let thread;
  let current;
  let skillsDirectory;
  let selectedSkills;
  let extraRoots = [];
  const methods = [];
  const forbiddenSkillMethods = new Set([
    'account/read',
    'model/list',
    'thread/start',
    'thread/resume',
    'turn/start',
  ]);
  const skillsTrace = (directory, method, extra = {}) => {
    if (process.env.NESVO_CODEX_FIXTURE_SKILLS_LOG)
      writeFileSync(
        process.env.NESVO_CODEX_FIXTURE_SKILLS_LOG,
        JSON.stringify({
          directory,
          method,
          methods,
          pid: process.pid,
          ...extra,
        }) + '\n',
        { flag: 'a' },
      );
  };
  const approvals = new Map();
  const delegations = new Map();
  const response = (id, result) => emit({ id, result });
  const notify = (method, params) => emit({ method, params });
  const statePath = id => {
    const directory = process.env.NESVO_CODEX_FIXTURE_STATE_DIR ?? thread.cwd;
    mkdirSync(directory, { recursive: true });
    return join(directory, `.nesvo-codex-fixture-${id}.json`);
  };
  const policy = () =>
    thread.supervised
      ? {
          type: 'workspaceWrite',
          writableRoots: [thread.cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        }
      : { type: 'readOnly', networkAccess: false };
  const scoped = extra => ({
    threadId: thread.id,
    turnId: current.id,
    ...extra,
  });
  const tokenUsage = (last, total) =>
    notify(
      'thread/tokenUsage/updated',
      scoped({
        tokenUsage: {
          modelContextWindow: 200000,
          last: { reasoningOutputTokens: 0, totalTokens: 0, ...last },
          total: { reasoningOutputTokens: 0, totalTokens: 0, ...total },
        },
      }),
    );
  const complete = (text, durationMs = null) => {
    if (!current || current.completed) return;
    current.completed = true;
    notify(
      'item/completed',
      scoped({
        item: {
          id: current.itemId,
          type: 'agentMessage',
          text,
          phase: 'final_answer',
          memoryCitation: null,
          delivery: null,
          questions: null,
        },
      }),
    );
    notify('turn/completed', {
      threadId: thread.id,
      turn: {
        id: current.id,
        status: 'completed',
        items: [],
        error: null,
        durationMs,
      },
    });
  };
  const delta = text =>
    notify(
      'item/agentMessage/delta',
      scoped({ itemId: current.itemId, delta: text }),
    );
  const tool = (phase, item) => notify(`item/${phase}`, scoped({ item }));
  const commandItem = (suffix, extra = {}) => ({
    id: `fixture-command-${suffix}-${current.id}`,
    type: 'commandExecution',
    command: 'printf count=5',
    commandActions: [],
    cwd: thread.cwd,
    status: 'inProgress',
    aggregatedOutput: '',
    ...extra,
  });
  const hold = async workerLabel => {
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
    assert.ok(process.env.NESVO_CODEX_FIXTURE_PID_FILE);
    const pids = JSON.stringify({
      pid: process.pid,
      childPid: child.pid,
      sessionId: thread.id,
    });
    writeFileSync(process.env.NESVO_CODEX_FIXTURE_PID_FILE, pids);
    tool('started', commandItem('hold', { command: 'wait for cancellation' }));
    if (process.env.NESVO_CODEX_FIXTURE_PID_DIR) {
      mkdirSync(process.env.NESVO_CODEX_FIXTURE_PID_DIR, { recursive: true });
      writeFileSync(
        join(process.env.NESVO_CODEX_FIXTURE_PID_DIR, `${thread.id}.json`),
        pids,
      );
    }
    delta(
      workerLabel
        ? `Codex worker ${workerLabel} is waiting.`
        : 'Codex fixture is waiting.',
    );
    if (workerLabel) {
      let tick = 0;
      setInterval(() => delta(` ${workerLabel}:${++tick}`), 120);
    }
  };
  const delegate = variant => {
    const worker = (label, task) => ({
      title: `Fixture worker ${label.toUpperCase()}`,
      task: `fixture:worker-${task}:${label}`,
      scope: `Inspect area ${label.toUpperCase()} only`,
      directory: '.',
      provider: 'Codex',
      model: 'fixture-codex',
      mode: 'read-only',
    });
    let workers = [worker('a', 'complete'), worker('b', 'hold')];
    if (variant === 'two-hold')
      workers = [worker('a', 'hold'), worker('b', 'hold')];
    else if (variant === 'mixed')
      workers = [worker('a', 'complete'), worker('b', 'fail')];
    else if (variant === 'recursive') workers = [worker('a', 'recursive')];
    else if (variant === 'writable')
      workers = [
        {
          ...worker('a', 'complete'),
          task: 'fixture:review-write',
          mode: 'supervised',
        },
      ];
    else if (variant === 'writable-pending')
      workers = [
        {
          ...worker('a', 'complete'),
          task: 'fixture:review-write',
          mode: 'supervised',
          directory: 'write-worker',
        },
        { ...worker('b', 'hold'), directory: 'read-worker' },
      ];
    else if (variant === 'too-many') workers.push(worker('c', 'complete'));
    else if (variant === 'escape')
      workers = [{ ...worker('a', 'complete'), directory: '../outside' }];
    else if (variant === 'symlink')
      workers = [{ ...worker('a', 'complete'), directory: 'outside-link' }];
    else if (variant === 'overlap') workers[1].mode = 'supervised';
    const id = `fixture-delegation-${randomUUID()}`;
    delegations.set(id, true);
    emit({
      id,
      method: 'item/tool/call',
      params: scoped({
        callId: randomUUID(),
        namespace: null,
        tool: 'nesvo_delegate',
        arguments: { workers },
      }),
    });
  };
  const requestApproval = (kind, variant) => {
    const id = `fixture-approval-${randomUUID()}`;
    const itemId = `fixture-${kind}-${randomUUID()}`;
    const path = join(
      thread.cwd,
      `.nesvo-codex-action-${thread.id}-${kind}.json`,
    );
    approvals.set(id, { kind, path });
    if (kind === 'file' && variant !== 'missing-changes') {
      notify(
        'item/started',
        scoped({
          item: {
            id: itemId,
            type: 'fileChange',
            changes: [
              { path, kind: { type: 'add' }, diff: '+approved fixture marker' },
            ],
            status: 'inProgress',
          },
        }),
      );
    }
    emit({
      id,
      method:
        kind === 'command'
          ? 'item/commandExecution/requestApproval'
          : 'item/fileChange/requestApproval',
      params: scoped({
        itemId,
        startedAtMs: Date.now(),
        reason: 'Fixture approval boundary check',
        ...(kind === 'command'
          ? {
              kind: 'command',
              ...(variant === 'missing-command'
                ? {}
                : {
                    command:
                      variant === 'oversize'
                        ? 'x'.repeat(100_001)
                        : 'fixture write approved marker',
                  }),
              cwd: thread.cwd,
              environmentId:
                variant === 'remote-environment' ? 'remote-fixture' : 'local',
              commandActions: [],
            }
          : { grantRoot: null }),
      }),
    });
  };
  const handle = async message => {
    if (!message.method) {
      if (delegations.has(message.id)) {
        delegations.delete(message.id);
        assert.equal(message.result.contentItems.length, 1);
        assert.equal(message.result.contentItems[0].type, 'inputText');
        const text = message.result.contentItems[0].text;
        let result;
        try {
          result = JSON.parse(text);
        } catch {
          result = { error: text };
        }
        const body = `Codex delegation results: ${JSON.stringify(result)}`;
        delta('Codex delegation results: ');
        setTimeout(() => {
          delta(JSON.stringify(result));
          complete(body);
        }, 100);
        return;
      }
      const approval = approvals.get(message.id);
      assert.ok(
        approval,
        'Approval response must match an outstanding native request',
      );
      assert.deepEqual(Object.keys(message.result), ['decision']);
      assert.ok(
        ['accept', 'decline', 'cancel'].includes(message.result.decision),
      );
      approvals.delete(message.id);
      if (message.result.decision === 'accept') {
        assert.equal(
          thread.supervised,
          true,
          'Read-only sessions must never accept operations',
        );
        writeFileSync(
          approval.path,
          JSON.stringify({
            requestId: message.id,
            kind: approval.kind,
            decision: 'accept',
          }),
        );
      }
      complete(
        `Codex fixture ${approval.kind} ${message.result.decision === 'accept' ? 'accepted' : 'declined'}.`,
      );
      return;
    }
    const { id, method, params } = message;
    methods.push(method);
    if (skillsDirectory) {
      assert.equal(
        /^(?:account|model)\//.test(method),
        false,
        'Skill inspection must keep the isolated execution peer',
      );
      skillsTrace(
        skillsDirectory,
        method,
        method === 'turn/start' ? { input: params.input } : {},
      );
    }
    if (method === 'initialize') {
      assert.equal(initialized, false);
      assert.equal(params.clientInfo.name, 'nesvo');
      initialized = true;
      experimentalApi = params.capabilities.experimentalApi;
      assert.equal(typeof experimentalApi, 'boolean');
      response(id, {
        userAgent: 'codex_cli_rs/0.156.0 (fixture)',
        platformFamily: process.platform,
        platformOs: process.platform,
      });
      return;
    }
    assert.ok(initialized);
    if (method === 'initialized') {
      acknowledged = true;
      return;
    }
    assert.ok(acknowledged, 'Client must acknowledge initialization');
    if (method === 'account/read') {
      assert.equal(params.refreshToken, false);
      response(id, {
        account: {
          type: 'chatgpt',
          email: 'fixture@example.invalid',
          planType: 'plus',
        },
        requiresOpenaiAuth: true,
      });
    } else if (method === 'account/rateLimits/read') {
      assert.deepEqual(params, {});
      assert.deepEqual(methods, [
        'initialize',
        'initialized',
        'account/read',
        'account/rateLimits/read',
      ]);
      if (process.env.NESVO_FIXTURE_USAGE_LOG)
        writeFileSync(
          process.env.NESVO_FIXTURE_USAGE_LOG,
          JSON.stringify({ provider: 'Codex', pid: process.pid, methods }) +
            '\n',
          { flag: 'a' },
        );
      const control = process.env.NESVO_FIXTURE_USAGE_CONTROL
        ? JSON.parse(
            readFileSync(process.env.NESVO_FIXTURE_USAGE_CONTROL, 'utf8'),
          )
        : {};
      await new Promise(resolve => setTimeout(resolve, 150));
      response(id, {
        rateLimits: {
          limitId: 'codex',
          limitName: 'Codex',
          primary:
            control.Codex === 'unavailable'
              ? null
              : {
                  usedPercent: control.Codex === 'exhausted' ? 100 : 25,
                  windowDurationMins: 300,
                  resetsAt:
                    Date.parse(
                      control.Codex === 'exhausted'
                        ? '2099-01-02T03:04:05.000Z'
                        : '2030-01-02T03:04:05.000Z',
                    ) / 1000,
                },
          secondary:
            control.Codex === 'unavailable'
              ? null
              : {
                  usedPercent: 40,
                  windowDurationMins: 10080,
                  resetsAt: Date.parse('2030-01-07T03:04:05.000Z') / 1000,
                },
        },
        rateLimitsByLimitId: null,
        ordinaryUsageAllowed: control.Codex === 'exhausted' ? false : true,
      });
    } else if (method === 'config/read') {
      assert.equal(params.includeLayers, false);
      if (
        typeof params.cwd === 'string' &&
        basename(params.cwd).startsWith('skills-')
      ) {
        skillsDirectory = params.cwd;
        skillsTrace(skillsDirectory, method);
      }
      response(id, { config: isolatedConfig, origins: {}, layers: null });
    } else if (method === 'skills/extraRoots/set') {
      assert.ok(Array.isArray(params.extraRoots));
      assert.ok(params.extraRoots.length > 0);
      extraRoots = params.extraRoots;
      assert.equal(new Set(extraRoots).size, extraRoots.length);
      for (const root of extraRoots) {
        assert.ok(isAbsolute(root));
        assert.equal(realpathSync(root), root);
        assert.ok(statSync(root).isDirectory());
      }
      response(id, {});
    } else if (method === 'skills/list') {
      assert.equal(params.forceReload, true);
      assert.equal(params.cwds.length, 1);
      const directory = params.cwds[0];
      assert.ok(isAbsolute(directory));
      assert.equal(
        methods.some(method => forbiddenSkillMethods.has(method)),
        false,
      );
      skillsDirectory = directory;
      skillsTrace(directory, method);
      if (basename(directory) === 'skills-unsupported') {
        emit({
          id,
          error: {
            code: -32601,
            message:
              'Skills inventory is not supported by this fixture version.',
          },
        });
        return;
      }
      if (basename(directory) === 'skills-malformed') {
        response(id, { data: 'malformed catalog' });
        return;
      }
      if (basename(directory) === 'skills-hold')
        await new Promise(resolve => setTimeout(resolve, 4000));
      const skills = [
        {
          name: 'Fixture project skill',
          description: 'Project metadata supplied by the native fixture.',
          path: join(
            directory,
            '.agents',
            'skills',
            'fixture-project-skill',
            'SKILL.md',
          ),
          scope: 'repo',
          enabled: true,
        },
        {
          name: 'Fixture user skill',
          description: 'Disabled user metadata supplied by the native fixture.',
          path: join(
            process.env.CODEX_HOME ?? dirname(directory),
            'skills',
            'fixture-native-disabled',
            'SKILL.md',
          ),
          scope: 'user',
          enabled: false,
        },
      ];
      for (const root of extraRoots) {
        const path = join(root, 'SKILL.md');
        if (!existsSync(path) || skills.some(skill => skill.path === path))
          continue;
        const body = readFileSync(path, 'utf8');
        const name = /^name:\s*(.+)$/m.exec(body)?.[1]?.trim();
        if (!name) continue;
        skills.push({
          name,
          description:
            /^description:\s*(.+)$/m.exec(body)?.[1]?.trim() ??
            'Registered fixture source.',
          path,
          scope:
            root.startsWith(process.env.CLAUDE_CONFIG_DIR ?? '\0') ||
            root.startsWith(process.env.CODEX_HOME ?? '\0')
              ? 'user'
              : 'repo',
          enabled: !/^enabled:\s*false\s*$/m.test(body),
        });
      }
      const staleMarker = join(
        process.env.NESVO_CODEX_FIXTURE_STATE_DIR ?? directory,
        'skills-stale.disabled',
      );
      if (basename(directory) === 'skills-stale' && existsSync(staleMarker))
        skills[0].enabled = false;
      if (basename(directory) === 'skills-partial')
        skills.push({
          name: 123,
          path: 'invalid',
          scope: 'repo',
          enabled: true,
        });
      response(id, { data: [{ cwd: directory, skills, errors: [] }] });
      selectedSkills = skills;
      skillsTrace(directory, 'skills/list:completed', { extraRoots });
    } else if (method === 'model/list') {
      assert.equal(params.includeHidden, false);
      response(id, {
        data: [
          {
            id: 'fixture-catalog-id',
            model: 'fixture-codex',
            displayName: 'Codex fixture',
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fixture low effort' },
              {
                reasoningEffort: 'medium',
                description: 'Fixture medium effort',
              },
              { reasoningEffort: 'high', description: 'Fixture high effort' },
            ].filter(
              option =>
                !process.env.NESVO_CODEX_FIXTURE_CATALOG ||
                !existsSync(process.env.NESVO_CODEX_FIXTURE_CATALOG) ||
                JSON.parse(
                  readFileSync(process.env.NESVO_CODEX_FIXTURE_CATALOG, 'utf8'),
                ).efforts.includes(option.reasoningEffort),
            ),
            defaultReasoningEffort: 'medium',
          },
        ],
        nextCursor: null,
      });
    } else if (method === 'thread/start' || method === 'thread/resume') {
      assert.ok(isAbsolute(params.cwd));
      assert.ok(['read-only', 'workspace-write'].includes(params.sandbox));
      const supervised = params.sandbox === 'workspace-write';
      assert.equal(params.approvalPolicy, supervised ? 'untrusted' : 'never');
      assert.equal(params.approvalsReviewer, 'user');
      assert.ok(params.model === undefined || params.model === 'fixture-codex');
      const resumed = method === 'thread/resume';
      const effort = params.config?.model_reasoning_effort ?? null;
      assert.ok(
        effort === null || ['low', 'medium', 'high'].includes(effort),
        'Reasoning effort must come from the reported catalog',
      );
      if (process.env.NESVO_FIXTURE_LAUNCH_LOG)
        writeFileSync(
          process.env.NESVO_FIXTURE_LAUNCH_LOG,
          JSON.stringify({
            provider: 'Codex',
            cwd: params.cwd,
            args,
            experimentalApi,
            sandbox: params.sandbox,
            approvalPolicy: params.approvalPolicy,
            approvalsReviewer: params.approvalsReviewer,
            dynamicTools: (params.dynamicTools ?? []).map(tool => tool.name),
            environment: runEnvironment(),
          }) + '\n',
          { flag: 'a' },
        );
      thread = {
        id: resumed ? params.threadId : randomUUID(),
        cwd: params.cwd,
        supervised,
        resumed,
        effort,
      };
      assert.equal(
        existsSync(statePath(thread.id)),
        resumed,
        'Resume requires existing native thread state',
      );
      if (resumed) assert.equal(params.excludeTurns, true);
      if (resumed) {
        assert.equal(
          params.dynamicTools,
          undefined,
          'Resume must keep the saved native tool metadata',
        );
        assert.equal(
          experimentalApi,
          JSON.parse(readFileSync(statePath(thread.id), 'utf8'))
            .delegationEnabled,
        );
      } else {
        const tools = params.dynamicTools ?? [];
        assert.equal(tools.length, experimentalApi ? 1 : 0);
        if (experimentalApi) {
          assert.equal(tools[0].name, 'nesvo_delegate');
          assert.equal(tools[0].type, 'function');
          assert.ok(tools[0].inputSchema.properties.workers);
        }
        writeFileSync(
          statePath(thread.id),
          JSON.stringify({ turns: 0, delegationEnabled: experimentalApi }),
        );
      }
      response(id, {
        thread: { id: thread.id, turns: [] },
        model: 'fixture-codex',
        reasoningEffort: thread.effort,
        approvalPolicy: params.approvalPolicy,
        sandbox: policy(),
        cwd: thread.cwd,
      });
    } else if (method === 'turn/start') {
      assert.equal(params.threadId, thread.id);
      assert.equal(params.cwd, thread.cwd);
      const readOnlyTurn =
        thread.supervised && params.sandboxPolicy?.type === 'readOnly';
      assert.equal(
        params.approvalPolicy,
        thread.supervised && !readOnlyTurn ? 'untrusted' : 'never',
      );
      assert.equal(params.approvalsReviewer, 'user');
      assert.deepEqual(
        params.sandboxPolicy,
        readOnlyTurn ? { type: 'readOnly', networkAccess: false } : policy(),
      );
      assert.equal(params.effort ?? null, thread.effort);
      assert.equal(params.input.length, selectedSkills ? 2 : 1);
      assert.equal(params.input[0].type, 'text');
      assert.ok(params.input[0].text.trim());
      if (selectedSkills) {
        const selectedSkill = selectedSkills.find(
          skill =>
            skill.path === params.input[1].path &&
            skill.name === params.input[1].name,
        );
        assert.ok(
          selectedSkill,
          'Selected native input must match the current registered catalog',
        );
        assert.equal(selectedSkill.enabled, true);
        assert.deepEqual(params.input[1], {
          type: 'skill',
          name: selectedSkill.name,
          path: selectedSkill.path,
        });
      }
      const state = JSON.parse(readFileSync(statePath(thread.id), 'utf8'));
      state.turns += 1;
      writeFileSync(statePath(thread.id), JSON.stringify(state));
      current = { id: randomUUID(), itemId: randomUUID(), completed: false };
      response(id, {
        turn: { id: current.id, status: 'inProgress', items: [], error: null },
      });
      notify('turn/started', {
        threadId: thread.id,
        turn: { id: current.id, status: 'inProgress', items: [], error: null },
      });
      notify(
        'item/started',
        scoped({
          item: { id: current.itemId, type: 'agentMessage', text: '' },
        }),
      );
      const prompt = params.input[0].text;
      if (process.env.NESVO_CODEX_FIXTURE_RUN_LOG)
        writeFileSync(
          process.env.NESVO_CODEX_FIXTURE_RUN_LOG,
          JSON.stringify({
            sessionId: thread.id,
            prompt,
            effort: params.effort ?? null,
            sandbox: params.sandboxPolicy.type,
            environment: runEnvironment(),
          }) + '\n',
          { flag: 'a' },
        );
      const requestPrompt = prompt.split(
        '\n\nRecovery context supplied by the host, not authorization to repeat previous operations:',
      )[0];
      const command = requestPrompt.split('\n')[0].trim();
      const worker =
        /fixture:worker-(hold|complete|fail|recursive):([a-z])/.exec(
          requestPrompt,
        );
      if (worker) {
        assert.equal(
          experimentalApi,
          false,
          'Workers must not receive dynamic delegation tools',
        );
        if (worker[1] === 'hold') await hold(worker[2]);
        else if (worker[1] === 'recursive') delegate('recursive');
        else if (worker[1] === 'fail') {
          notify('turn/completed', {
            threadId: thread.id,
            turn: {
              id: current.id,
              status: 'failed',
              error: { message: `Codex worker ${worker[2]} failed.` },
              items: [],
            },
          });
        } else complete(`Codex worker ${worker[2]} completed its scoped task.`);
      } else if (requestPrompt.includes('fixture:review-binary')) {
        assert.equal(thread.supervised, true);
        writeFileSync(
          join(thread.cwd, 'binary.bin'),
          Buffer.from([0, 1, 0, 2]),
        );
        complete('Codex fixture binary result.');
      } else if (requestPrompt.includes('fixture:review-correct')) {
        assert.equal(thread.supervised, true);
        assert.equal(
          thread.resumed,
          true,
          'Correction must resume the same native thread',
        );
        writeFileSync(
          join(thread.cwd, 'tracked.txt'),
          'corrected agent text\n',
        );
        writeFileSync(
          join(thread.cwd, 'created.txt'),
          'corrected created text\n',
        );
        complete('Codex fixture corrected files.');
      } else if (requestPrompt.includes('fixture:review-write')) {
        assert.equal(thread.supervised, true);
        writeFileSync(join(thread.cwd, 'tracked.txt'), 'initial agent text\n');
        writeFileSync(
          join(thread.cwd, 'created.txt'),
          'initial created text\n',
        );
        unlinkSync(join(thread.cwd, 'deleted.txt'));
        complete('Codex fixture initial files.');
      } else if (/^fixture:delegate(?:-|$)/.test(command)) {
        delegate(command.slice('fixture:delegate-'.length) || 'default');
      } else if (command === 'fixture:disconnect') {
        delta('Codex fixture disconnected.');
        await new Promise(resolve => process.stdout.write('', resolve));
        process.exit(73);
      } else if (command === 'fixture:stream') {
        const read = commandItem('read', {
          command: 'read sample.txt',
          commandActions: [
            { type: 'read', path: 'sample.txt', name: 'sample.txt' },
          ],
        });
        const command = commandItem('count');
        tool('started', read);
        tool('started', command);
        notify(
          'item/commandExecution/outputDelta',
          scoped({
            itemId: command.id,
            delta: '\u001b[32mcount=5\u001b[0m\nAPI_TO',
          }),
        );
        notify(
          'item/commandExecution/outputDelta',
          scoped({ itemId: command.id, delta: 'KEN=fixture-secret\n' }),
        );
        delta('Codex fixture streamed ');
        setTimeout(() => {
          tool('completed', { ...read, status: 'completed', exitCode: 0 });
          tool('completed', {
            ...command,
            status: 'completed',
            exitCode: 0,
            aggregatedOutput:
              '\u001b[32mcount=5\u001b[0m\nAPI_TOKEN=fixture-secret\n',
          });
          tool('started', command);
          tokenUsage(
            { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 50 },
            { inputTokens: 5000, cachedInputTokens: 1200, outputTokens: 400 },
          );
          delta('reply.');
          tokenUsage(
            { inputTokens: 1500, cachedInputTokens: 600, outputTokens: 80 },
            { inputTokens: 6500, cachedInputTokens: 1800, outputTokens: 480 },
          );
          complete('Codex fixture streamed reply.', 1800);
        }, 300);
      } else if (command === 'fixture:activities') {
        for (let index = 0; index < 105; index++) {
          const item = commandItem(String(index));
          tool('started', item);
          if (index === 104) continue;
          tool('completed', {
            ...item,
            status: 'completed',
            exitCode: index === 6 ? 7 : 0,
            aggregatedOutput:
              index === 7
                ? 'line\n'.repeat(1500) + 'API_TOKEN=fixture-secret\n'
                : 'count=5\n',
          });
        }
        tool('completed', {
          ...commandItem('0'),
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: 'late evicted output',
        });
        complete('Codex fixture bounded activities.');
      } else if (command === 'fixture:approve' || command === 'fixture:file') {
        requestApproval(command === 'fixture:file' ? 'file' : 'command');
      } else if (command === 'fixture:missing-command') {
        requestApproval('command', 'missing-command');
      } else if (command === 'fixture:missing-changes') {
        requestApproval('file', 'missing-changes');
      } else if (command === 'fixture:oversize-approval') {
        requestApproval('command', 'oversize');
      } else if (command === 'fixture:remote-environment') {
        requestApproval('command', 'remote-environment');
      } else if (command === 'fixture:approval-hold') {
        await hold();
        requestApproval('command');
      } else if (command === 'fixture:hold') {
        await hold();
      } else if (command === 'fixture:hold-disconnect') {
        await hold();
        await new Promise(resolve => setTimeout(resolve, 2500));
        process.exit(73);
      } else {
        complete(
          `Codex fixture ${thread.resumed ? 'resumed' : 'initial'} reply.`,
        );
      }
    } else if (method === 'turn/interrupt') {
      assert.equal(params.threadId, thread.id);
      assert.equal(params.turnId, current.id);
      response(id, {});
      current.completed = true;
      notify('turn/completed', {
        threadId: thread.id,
        turn: { id: current.id, status: 'interrupted', error: null, items: [] },
      });
    } else {
      assert.fail(`Unexpected native method: ${method}`);
    }
  };
  for await (const line of lines) await handle(JSON.parse(line));
}
