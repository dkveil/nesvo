import {
  parseDurationMs,
  type AssistantChange,
  type CheckCandidate,
  type CheckEvidence,
  type Evidence,
  type SessionMode,
  type StepResult,
  type TurnUsage,
} from '@nesvo/contracts';
import { join } from 'node:path';
import { runGit } from '../../workspace/isolation';
import type { ChangeContext } from '../assistant-changes';
import type { InboxRules } from '../../inbox-rules/service';
import type { SessionService } from '../../sessions/service';
import { filterResultText } from '../evidence';
import {
  candidate,
  hashText,
  parseCheckCommand,
  readCheckInput,
  sourceAt,
  windows,
} from '../check-inventory';
import {
  invocationText,
  projectChecks,
  projectCommand,
  projectProfilePath,
  projectProfileWithMapping,
  rankedCandidates,
  type ProjectScan,
} from '../project-checks';
import type { StepExecutor, StepOutcome } from '../runner';
import { sumUsage, type AgentStepPorts } from './agent';
import { checkProof, checkReports } from './check-proof';
import { createCheckResolver } from './check-resolution';
import { outcomeSummary, runShellStep, succeeded } from './command';
import { hostResult } from './host-result';

type Ports = AgentStepPorts & {
  guard: Pick<InboxRules, 'beforeWorkflowStep' | 'beforeCheckCommand'>;
  folder: SessionService['claimWorkflowCheck'];
  mode: (id: string) => SessionMode | undefined;
  mappingApproved: (root: string, hash: string) => boolean;
  save: (
    context: ChangeContext & { mappingRoot: string },
    document: string,
    expected: string | null,
    signal: AbortSignal,
  ) => Promise<AssistantChange | null>;
};

type Observation = CheckEvidence['invocations'][number];

export const createCheckExecutor = (ports: Ports): StepExecutor => {
  const resolve = createCheckResolver(ports);
  return async original => {
    const { run, step, definition } = original;
    const pinned = run.projectProfile;
    if (!pinned || run.semanticsVersion !== 1)
      return hostResult(
        original,
        'blocked',
        'The run has no verified Project profile.',
      );
    const timeout = AbortSignal.timeout(
      parseDurationMs(definition.timeout) ?? 900000,
    );
    const signal = AbortSignal.any([original.signal, timeout]);
    const execution = { ...original, signal };
    const deadline =
      Date.now() + (parseDurationMs(definition.timeout) ?? 900000);
    const review = run.sessionId
      ? ports.sessions.latestReview(run.sessionId)
      : undefined;
    const proof: CheckEvidence = {
      profileHash: pinned.hash,
      proposed: null,
      rationale: null,
      invocations: [],
      ...(review
        ? { resultVersion: { id: review.id, version: review.version } }
        : {}),
    };
    const logs: Evidence[] = [];
    let usage: TurnUsage | null = null;
    const finish = (
      status: StepResult['status'],
      summary: string,
    ): StepOutcome => {
      const outcome = hostResult(execution, status, summary, {}, logs);
      return {
        kind: 'result',
        result: {
          ...outcome.result,
          check: proof,
          ...(usage
            ? { cost: { ...sumUsage([usage]), provider: run.gateProvider } }
            : {}),
        },
      };
    };
    const mode = () =>
      run.sessionId ? ports.mode(run.sessionId) : 'read-only';
    const scan = () =>
      projectChecks.read(
        run.directory,
        run.workflow.steps,
        execution.environment,
        signal,
        hash => ports.mappingApproved(run.projectRoot, hash),
      );
    if (!run.sessionId)
      return finish('blocked', 'The check needs a verified workflow session.');
    let latest: ProjectScan;
    try {
      if (
        pinned.issue &&
        pinned.candidates.length === 0 &&
        pinned.stack !== 'ambiguous'
      )
        return finish('blocked', pinned.issue);
      latest = await scan();
      if (
        latest.profile.directory !== pinned.directory ||
        latest.profile.overrideHash !== pinned.overrideHash
      )
        return finish(
          'blocked',
          'The pinned Project module or mapping changed. Start a new run to use it.',
        );
      const candidates = rankedCandidates(
        { ...latest, profile: pinned },
        definition,
      );
      const mayPropose = !candidates.some(
        entry => entry.availability === 'available',
      );
      const resolved = await resolve(
        execution,
        pinned,
        candidates,
        mayPropose,
        deadline,
      );
      if (typeof resolved === 'string') return finish('blocked', resolved);
      const { selection } = resolved;
      usage = resolved.usage;
      proof.rationale = filterResultText(selection.rationale).slice(0, 600);
      let selected = candidates.find(item => item.id === selection.candidateId);
      let proposal: string | undefined;
      if (selection.candidateId && !selected)
        return finish(
          'blocked',
          'The selected candidate ID is outside the pinned inventory.',
        );
      if (selection.proposal && mayPropose) {
        const { command, sourceFile, location } = selection.proposal;
        const invocation = parseCheckCommand(command);
        if (
          !invocation ||
          !/^[\w.-]+(?:\/[\w.-]+)*$/.test(sourceFile) ||
          sourceFile
            .split('/')
            .some(part => part === '..' || part === '.' || part === '.git')
        )
          return finish(
            'blocked',
            'The proposed check must be one local test invocation with a repository-relative source file.',
          );
        const source = await readCheckInput(
          run.directory,
          sourceFile,
          signal,
        ).catch(() => null);
        if (!source)
          return finish(
            'blocked',
            'The proposed command source could not be verified in this checkout.',
          );
        selected =
          candidate({
            target: invocation,
            source: sourceAt(run.directory, source, location),
            directory: pinned.directory,
            coverage: 'tests',
            availability: 'unverified',
            reason: 'First use requires operator approval.',
          }) ?? undefined;
        proposal = selected
          ? 'Source: ' +
            selected.source.file +
            ' / ' +
            selected.source.location +
            '\nReason: ' +
            proof.rationale
          : undefined;
      }
      if (!selected)
        return finish(
          'blocked',
          selection.proposal && !mayPropose
            ? 'Choose a candidate from the pinned inventory.'
            : (pinned.issue ??
                'No suitable test check could be established. Add a Project mapping or a documented test command.'),
        );
      proof.proposed = selected;
      const invoke = async (
        entry: CheckCandidate,
        substitution: string | null,
        approval?: string,
      ): Promise<Observation> => {
        const startedAt = execution.now().toISOString();
        const initialMode = mode();
        let command: string | null = null;
        let head: string | null = null;
        const observation = (
          outcome: Observation['outcome'],
          reason: string,
          exitCode: number | null = null,
          proof: string | null = null,
        ): Observation => ({
          candidate: entry,
          command,
          head,
          mode: initialMode ?? 'unavailable',
          substitution,
          outcome,
          exitCode,
          reason: filterResultText(reason).slice(0, 600),
          proof,
          startedAt,
          finishedAt: execution.now().toISOString(),
        });
        const validate = async () => {
          latest = await scan();
          if (
            latest.profile.directory !== pinned.directory ||
            latest.profile.overrideHash !== pinned.overrideHash
          )
            return 'The pinned Project module or mapping changed.';
          if (approval) {
            const source = await readCheckInput(
              run.directory,
              entry.source.file,
              signal,
            ).catch(() => null);
            if (source?.contentHash !== entry.source.hash)
              return 'The proposed command source changed.';
          } else {
            const current = latest.profile.candidates.find(
              item => item.id === entry.id,
            );
            if (!current)
              return 'The candidate source changed after this run was pinned.';
            if (current.availability === 'missing')
              return {
                mismatch: current.reason ?? 'The launcher is unavailable.',
              };
            if (current.availability !== 'available')
              return current.reason ?? 'The candidate could not be verified.';
          }
          const local = await projectCommand(
            latest,
            entry,
            execution.environment,
          );
          return (
            local ?? {
              mismatch:
                'The check launcher or required toolchain is unavailable.',
            }
          );
        };
        const refusal = (validated: string | { mismatch: string }) =>
          typeof validated === 'string'
            ? observation('blocked', validated)
            : observation('setup-mismatch', validated.mismatch);
        if (!initialMode)
          return observation('blocked', 'The workflow session is unavailable.');
        const planned = await validate();
        if (typeof planned === 'string' || 'mismatch' in planned)
          return refusal(planned);
        const invocation = planned.invocation;
        command = invocationText(invocation);
        const stepGate = await ports.guard.beforeWorkflowStep(execution);
        if (stepGate)
          return observation(
            'blocked',
            stepGate.kind === 'result'
              ? stepGate.result.summary
              : 'The workflow step was held.',
          );
        const hold = await ports.guard.beforeCheckCommand(execution, {
          command,
          id: hashText(
            JSON.stringify([entry.id, command, planned.stamp, initialMode]),
          ),
          folder: planned.cwd,
          proposal: approval,
        });
        if (hold) return observation('blocked', hold);
        const release = await ports.folder(
          run.directory,
          initialMode === 'read-only' && !approval ? 'read' : 'write',
          run.sessionId,
          signal,
        );
        try {
          const ready = await validate();
          if (typeof ready === 'string' || 'mismatch' in ready)
            return refusal(ready);
          if (
            ready.stamp !== planned.stamp ||
            invocationText(ready.invocation) !== command ||
            initialMode !== mode()
          )
            return observation(
              'blocked',
              'The launcher or session permission mode changed while the check was waiting.',
            );
          if (approval) {
            const current =
              latest.context.files.get(projectProfilePath) ?? null;
            const mapped = projectProfileWithMapping(
              current,
              command,
              entry.source,
            );
            const saved = await ports.save(
              {
                conversationId: run.id,
                messageId: step.id,
                directory: run.directory,
                mappingRoot: run.projectRoot,
              },
              mapped,
              pinned.overrideHash,
              signal,
            );
            if (!saved)
              return observation(
                'blocked',
                'The Project mapping could not be saved with Undo. No command started.',
              );
            proof.mapping = {
              conversationId: saved.conversationId,
              changeId: saved.changeId,
            };
          }
          signal.throwIfAborted();
          const git = await runGit({
            args: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
            cwd: run.directory,
            timeoutMs: 2000,
            signal,
            maxOutputBytes: 256,
          }).catch(() => null);
          const revision = git?.stdout.trim() ?? '';
          if (git?.code === 0 && /^[0-9a-f]{40,64}$/.test(revision))
            head = revision;
          const reportFolder = join(run.directory, entry.directory);
          const reports = await checkReports(reportFolder, entry, signal);
          signal.throwIfAborted();
          const process = await runShellStep(execution, {
            executable: ready.found.path,
            args: invocation.args,
            cwd: ready.cwd,
            batch: windows && /\.(?:cmd|bat)$/i.test(ready.found.path),
            logFile:
              'attempt-' +
              step.attempt +
              '-check-' +
              (proof.invocations.length + 1) +
              '.log',
            mode: initialMode,
          });
          if (!process) {
            if (timeout.aborted && !original.signal.aborted)
              return observation('timeout', 'The check timed out.');
            signal.throwIfAborted();
            return observation('blocked', 'The check could not start.');
          }
          logs.push(...process.evidence);
          const observed = await checkProof(
            reportFolder,
            entry,
            reports,
            process.log,
            signal,
          );
          const exit = process.process?.code ?? null;
          if (process.process?.timedOut)
            return observation(
              'timeout',
              'The check timed out.',
              exit,
              observed?.text,
            );
          if (!succeeded(process) || observed?.failed)
            return observation(
              'failed',
              observed?.failed && succeeded(process)
                ? 'The suite reported failures.'
                : outcomeSummary(process, definition.timeout),
              exit,
              observed?.text,
            );
          return observed
            ? observation(
                'passed',
                'The test suite passed.',
                exit,
                observed.text,
              )
            : observation(
                'blocked',
                'The command exited successfully without evidence that a suite ran.',
                exit,
              );
        } finally {
          release();
        }
      };
      let observed = await invoke(selected, null, proposal);
      proof.invocations.push(observed);
      if (observed.outcome === 'setup-mismatch' && !proposal) {
        const alternate = candidates.find(
          other =>
            other.id !== selected.id &&
            other.availability === 'available' &&
            other.coverage === selected.coverage &&
            JSON.stringify(other.target) !== JSON.stringify(selected.target),
        );
        if (alternate) {
          observed = await invoke(alternate, observed.reason);
          proof.invocations.push(observed);
        }
      }
      const status =
        observed.outcome === 'passed'
          ? 'pass'
          : observed.outcome === 'failed' || observed.outcome === 'timeout'
            ? 'fail'
            : 'blocked';
      return finish(
        status,
        [observed.command, observed.reason, observed.proof]
          .filter(Boolean)
          .join('\n'),
      );
    } catch {
      if (original.signal.aborted) return { kind: 'interrupted' };
      if (timeout.aborted)
        return finish(
          'fail',
          'Timed out after ' +
            definition.timeout +
            ' while resolving or running the check.',
        );
      return finish(
        'blocked',
        'The Project inventory, gate provider or check process could not be verified on this host.',
      );
    }
  };
};
