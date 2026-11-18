import { createHash } from 'node:crypto';
import { scheduledJobLimits, type ScheduledJob } from '@nesvo/contracts';
import { runOwnedProcess } from '../process/owned-process';
import { resolveFolder } from '../workspace/folder';
import { SECRET_VARIABLE } from '../workflows/steps/command';

type Result = { hash: string } | { failure: string };

export async function checkForChange(
  job: ScheduledJob,
  signal: AbortSignal,
): Promise<Result> {
  const directory = await resolveFolder(job.directory, signal).catch(
    () => null,
  );
  if (!directory) return { failure: 'The automation folder is unavailable.' };
  const [command, ...args] = job.changeTrigger!.argv;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !SECRET_VARIABLE.test(name) && !/^NESVO_/i.test(name),
    ),
  );
  try {
    const result = await runOwnedProcess({
      command,
      args,
      cwd: directory,
      env: { ...env, CI: '1', GIT_TERMINAL_PROMPT: '0' },
      timeoutMs: scheduledJobLimits.checkTimeoutMs,
      maxOutputBytes: scheduledJobLimits.checkOutputBytes,
      signal,
    });
    if (result.timedOut) return { failure: 'The check timed out.' };
    if (result.outputTruncated)
      return { failure: 'The check exceeded the output limit.' };
    if (result.code !== 0)
      return {
        failure:
          result.code === null
            ? 'The check process was stopped.'
            : `The check exited with code ${result.code}.`,
      };
    const normalized = result.stdout.replace(/\r\n?/g, '\n').trimEnd();
    return { hash: createHash('sha256').update(normalized).digest('hex') };
  } catch {
    return { failure: 'The check command could not complete.' };
  }
}
