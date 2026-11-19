import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { WorkflowRun } from '@nesvo/contracts';
import type { z } from 'zod';
import type { RunFinished, SessionService } from '../sessions/service';

type AdviceSessions = Pick<
  SessionService,
  | 'create'
  | 'onRunFinished'
  | 'whenFolderFree'
  | 'sendWorkflowTurn'
  | 'stopActive'
  | 'finished'
>;

export async function workflowAdvice<T>(
  sessions: AdviceSessions,
  run: WorkflowRun,
  title: string,
  text: string,
  outputSchema: Record<string, unknown>,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T | null> {
  signal.throwIfAborted();
  const session = sessions.create(
    {
      title: `${run.workflow.name} / ${title}`.slice(0, 100),
      provider: run.gateProvider,
      model: run.gateModel,
      mode: 'read-only',
      directory: run.directory,
    },
    { origin: { kind: 'workflow', runId: run.id } },
  );
  const stop = () =>
    sessions.stopActive(
      session.id,
      signal.reason === 'shutdown' ? 'host-shutdown' : undefined,
    );
  let resolve!: (event: RunFinished) => void;
  const finished = new Promise<RunFinished>(complete => {
    resolve = complete;
  });
  const release = sessions.onRunFinished(event => {
    if (event.sessionId === session.id) resolve(event);
  });
  signal.addEventListener('abort', stop, { once: true });
  try {
    const messageId = randomUUID();
    for (;;) {
      await sessions.whenFolderFree(run.directory, 'read', signal);
      signal.throwIfAborted();
      if (
        sessions.sendWorkflowTurn({
          sessionId: session.id,
          messageId,
          text,
          outputSchema,
          readOnly: true,
          ephemeral: true,
          instructionsOnly: true,
        }) === 'sent'
      )
        break;
      await delay(50, undefined, { signal });
    }
    const event = await finished;
    const outcome = await sessions.finished(session.id, event.runId);
    signal.throwIfAborted();
    if (outcome.state !== 'completed') return null;
    const parsed = schema.safeParse(outcome.structured);
    return parsed.success ? parsed.data : null;
  } finally {
    signal.removeEventListener('abort', stop);
    release();
  }
}
