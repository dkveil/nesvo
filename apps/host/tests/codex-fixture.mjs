import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
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
  let thread;
  let current;
  const approvals = new Map();
  const response = (id, result) => emit({ id, result });
  const notify = (method, params) => emit({ method, params });
  const statePath = id => join(thread.cwd, `.nesvo-codex-fixture-${id}.json`);
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
  const complete = text => {
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
      turn: { id: current.id, status: 'completed', items: [], error: null },
    });
  };
  const delta = text =>
    notify(
      'item/agentMessage/delta',
      scoped({ itemId: current.itemId, delta: text }),
    );
  const hold = async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    assert.ok(process.env.NESVO_CODEX_FIXTURE_PID_FILE);
    writeFileSync(
      process.env.NESVO_CODEX_FIXTURE_PID_FILE,
      JSON.stringify({
        pid: process.pid,
        childPid: child.pid,
        sessionId: thread.id,
      }),
    );
    delta('Codex fixture is waiting.');
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
              environmentId: null,
              commandActions: [],
            }
          : { grantRoot: null }),
      }),
    });
  };
  const handle = async message => {
    if (!message.method) {
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
    if (method === 'initialize') {
      assert.equal(initialized, false);
      assert.equal(params.clientInfo.name, 'nesvo');
      initialized = true;
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
    } else if (method === 'config/read') {
      assert.equal(params.includeLayers, false);
      response(id, { config: isolatedConfig, origins: {}, layers: null });
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
      thread = {
        id: resumed ? params.threadId : randomUUID(),
        cwd: params.cwd,
        supervised,
        resumed,
      };
      assert.equal(
        existsSync(statePath(thread.id)),
        resumed,
        'Resume requires existing native thread state',
      );
      if (resumed) assert.equal(params.excludeTurns, true);
      else writeFileSync(statePath(thread.id), JSON.stringify({ turns: 0 }));
      response(id, {
        thread: { id: thread.id, turns: [] },
        model: 'fixture-codex',
        approvalPolicy: params.approvalPolicy,
        sandbox: policy(),
        cwd: thread.cwd,
      });
    } else if (method === 'turn/start') {
      assert.equal(params.threadId, thread.id);
      assert.equal(params.cwd, thread.cwd);
      assert.equal(
        params.approvalPolicy,
        thread.supervised ? 'untrusted' : 'never',
      );
      assert.equal(params.approvalsReviewer, 'user');
      assert.deepEqual(params.sandboxPolicy, policy());
      assert.equal(params.input.length, 1);
      assert.equal(params.input[0].type, 'text');
      assert.ok(params.input[0].text.trim());
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
      if (prompt === 'fixture:stream') {
        delta('Codex fixture streamed ');
        setTimeout(() => {
          delta('reply.');
          complete('Codex fixture streamed reply.');
        }, 300);
      } else if (prompt === 'fixture:approve' || prompt === 'fixture:file') {
        requestApproval(prompt === 'fixture:file' ? 'file' : 'command');
      } else if (prompt === 'fixture:missing-command') {
        requestApproval('command', 'missing-command');
      } else if (prompt === 'fixture:missing-changes') {
        requestApproval('file', 'missing-changes');
      } else if (prompt === 'fixture:oversize-approval') {
        requestApproval('command', 'oversize');
      } else if (prompt === 'fixture:approval-hold') {
        await hold();
        requestApproval('command');
      } else if (prompt === 'fixture:hold') {
        await hold();
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
