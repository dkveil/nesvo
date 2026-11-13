import { join } from 'node:path';
import {
  desktopPipelineRunSchema,
  desktopPipelineStepRecordSchema,
  desktopSessionSchema,
  getPipelineRunSchema,
  readPipelineEvidenceSchema,
  skipPipelineStepSchema,
  type DesktopPipelineRun,
  type DesktopPipelineStepRecord,
  type DesktopSession,
  type PipelineEvidence,
  type PipelineMethod,
  type PipelineStepState,
  type ResolvedStep,
  type StepResult,
  type WorkspaceEvent,
} from '@nesvo/contracts';

type PipelineDemoOptions = {
  directory: string;
  publish: (event: WorkspaceEvent) => void;
  now?: number;
};

type StepPlan = {
  state: PipelineStepState;
  attempt?: number;
  summary?: string;
  durationMs?: number;
  evidence?: StepResult['evidence'];
  outputs?: Record<string, string>;
  sessionId?: string;
};

type RunPlan = {
  title: string;
  spec: string;
  status: DesktopPipelineRun['status'];
  attention?: string;
  provider: DesktopSession['provider'];
  minutesAgo: number;
  steps: StepPlan[];
  agentSession?: { step: number; title: string };
};

const DEMO_METHODS = new Set<PipelineMethod>([
  'list-pipeline-runs',
  'get-pipeline-run',
  'read-pipeline-evidence',
  'stop-pipeline-run',
  'resume-pipeline-run',
  'skip-pipeline-step',
]);

const HASH = 'a'.repeat(64);
const MINUTE_MS = 60_000;

const demoId = (group: number, item: number) =>
  `5e1d${String(group).padStart(4, '0')}-0000-4000-8000-${String(item).padStart(12, '0')}`;

const stepDefinitions = (root: string): ResolvedStep[] =>
  (
    [
      ['plan-review', 'agent', 'plan', 'plan-review', 0, 'stop'],
      ['typecheck', 'command', 'pre-done', null, 1, 'fix'],
      ['unit-tests', 'command', 'pre-done', null, 2, 'fix'],
      ['code-review', 'agent', 'pre-done', 'code-review', 1, 'fix'],
      ['owner-approval', 'human', 'pre-push', null, 0, 'stop'],
      ['open-draft-pr', 'action', 'pre-push', null, 0, 'stop'],
    ] as const
  ).map(([name, type, phase, skill, retries, onFail]) => ({
    name,
    type,
    phase,
    skill,
    timeout: '15m',
    retries,
    on_fail: onFail,
    needs: [],
    body:
      type === 'command'
        ? name === 'typecheck'
          ? 'bun run typecheck'
          : 'bun test'
        : `Demo ${name} step.`,
    source: {
      scope: 'project',
      path: join(root, '.agents', 'pipelines', 'steps', `${name}.md`),
      contentHash: HASH,
    },
    notes: [],
  }));

const failingLog = `$ bun test
bun test v1.4.0

src/login/login-form.test.tsx:
✓ renders the email and password fields [12.40ms]
✓ disables submit while sending [8.10ms]
✗ shows a validation message next to the email field [21.95ms]

  error: expect(received).toBeVisible()
  Received element is not visible:
    <p id="email-error" hidden>Enter a valid email address.</p>

      at src/login/login-form.test.tsx:41:38

✗ keeps the typed password after a failed attempt [15.02ms]

  error: expect(received).toHaveValue(expected)
  Expected: "correct horse"
  Received: ""

      at src/login/login-form.test.tsx:58:31

 2 pass
 2 fail
 9 expect() calls
Ran 4 tests across 1 file. [412.00ms]
error: script "test" exited with code 1
`;

const passingLog = `$ bun run typecheck
$ tsc --noEmit
Checked 214 files in 3.1s. No errors.
`;

const plans = (): RunPlan[] => [
  {
    title: 'Add the login form',
    spec: 'add-login-form.md',
    status: 'checking',
    provider: 'Codex',
    minutesAgo: 9,
    steps: [
      {
        state: 'passed',
        summary: 'The plan covers both acceptance criteria.',
        durationMs: 48_000,
      },
      { state: 'passed', summary: 'No type errors.', durationMs: 3_400 },
      { state: 'running', attempt: 2 },
      { state: 'pending' },
      { state: 'pending' },
      { state: 'pending' },
    ],
  },
  {
    title: 'Fix the date format in invoices',
    spec: 'fix-date-format.md',
    status: 'passed',
    provider: 'Codex',
    minutesAgo: 95,
    agentSession: {
      step: 3,
      title: 'code-review · Fix the date format in invoices',
    },
    steps: [
      {
        state: 'passed',
        summary: 'The plan is limited to the invoice header.',
        durationMs: 31_000,
      },
      { state: 'passed', summary: 'No type errors.', durationMs: 2_900 },
      { state: 'passed', summary: '18 tests passed.', durationMs: 6_200 },
      {
        state: 'passed',
        summary:
          'Dates use the ISO format and the formatter is covered by a test.',
        durationMs: 142_000,
      },
      {
        state: 'passed',
        summary: 'Accepted by the operator.',
        durationMs: 410_000,
      },
      {
        state: 'done',
        summary: 'Pushed the task branch and opened a draft pull request.',
        durationMs: 7_800,
        outputs: {
          pr: 'https://example.invalid/demo-app/pull/42',
          branch: 'nesvo/fix-date-format-5e1d0002',
        },
        evidence: [
          {
            kind: 'link',
            label: 'Draft pull request',
            path: null,
            text: null,
            url: 'https://example.invalid/demo-app/pull/42',
          },
        ],
      },
    ],
  },
  {
    title: 'Validate the signup email',
    spec: 'add-login-form.md',
    status: 'needs-attention',
    attention: 'unit-tests failed after 3 attempts.',
    provider: 'Codex',
    minutesAgo: 42,
    steps: [
      {
        state: 'passed',
        summary: 'The plan covers the acceptance criteria.',
        durationMs: 39_000,
      },
      {
        state: 'passed',
        summary: 'No type errors.',
        durationMs: 3_100,
        evidence: [
          {
            kind: 'log',
            label: 'typecheck output',
            path: 'logs/typecheck-1.log',
            text: null,
            url: null,
          },
        ],
      },
      {
        state: 'failed',
        attempt: 3,
        summary:
          '2 of 4 tests failed in src/login/login-form.test.tsx: the email validation message stays hidden and the password is cleared after a failed attempt.',
        durationMs: 4_120,
        outputs: { exitCode: '1', failed: '2', passed: '2' },
        evidence: [
          {
            kind: 'log',
            label: 'bun test output',
            path: 'logs/unit-tests-3.log',
            text: null,
            url: null,
          },
          {
            kind: 'text',
            label: 'Failing test',
            path: null,
            text: 'shows a validation message next to the email field',
            url: null,
          },
        ],
      },
      { state: 'pending' },
      { state: 'pending' },
      { state: 'pending' },
    ],
  },
  {
    title: 'Rename the billing settings page',
    spec: 'fix-date-format.md',
    status: 'awaiting-human',
    provider: 'Claude Code',
    minutesAgo: 27,
    steps: [
      {
        state: 'passed',
        summary: 'The plan keeps existing routes as redirects.',
        durationMs: 28_000,
      },
      { state: 'passed', summary: 'No type errors.', durationMs: 2_700 },
      { state: 'passed', summary: '31 tests passed.', durationMs: 7_400 },
      {
        state: 'passed',
        summary: 'No blocking findings; one suggestion about a redirect test.',
        durationMs: 118_000,
      },
      { state: 'awaiting-human' },
      { state: 'pending' },
    ],
  },
  {
    title: 'Update the README badges',
    spec: 'fix-date-format.md',
    status: 'needs-attention',
    attention: 'External action may have run.',
    provider: 'Codex',
    minutesAgo: 64,
    steps: [
      {
        state: 'passed',
        summary: 'The plan touches the README only.',
        durationMs: 22_000,
      },
      { state: 'passed', summary: 'No type errors.', durationMs: 2_500 },
      { state: 'passed', summary: '18 tests passed.', durationMs: 5_900 },
      { state: 'passed', summary: 'No findings.', durationMs: 61_000 },
      {
        state: 'passed',
        summary: 'Accepted by the operator.',
        durationMs: 95_000,
      },
      { state: 'uncertain' },
    ],
  },
];

const verdicts: Record<PipelineStepState, StepResult['status'] | null> = {
  pending: null,
  running: null,
  'awaiting-human': null,
  passed: 'pass',
  failed: 'fail',
  blocked: 'blocked',
  done: 'done',
  error: 'error',
  skipped: null,
  interrupted: null,
  uncertain: null,
};

export const isPipelineDemoEnabled = (packaged: boolean) =>
  !packaged && process.env.NESVO_PIPELINE_DEMO === '1';

export const createPipelineDemo = ({
  directory,
  publish,
  now = Date.now(),
}: PipelineDemoOptions) => {
  const runs = new Map<string, DesktopPipelineRun>();
  const steps = new Map<string, DesktopPipelineStepRecord[]>();
  const sessions: DesktopSession[] = [];
  const evidence = new Map<string, string>();
  const definitions = stepDefinitions(directory);
  const at = (offsetMs: number) => new Date(now - offsetMs).toISOString();

  plans().forEach((plan, planIndex) => {
    const group = planIndex + 1;
    const runId = demoId(group, 1);
    const sessionId = demoId(group, 2);
    const created = plan.minutesAgo * MINUTE_MS;
    let elapsed = created - 20_000;
    const records: DesktopPipelineStepRecord[] = [];
    plan.steps.forEach((step, index) => {
      const definition = definitions[index]!;
      const attempts = step.attempt ?? (step.state === 'pending' ? 0 : 1);
      for (let attempt = 1; attempt <= Math.max(attempts, 1); attempt++) {
        if (step.state === 'pending' && attempt === 1 && attempts === 0) {
          records.push(
            desktopPipelineStepRecordSchema.parse({
              id: demoId(group, 100 + index * 10),
              runId,
              revision: 1,
              index,
              name: definition.name,
              type: definition.type,
              phase: definition.phase,
              state: 'pending',
              attempt: 0,
              result: null,
              sessionId: null,
              reviewId: null,
              reviewVersion: null,
              skip: null,
              updatedAt: at(created),
              startedAt: null,
              hostId: 'local',
            }),
          );
          continue;
        }
        const latest = attempt === attempts;
        const state: PipelineStepState = latest
          ? step.state
          : definition.type === 'command'
            ? 'failed'
            : step.state;
        const duration = step.durationMs ?? 3_000;
        const startedAt =
          state === 'running' ? at(47_000) : at(Math.max(elapsed, 1000));
        elapsed = Math.max(elapsed - duration - 4_000, 2_000);
        const verdict = verdicts[state];
        const stepId = demoId(group, 100 + index * 10 + attempt);
        const result: StepResult | null = verdict
          ? {
              name: definition.name,
              type: definition.type,
              phase: definition.phase,
              status: verdict,
              summary: latest
                ? (step.summary ?? '')
                : 'Tests failed; the result was sent back to the author.',
              evidence: latest ? (step.evidence ?? []) : [],
              outputs: latest ? (step.outputs ?? {}) : { exitCode: '1' },
              startedAt,
              finishedAt: new Date(
                Date.parse(startedAt) + duration,
              ).toISOString(),
              durationMs: duration,
              cost: {
                usd: definition.type === 'agent' ? 0.04 : null,
                inputTokens: definition.type === 'agent' ? 18_400 : null,
                outputTokens: definition.type === 'agent' ? 1_250 : null,
                provider:
                  definition.type === 'agent'
                    ? plan.provider === 'Codex'
                      ? 'Claude Code'
                      : 'Codex'
                    : null,
              },
              attempt,
            }
          : null;
        for (const item of latest ? (step.evidence ?? []) : [])
          if (item.path)
            evidence.set(
              `${stepId}:${item.path}`,
              item.path.includes('unit-tests') ? failingLog : passingLog,
            );
        const agentSessionId =
          plan.agentSession?.step === index ? demoId(group, 3) : null;
        records.push(
          desktopPipelineStepRecordSchema.parse({
            id: stepId,
            runId,
            revision: attempt,
            index,
            name: definition.name,
            type: definition.type,
            phase: definition.phase,
            state,
            attempt,
            result,
            sessionId: agentSessionId,
            reviewId: null,
            reviewVersion: null,
            skip: null,
            updatedAt: result?.finishedAt ?? startedAt,
            startedAt,
            hostId: 'local',
          }),
        );
      }
    });
    const current = plan.steps.findIndex(
      step =>
        step.state === 'running' ||
        step.state === 'awaiting-human' ||
        step.state === 'failed' ||
        step.state === 'uncertain',
    );
    const finished = plan.status === 'passed';
    const run = desktopPipelineRunSchema.parse({
      id: runId,
      revision: 1,
      pipeline: {
        name: 'standard',
        description:
          'Plan review, checks, code review and owner approval before a draft pull request.',
        body: '',
        source: {
          scope: 'project',
          path: join(
            directory,
            '.agents',
            'pipelines',
            'pipelines',
            'standard.md',
          ),
          contentHash: HASH,
        },
        notes: [],
        steps: definitions,
      },
      specPath: join(directory, '.agents', 'tasks', plan.spec),
      specHash: HASH,
      specTitle: plan.title,
      sessionId,
      directory,
      projectRoot: directory,
      isolation: null,
      gateProvider: plan.provider === 'Codex' ? 'Claude Code' : 'Codex',
      gateModel: plan.provider === 'Codex' ? 'sonnet' : 'gpt-5.5',
      status: plan.status,
      phase:
        current >= 0
          ? definitions[current]!.phase
          : finished
            ? 'pre-push'
            : null,
      currentStepIndex: current >= 0 ? current : null,
      attention: plan.attention ?? null,
      createdAt: at(created),
      updatedAt: at(finished ? created - 600_000 : 30_000),
      finishedAt: finished ? at(created - 600_000) : null,
      hostId: 'local',
    });
    runs.set(runId, run);
    steps.set(runId, records);
    const session = (
      id: string,
      title: string,
      provider: DesktopSession['provider'],
      stepId: string | null,
      body: string,
    ) =>
      desktopSessionSchema.parse({
        id,
        provider,
        providerSessionId: null,
        providerInitialized: false,
        title,
        model: provider === 'Codex' ? 'gpt-5.5' : 'sonnet',
        mode: 'read-only',
        actualModel: null,
        role: 'standalone',
        pipelineRunId: runId,
        pipelineStepId: stepId,
        hostId: 'local',
        directory,
        status: 'completed',
        error: null,
        activity: null,
        runId: null,
        revision: 1,
        createdAt: at(created),
        updatedAt: run.updatedAt,
        messages: [
          {
            id: demoId(group, stepId ? 21 : 11),
            runId: demoId(group, stepId ? 20 : 10),
            author: 'operator',
            body,
            state: 'completed',
            createdAt: at(created),
            completedAt: at(created),
            origin: 'pipeline',
          },
          {
            id: demoId(group, stepId ? 22 : 12),
            runId: demoId(group, stepId ? 20 : 10),
            author: 'agent',
            body: stepId
              ? 'Verdict: pass. Dates use the ISO format; the formatter has a test for the invoice header.'
              : 'Implemented the change described in the spec. The pipeline checks run next.',
            state: 'completed',
            createdAt: at(created - 60_000),
            completedAt: at(created - 240_000),
          },
        ],
      });
    sessions.push(
      session(
        sessionId,
        plan.title,
        plan.provider,
        null,
        `Task: ${plan.title}\n\nFollow the spec in .agents/tasks/${plan.spec}.`,
      ),
    );
    if (plan.agentSession) {
      const step = records.find(
        record => record.index === plan.agentSession!.step,
      );
      sessions.push(
        session(
          demoId(group, 3),
          plan.agentSession.title,
          run.gateProvider,
          step?.id ?? null,
          'Review the diff against the spec and return a verdict with evidence.',
        ),
      );
    }
  });

  const update = (
    run: DesktopPipelineRun,
    changes: Partial<DesktopPipelineRun>,
  ) => {
    const next = desktopPipelineRunSchema.parse({
      ...run,
      ...changes,
      revision: run.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    runs.set(next.id, next);
    publish({ type: 'pipeline-run-changed', run: next });
    return next;
  };
  const updateStep = (
    record: DesktopPipelineStepRecord,
    changes: Partial<DesktopPipelineStepRecord>,
  ) => {
    const next = desktopPipelineStepRecordSchema.parse({
      ...record,
      ...changes,
      revision: record.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    const list = steps.get(record.runId) ?? [];
    steps.set(
      record.runId,
      list.map(item => (item.id === record.id ? next : item)),
    );
    publish({ type: 'pipeline-step-changed', step: next });
    return next;
  };
  const owned = (runId: string) => {
    const run = runs.get(runId);
    if (!run) throw new Error('This demo run does not exist.');
    return run;
  };

  const stop = (runId: string) => {
    const run = owned(runId);
    for (const record of steps.get(runId) ?? [])
      if (record.state === 'running' || record.state === 'awaiting-human')
        updateStep(record, { state: 'interrupted' });
    return update(run, {
      status: 'stopped',
      attention: null,
      finishedAt: new Date().toISOString(),
    });
  };
  const resume = (runId: string) => {
    const run = owned(runId);
    if (run.status !== 'needs-attention' && run.status !== 'interrupted')
      throw new Error('Only a run that needs attention can resume.');
    const list = steps.get(runId) ?? [];
    const blocked = list
      .filter(record => record.index === run.currentStepIndex)
      .sort((a, b) => b.attempt - a.attempt)[0];
    if (blocked) {
      const next = desktopPipelineStepRecordSchema.parse({
        ...blocked,
        id: demoId(Number(runId.slice(4, 8)), 900 + blocked.attempt),
        revision: 1,
        state: 'running',
        attempt: blocked.attempt + 1,
        result: null,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      steps.set(runId, [...list, next]);
      publish({ type: 'pipeline-step-changed', step: next });
    }
    return update(run, { status: 'checking', attention: null });
  };

  const skip = (runId: string, stepId: string, reason: string) => {
    const run = owned(runId);
    const record = (steps.get(runId) ?? []).find(item => item.id === stepId);
    if (!record) throw new Error('This demo step does not exist.');
    const latestAttempt = Math.max(
      ...(steps.get(runId) ?? [])
        .filter(item => item.index === record.index)
        .map(item => item.attempt),
    );
    if (
      record.state !== 'uncertain' ||
      record.attempt !== latestAttempt ||
      !['needs-attention', 'interrupted'].includes(run.status)
    )
      throw new Error('Only the latest uncertain action can be skipped.');
    const at = new Date().toISOString();
    updateStep(record, { state: 'skipped', skip: { reason, at } });
    const latest = new Map<number, DesktopPipelineStepRecord>();
    for (const item of steps.get(runId) ?? [])
      if ((latest.get(item.index)?.attempt ?? -1) < item.attempt)
        latest.set(item.index, item);
    const finished = run.pipeline.steps.every((_, index) =>
      ['passed', 'done', 'skipped'].includes(latest.get(index)?.state ?? ''),
    );
    return update(run, {
      status: finished ? 'passed' : 'checking',
      attention: null,
      currentStepIndex: finished ? null : run.currentStepIndex,
      finishedAt: finished ? at : null,
    });
  };

  return {
    sessions: () => sessions,
    serves: (method: PipelineMethod, input: unknown, hostId: string) => {
      if (hostId !== 'local' || !DEMO_METHODS.has(method)) return false;
      if (method === 'list-pipeline-runs') return true;
      const parsed = getPipelineRunSchema
        .partial()
        .safeParse(
          typeof input === 'object' && input && 'runId' in input
            ? { runId: input.runId }
            : {},
        );
      return !!parsed.data?.runId && runs.has(parsed.data.runId);
    },
    execute: (method: PipelineMethod, input: unknown) => {
      switch (method) {
        case 'list-pipeline-runs':
          return {
            runs: [...runs.values()].sort((a, b) =>
              b.updatedAt.localeCompare(a.updatedAt),
            ),
            nextCursor: null,
          };
        case 'get-pipeline-run': {
          const { runId } = getPipelineRunSchema.parse(input);
          return { run: owned(runId), steps: steps.get(runId) ?? [] };
        }
        case 'read-pipeline-evidence': {
          const request = readPipelineEvidenceSchema.parse(input);
          const text = evidence.get(`${request.stepId}:${request.path}`);
          return (
            text
              ? { status: 'text', text, bytes: Buffer.byteLength(text) }
              : { status: 'missing', text: null, bytes: 0 }
          ) satisfies PipelineEvidence;
        }
        case 'stop-pipeline-run':
          return stop(getPipelineRunSchema.parse(input).runId);
        case 'resume-pipeline-run':
          return resume(getPipelineRunSchema.parse(input).runId);
        case 'skip-pipeline-step': {
          const request = skipPipelineStepSchema.parse(input);
          return skip(request.runId, request.stepId, request.reason);
        }
        default:
          throw new Error('This demo does not serve that pipeline command.');
      }
    },
  };
};

export type PipelineDemo = ReturnType<typeof createPipelineDemo>;
