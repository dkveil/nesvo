import {
  createSessionSchema,
  findPullRequestUrls,
  type DesktopEvent,
  type WorkflowChildReport,
  type WorkflowChildSession,
  type WorkflowRun,
} from '@nesvo/contracts';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SessionService } from '../sessions/service';
import type { SessionStore } from '../sessions/store';
import { loadCatalog, resolveWorkflow, resolveWriteRoots } from './definitions';
import { filterResultText } from './evidence';
import { deterministicId, type StepExecution } from './runner';
import type { WorkflowRunStore } from './store';
import type { SpecSnapshots } from './tasks';

type ChildSessions = Pick<
  SessionService,
  'createWithEffort' | 'folderBusyMessage'
>;

const scrub = (text: string, length: number) =>
  filterResultText(text).slice(0, length);

const hasActiveWorkflow = (status: WorkflowRun['status']) =>
  status === 'pending' ||
  status === 'planning' ||
  status === 'implementing' ||
  status === 'checking' ||
  status === 'awaiting-human' ||
  status === 'fixing';

function runIdOf(execution: StepExecution, index: number): string {
  return deterministicId(
    `workflow-child:${execution.run.id}:${execution.step.id}:${index}`,
  );
}

export function childReport(
  status: WorkflowChildReport['status'],
  summary: string,
): WorkflowChildReport {
  return {
    status,
    summary: scrub(summary, 2000),
    links: [],
    notes: [],
    outputs: {},
  };
}

export class ChildRuns {
  constructor(
    private readonly ports: {
      workflows: WorkflowRunStore;
      store: Pick<SessionStore, 'get' | 'createdSessionId'>;
      sessions: ChildSessions;
      snapshots: SpecSnapshots;
      emit: (event: DesktopEvent) => void;
      advance: (runId: string) => Promise<void>;
      stop: (runId: string) => void;
      stopSetup: (sessionId: string) => void;
    },
  ) {}

  run(execution: StepExecution, index: number): WorkflowRun | undefined {
    return this.ports.workflows.getRun(runIdOf(execution, index));
  }

  createdSessionId(execution: StepExecution, index: number): string | null {
    return this.ports.store.createdSessionId(runIdOf(execution, index)) ?? null;
  }

  folderWait(
    execution: StepExecution,
    definition: WorkflowChildSession,
  ): string | null {
    if (definition.worktree) return null;
    return this.ports.sessions.folderBusyMessage(
      resolve(execution.run.directory, definition.directory ?? '.'),
      definition.mode === 'read-only' ? 'read' : 'write',
    );
  }

  async start(
    execution: StepExecution,
    definition: WorkflowChildSession,
    item: { index: number; title: string; prompt: string },
  ): Promise<WorkflowRun> {
    const runId = runIdOf(execution, item.index);
    const existing = this.ports.workflows.getRun(runId);
    if (existing) return existing;
    const { run, signal, step } = execution;
    const depth = (run.parent?.depth ?? 0) + 1;
    const maxDepth = Math.min(
      run.parent?.maxDepth ?? 8,
      execution.definition.max_depth ?? run.parent?.maxDepth ?? 2,
    );
    if (depth > maxDepth)
      throw new Error(`Nested workflow depth limit reached (${maxDepth}).`);
    const parent = run.sessionId && this.ports.store.get(run.sessionId);
    if (!parent) throw new Error('The parent session is unavailable.');
    let directory: string;
    try {
      directory = realpathSync(
        resolve(run.directory, definition.directory ?? '.'),
      );
      if (!statSync(directory).isDirectory()) throw new Error();
    } catch {
      throw new Error(
        'The child session folder does not exist or cannot be accessed.',
      );
    }
    const workflow = resolveWorkflow(
      definition.workflow,
      await loadCatalog(directory, signal),
    );
    const { projectRoot } = await resolveWriteRoots(directory, signal);
    signal.throwIfAborted();
    const session = await this.ports.sessions.createWithEffort(
      createSessionSchema.parse({
        requestId: runId,
        title: item.title,
        provider: definition.provider,
        model: definition.model,
        effort: definition.effort,
        mode: definition.mode,
        directory,
        ...(definition.worktree ? { isolation: { kind: 'worktree' } } : {}),
        ...(parent.groupId ? { groupId: parent.groupId } : {}),
      }),
      signal,
      parent.id,
    );
    const now = execution.now().toISOString();
    const stopped = signal.aborted;
    const child: WorkflowRun = {
      id: runId,
      revision: 1,
      workflow,
      specPath: run.specPath,
      specHash: createHash('sha256').update(item.prompt).digest('hex'),
      specTitle: item.title,
      sessionId: session.id,
      parent: {
        runId: run.id,
        stepId: step.id,
        index: item.index,
        depth,
        maxDepth,
      },
      directory: session.directory,
      projectRoot,
      isolation: session.worktree
        ? {
            worktree: session.directory,
            branch: session.worktree.branch,
            base: session.worktree.base,
          }
        : null,
      gateProvider: run.gateProvider,
      gateModel: run.gateModel,
      status: stopped ? 'stopped' : 'pending',
      phase: null,
      currentStepIndex: null,
      attention: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: stopped ? now : null,
    };
    this.ports.snapshots.write(runId, item.prompt);
    this.ports.workflows.transact(() => {
      if (
        !this.ports.workflows.insertRun(child) ||
        !this.ports.workflows.linkSession(session.id, runId, null)
      )
        throw new Error('Could not link the child workflow to its session.');
    });
    this.ports.emit({ type: 'workflow-run-changed', run: child });
    if (stopped) this.ports.stopSetup(session.id);
    else void this.ports.advance(runId).catch(() => undefined);
    return child;
  }

  report(run: WorkflowRun): WorkflowChildReport | null {
    const status = run.status;
    if (hasActiveWorkflow(status)) return null;
    const session = run.sessionId
      ? this.ports.store.get(run.sessionId)
      : undefined;
    const requestIds = new Set(
      session?.messages
        .filter(
          message =>
            message.author === 'operator' && message.origin === 'workflow',
        )
        .map(message => message.runId),
    );
    const reply = session?.messages.findLast(
      message =>
        message.author === 'agent' &&
        message.state === 'completed' &&
        requestIds.has(message.runId),
    )?.body;
    const results = [
      ...new Map(
        this.ports.workflows
          .stepsForRun(run.id)
          .map(step => [step.index, step.result] as const),
      ).values(),
    ].filter(result => result !== null);
    const report = childReport(
      status,
      run.attention ?? reply ?? `Workflow ${status}.`,
    );
    report.notes = results
      .flatMap(result =>
        result.summary ? [scrub(`${result.name}: ${result.summary}`, 800)] : [],
      )
      .slice(-8);
    report.outputs = Object.fromEntries(
      Object.entries(
        Object.assign({}, ...results.map(result => result.outputs)),
      )
        .slice(0, 8)
        .map(([key, value]) => [key, scrub(String(value), 1000)]),
    );
    const mentions = [
      ...(session?.pullRequest ? [session.pullRequest] : []),
      ...findPullRequestUrls(
        [
          reply ?? '',
          ...results.flatMap(result => Object.values(result.outputs)),
        ].join('\n'),
      ),
    ];
    report.links = [
      ...new Set(
        mentions.map(
          pr => `https://github.com/${pr.repository}/pull/${pr.number}`,
        ),
      ),
    ];
    return report;
  }

  stop(run: WorkflowRun): void {
    this.ports.stop(run.id);
    if (run.sessionId) this.ports.stopSetup(run.sessionId);
  }

  stopChildren(runId: string): void {
    for (const child of this.ports.workflows.childRuns(runId))
      if (hasActiveWorkflow(child.status) || child.status === 'needs-attention')
        this.stop(child);
  }

  recoverStopped(): void {
    for (const id of this.ports.workflows.unfinishedRunIds()) {
      const child = this.ports.workflows.getRun(id);
      if (!child?.parent) continue;
      let parent: WorkflowRun['parent'] = child.parent;
      for (let depth = child.parent.depth; depth > 0 && parent; depth--) {
        const run = this.ports.workflows.getRun(parent.runId);
        if (run?.status === 'stopped') {
          this.stop(child);
          break;
        }
        parent = run?.parent;
      }
    }
  }
}
