import type { Session } from './sessions';

type SubsessionSource = Pick<
  Session,
  | 'id'
  | 'parentId'
  | 'parentRunId'
  | 'workflowRunId'
  | 'workflowStepId'
  | 'status'
  | 'runId'
  | 'createdAt'
  | 'updatedAt'
  | 'messages'
  | 'activities'
>;

export type SubsessionEntry<T extends SubsessionSource> = {
  session: T;
  active: boolean;
  startedAt: string;
  finishedAt: string | null;
};

export type SubsessionOverview<T extends SubsessionSource> = {
  entries: SubsessionEntry<T>[];
  running: number;
  commands: number;
  visible: boolean;
};

export const delegationActivityTitle = 'Delegate workers';

const commandKinds = new Set(['command', 'tool']);

export const isSessionActive = (session: Pick<Session, 'status'>): boolean =>
  session.status === 'running' || session.status === 'stopping';

export const isSubsessionOf = (
  root: SubsessionSource,
  candidate: SubsessionSource,
): boolean =>
  candidate.id !== root.id &&
  (candidate.parentId === root.id ||
    (!!root.workflowRunId &&
      !!candidate.workflowStepId &&
      candidate.workflowRunId === root.workflowRunId));

const currentRunStart = (session: SubsessionSource): string =>
  (session.runId &&
    session.messages.find(message => message.runId === session.runId)
      ?.createdAt) ||
  session.createdAt;

const currentRunEnd = (session: SubsessionSource): string | null => {
  if (isSessionActive(session)) return null;
  const finished = session.messages.findLast(
    message =>
      message.runId === session.runId &&
      message.author === 'agent' &&
      !!message.completedAt,
  );
  return finished?.completedAt ?? session.updatedAt;
};

const toEntry = <T extends SubsessionSource>(
  session: T,
): SubsessionEntry<T> => ({
  session,
  active: isSessionActive(session),
  startedAt: currentRunStart(session),
  finishedAt: currentRunEnd(session),
});

const compareEntries = <T extends SubsessionSource>(
  left: SubsessionEntry<T>,
  right: SubsessionEntry<T>,
): number =>
  Number(right.active) - Number(left.active) ||
  left.startedAt.localeCompare(right.startedAt) ||
  left.session.id.localeCompare(right.session.id);

export const listSubsessions = <T extends SubsessionSource>(
  root: SubsessionSource,
  sessions: readonly T[],
): SubsessionEntry<T>[] =>
  sessions
    .filter(candidate => isSubsessionOf(root, candidate))
    .map(toEntry)
    .sort(compareEntries);

export const runningCommandCount = (session: SubsessionSource): number =>
  isSessionActive(session)
    ? session.activities.filter(
        activity =>
          activity.runId === session.runId &&
          activity.status === 'running' &&
          commandKinds.has(activity.kind) &&
          activity.title !== delegationActivityTitle,
      ).length
    : 0;

export const subsessionOverview = <T extends SubsessionSource>(
  root: SubsessionSource,
  sessions: readonly T[],
): SubsessionOverview<T> => {
  const all = listSubsessions(root, sessions);
  const activeStarts = [
    ...(isSessionActive(root) ? [currentRunStart(root)] : []),
    ...all.filter(entry => entry.active).map(entry => entry.startedAt),
  ].sort();
  const groupStart = activeStarts[0];
  const entries = groupStart
    ? all.filter(
        entry =>
          entry.active ||
          (isSessionActive(root) &&
            !!root.runId &&
            entry.session.parentRunId === root.runId) ||
          (!!entry.finishedAt && entry.finishedAt >= groupStart),
      )
    : [];
  const running = entries.filter(entry => entry.active).length;
  const commands = runningCommandCount(root);
  return {
    entries,
    running,
    commands,
    visible: running > 0 || commands > 0,
  };
};

const countLabel = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

export const activityLabel = (workers: number, commands: number): string => {
  if (workers > 0)
    return commands > 0
      ? `${countLabel(workers, 'worker')} running · ${countLabel(commands, 'command')}`
      : `${countLabel(workers, 'worker')} running`;
  return commands > 0 ? `${countLabel(commands, 'command')} running` : '';
};
