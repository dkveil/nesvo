import {
  parseDurationMs,
  parsePullRequestUrl,
  PULL_REQUEST_NUMBER,
  STEP_OUTPUT_REFERENCE,
  stepResultLimits,
  type PullRequestReference,
} from '@nesvo/contracts';
import { setTimeout as delay } from 'node:timers/promises';
import type { PullRequests } from '../../pull-requests';
import type { StepExecution, StepExecutor, StepOutcome } from '../runner';
import { hostResult } from './host-result';

type Ports = {
  read: PullRequests['workflowChecks'];
  linked: (sessionId: string) => PullRequestReference | null;
};

const urlFor = ({ repository, number }: PullRequestReference) =>
  'https://github.com/' + repository + '/pull/' + number;

const sameReference = (
  left: PullRequestReference,
  right: PullRequestReference,
) =>
  left.number === right.number &&
  left.repository.toLowerCase() === right.repository.toLowerCase();

function targetFor(execution: StepExecution, ports: Ports): string | null {
  const expression = execution.definition.pr;
  if (!expression) {
    const id = execution.run.sessionId;
    const reference = id ? ports.linked(id) : null;
    return reference ? urlFor(reference) : null;
  }
  const match = STEP_OUTPUT_REFERENCE.exec(expression);
  const value = match
    ? execution.outputs.get(match[1]!)?.[match[2]!]
    : expression;
  if (!value) return null;
  const reference = parsePullRequestUrl(value);
  return reference
    ? urlFor(reference)
    : PULL_REQUEST_NUMBER.test(value)
      ? value
      : null;
}

const good = new Set(['success', 'neutral', 'skipped']);
const interrupted: StepOutcome = { kind: 'interrupted' };

export const createWaitCiExecutor =
  (ports: Ports): StepExecutor =>
  async execution => {
    const { run, step, definition, signal, saveCiWait } = execution;
    let reference = step.ciWait?.reference;
    let headSha = step.ciWait?.headSha;
    let target = reference ? urlFor(reference) : targetFor(execution, ports);
    const deadline =
      Date.parse(step.startedAt ?? execution.now().toISOString()) +
      (parseDurationMs(definition.timeout) ?? 900_000);
    const interval =
      parseDurationMs(definition.poll_interval ?? '10s') ?? 10_000;
    let failing: string[] = [];
    const result = (
      status: 'success' | 'failure' | 'timeout',
      summary: string,
    ) =>
      hostResult(execution, status === 'success' ? 'pass' : 'fail', summary, {
        status,
        failing_checks: failing
          .join('\n')
          .slice(0, stepResultLimits.outputValue),
        ...(headSha ? { head_sha: headSha } : {}),
      });
    const timeLeft = () => deadline - execution.now().getTime();
    if (!target)
      return result(
        'failure',
        'A linked pull request or a valid pull request expression is required.',
      );
    if (!reference) {
      reference = parsePullRequestUrl(target) ?? undefined;
      if (reference && !saveCiWait?.({ reference })) return interrupted;
    }
    while (!signal.aborted && timeLeft() > 0) {
      try {
        const pollSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(1, timeLeft())),
        ]);
        const observed = await ports.read(target, run.directory, pollSignal);
        if (signal.aborted) return interrupted;
        if (timeLeft() <= 0) break;
        if (
          (reference && !sameReference(reference, observed.reference)) ||
          (PULL_REQUEST_NUMBER.test(target) &&
            Number(target) !== observed.reference.number)
        )
          return result(
            'failure',
            'The CLI returned a different pull request.',
          );
        if (headSha && headSha !== observed.headSha)
          return result(
            'failure',
            'The pull request head changed while waiting for checks.',
          );
        if (!headSha) {
          reference = observed.reference;
          headSha = observed.headSha;
          target = urlFor(reference);
          if (!saveCiWait?.({ reference, headSha })) return interrupted;
        }
        failing = [
          ...new Set(
            observed.checks.flatMap(check =>
              check.status === 'completed' &&
              check.conclusion &&
              !good.has(check.conclusion)
                ? [check.name.replace(/[\r\n\t]/g, ' ')]
                : [],
            ),
          ),
        ];
        if (failing.length > 0)
          return result('failure', 'One or more pull request checks failed.');
        if (
          observed.checks.length > 0 &&
          observed.checks.every(
            check =>
              check.status === 'completed' &&
              check.conclusion &&
              good.has(check.conclusion),
          )
        )
          return result('success', 'Pull request checks passed.');
      } catch {
        if (signal.aborted) return interrupted;
        if (timeLeft() > 0)
          return result(
            'failure',
            'Pull request checks could not be read on this computer.',
          );
        break;
      }
      await delay(Math.max(0, Math.min(interval, timeLeft())), undefined, {
        signal,
      }).catch(() => undefined);
    }
    return signal.aborted
      ? interrupted
      : result('timeout', 'Timed out waiting for pull request checks.');
  };
