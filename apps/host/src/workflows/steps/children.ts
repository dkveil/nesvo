import {
  parseDurationMs,
  type ProviderUsage,
  type WorkflowChildItem,
  type WorkflowChildSession,
  type WorkflowItem,
} from '@nesvo/contracts';
import { setTimeout as delay } from 'node:timers/promises';
import { loadChildItems, renderChildTemplate } from '../child-items';
import { childStartWait } from '../child-resources';
import { childReport, type ChildRuns } from '../child-runs';
import { filterResultText } from '../evidence';
import type { StepExecution, StepExecutor } from '../runner';
import { hostResult } from './host-result';

type Work = {
  item: WorkflowChildItem;
  source: WorkflowItem;
  prompt: string;
};

const finished = (
  work: Work,
  report: NonNullable<WorkflowChildItem['report']>,
) => {
  work.item = { ...work.item, state: 'finished', reason: null, report };
};

function prepare(
  execution: StepExecution,
  session: WorkflowChildSession,
  source: WorkflowItem,
  index: number,
): Work {
  const work: Work = {
    source,
    prompt: '',
    item: {
      index,
      title: `Item ${index + 1}`,
      sessionId: null,
      state: 'waiting',
      reason: null,
      report: null,
    },
  };
  try {
    const title = renderChildTemplate(
      session.title,
      execution,
      source,
      index,
      100,
    );
    work.item.title = filterResultText(title).slice(0, 100) || work.item.title;
    work.prompt = renderChildTemplate(
      execution.definition.body,
      execution,
      source,
      index,
      32_768,
    );
  } catch (error) {
    finished(
      work,
      childReport(
        'failed',
        error instanceof Error
          ? error.message
          : 'Could not render the child session.',
      ),
    );
  }
  return work;
}

const failurePolicy = (work: Work, fallback: string) =>
  typeof work.source === 'object' && Object.hasOwn(work.source, 'on_fail')
    ? work.source.on_fail
    : fallback;

function childResult(
  execution: StepExecution,
  work: Work[],
  forceFailure: boolean,
) {
  const items = work.map(entry => entry.item);
  const count = items.filter(item => item.report?.status === 'passed').length;
  if (execution.definition.type === 'session') {
    const item = items[0]!;
    const report = item.report!;
    const result = hostResult(
      execution,
      report.status === 'passed' ? 'pass' : 'fail',
      report.summary,
      {
        ...report.outputs,
        status: report.status,
        summary: report.summary,
        ...(report.links[0] ? { pr: report.links[0] } : {}),
        ...(item.sessionId ? { sessionId: item.sessionId } : {}),
      },
    );
    return { ...result, result: { ...result.result, items } };
  }
  const outputs: Record<string, string> = {
    total: String(items.length),
    passed: String(count),
  };
  const json = JSON.stringify(items);
  if (json.length <= 4000) outputs.items = json;
  const result = hostResult(
    execution,
    forceFailure ? 'fail' : 'pass',
    `${count} of ${items.length} child workflows passed.`,
    outputs,
  );
  return { ...result, result: { ...result.result, items } };
}

export function createChildExecutor(
  children: ChildRuns,
  readUsage: (
    provider: WorkflowChildSession['provider'],
  ) => Promise<ProviderUsage>,
): StepExecutor {
  return async input => {
    const { definition, step } = input;
    const session = definition.session!;
    const policy = definition.policy;
    const duration = parseDurationMs(definition.timeout)!;
    const elapsed = input.now().getTime() - Date.parse(step.startedAt!);
    const timer = new AbortController();
    const timeout = setTimeout(
      () => timer.abort('timeout'),
      Math.max(0, duration - elapsed),
    );
    const execution = {
      ...input,
      signal: AbortSignal.any([input.signal, timer.signal]),
    };
    const work: Work[] = [];
    let saved = JSON.stringify(step.children);
    const save = () => {
      const items = work.map(entry => entry.item);
      const next = JSON.stringify(items);
      if (next !== saved && execution.saveChildren?.(items)) saved = next;
    };
    const attach = (entry: Work) => {
      const run = children.run(execution, entry.item.index);
      if (!run) return;
      entry.item = {
        ...entry.item,
        sessionId: run.sessionId,
        state: 'running',
        reason: null,
      };
      const report = children.report(run);
      if (report) finished(entry, report);
    };
    const cancel = (status: 'stopped' | 'failed', summary: string) => {
      for (const entry of work) {
        if (entry.item.state === 'finished') continue;
        const run = children.run(execution, entry.item.index);
        if (run) children.stop(run);
        finished(entry, childReport(status, summary));
      }
      save();
    };
    try {
      if (execution.recovering) {
        for (const item of step.children ?? []) {
          const entry = { item, source: '', prompt: '' };
          work.push(entry);
          if (item.state === 'finished') continue;
          attach(entry);
          if (
            entry.item.state !== 'waiting' &&
            children.run(execution, item.index)
          )
            continue;
          entry.item = {
            ...item,
            sessionId: children.createdSessionId(execution, item.index),
          };
          finished(
            entry,
            childReport(
              'interrupted',
              'The host restarted before this child workflow started.',
            ),
          );
        }
        save();
        if (!work.length) return { kind: 'interrupted' };
      } else {
        const items = definition.items
          ? await loadChildItems(execution, definition.items)
          : [''];
        work.push(
          ...items.map((item, index) =>
            prepare(execution, session, item, index),
          ),
        );
        save();
      }

      let stopRemaining = false;
      for (;;) {
        execution.signal.throwIfAborted();
        for (const entry of work)
          if (entry.item.state === 'running') attach(entry);
        save();
        const failed = work.filter(
          ({ item }) =>
            item.report &&
            item.report.status !== 'passed' &&
            item.report.status !== 'skipped',
        );
        const fallback = policy?.on_fail ?? 'fail-run';
        if (
          !execution.recovering &&
          failed.some(entry => failurePolicy(entry, fallback) === 'fail-run')
        ) {
          cancel('stopped', 'Stopped after a child workflow failed.');
          return childResult(execution, work, true);
        }
        stopRemaining ||=
          !execution.recovering &&
          failed.some(
            entry => failurePolicy(entry, fallback) === 'stop-remaining',
          );
        const waiting = work.filter(({ item }) => item.state === 'waiting');
        if (stopRemaining)
          for (const entry of waiting)
            finished(
              entry,
              childReport('skipped', 'Skipped after a child workflow failed.'),
            );
        save();
        const next = stopRemaining ? undefined : waiting[0];
        if (!next) {
          if (work.every(({ item }) => item.state === 'finished'))
            return childResult(
              execution,
              work,
              stopRemaining ||
                (execution.recovering === true && failed.length > 0),
            );
        } else {
          const active = work.filter(
            ({ item }) => item.state === 'running',
          ).length;
          const wait =
            (policy
              ? await childStartWait(
                  execution,
                  session.provider,
                  policy,
                  active,
                  () => readUsage(session.provider),
                )
              : null) ?? children.folderWait(execution, session);
          if (wait) {
            for (const entry of waiting)
              entry.item = { ...entry.item, reason: wait };
            save();
          } else {
            next.item = { ...next.item, state: 'starting', reason: null };
            save();
            try {
              const child = await children.start(execution, session, {
                ...next.item,
                prompt: next.prompt,
              });
              if (child.sessionId && definition.type === 'session')
                execution.link(child.sessionId);
              attach(next);
              save();
            } catch (error) {
              if (execution.signal.aborted) throw error;
              finished(
                next,
                childReport(
                  'failed',
                  error instanceof Error
                    ? error.message
                    : 'Could not start the child workflow.',
                ),
              );
              save();
            }
            continue;
          }
        }
        await delay(1000, undefined, { signal: execution.signal });
      }
    } catch (error) {
      if (input.signal.reason === 'shutdown') return { kind: 'interrupted' };
      if (input.signal.aborted) {
        cancel('stopped', 'The parent workflow was stopped.');
        return { kind: 'interrupted' };
      }
      if (timer.signal.aborted) {
        cancel('failed', 'The child workflow wait timed out.');
        return work.length
          ? childResult(execution, work, true)
          : hostResult(execution, 'fail', 'The child workflow wait timed out.');
      }
      cancel('failed', 'The child workflow could not continue.');
      return hostResult(
        execution,
        'fail',
        error instanceof Error
          ? error.message
          : 'The child workflow step failed.',
      );
    } finally {
      clearTimeout(timeout);
    }
  };
}
