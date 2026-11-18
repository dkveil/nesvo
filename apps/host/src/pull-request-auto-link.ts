import {
  findPullRequestUrls,
  type PullRequestReference,
  type Session,
} from '@nesvo/contracts';
import type { RunFinished } from './sessions/service';

const HANDLED_RUN_LIMIT = 1024;
const REPOSITORY_CACHE_LIMIT = 256;
const BRANCH_CHECK_INTERVAL_MS = 5 * 60_000;

type PullRequestAutoLinkOptions = {
  session: (sessionId: string) => Session | undefined;
  repository: (sessionId: string) => Promise<string>;
  branchPullRequest: (
    sessionId: string,
  ) => Promise<PullRequestReference | null>;
  link: (sessionId: string, reference: PullRequestReference) => unknown;
  now?: () => number;
};

const isDismissed = (session: Session, reference: PullRequestReference) =>
  session.pullRequestDismissed.some(
    item =>
      item.number === reference.number &&
      item.repository.toLowerCase() === reference.repository.toLowerCase(),
  );

const remember = <K, V>(map: Map<K, V>, key: K, value: V, limit: number) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value as K);
};

export class PullRequestAutoLink {
  private readonly handledRuns = new Map<string, true>();
  private readonly repositories = new Map<string, Promise<string | null>>();
  private readonly branchChecks = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: PullRequestAutoLinkOptions) {}

  consider(finished: RunFinished): Promise<void> {
    if (finished.status !== 'completed') return this.queue;
    if (this.handledRuns.has(finished.runId)) return this.queue;
    remember(this.handledRuns, finished.runId, true, HANDLED_RUN_LIMIT);
    this.queue = this.queue
      .then(() => this.linkFromRun(finished))
      .catch(() => undefined);
    return this.queue;
  }

  private async linkFromRun({ sessionId, runId }: RunFinished): Promise<void> {
    const session = this.options.session(sessionId);
    if (!session || session.pullRequest) return;
    const mentioned = session.messages
      .filter(message => message.runId === runId && message.author === 'agent')
      .flatMap(message => findPullRequestUrls(message.body))
      .filter(reference => !isDismissed(session, reference));
    if (mentioned.length > 0) {
      const repository = (await this.repositoryOf(session))?.toLowerCase();
      const match = mentioned.findLast(
        reference => reference.repository.toLowerCase() === repository,
      );
      if (match) {
        this.options.link(sessionId, match);
        return;
      }
    }
    if (!session.worktree || !this.branchCheckDue(sessionId)) return;
    const reference = await this.options
      .branchPullRequest(sessionId)
      .catch(() => null);
    const current = this.options.session(sessionId);
    if (reference && current && !isDismissed(current, reference))
      this.options.link(sessionId, reference);
  }

  private branchCheckDue(sessionId: string): boolean {
    const now = (this.options.now ?? Date.now)();
    const last = this.branchChecks.get(sessionId);
    if (last && now - last < BRANCH_CHECK_INTERVAL_MS) return false;
    remember(this.branchChecks, sessionId, now, HANDLED_RUN_LIMIT);
    return true;
  }

  private repositoryOf(session: Session): Promise<string | null> {
    const cached = this.repositories.get(session.directory);
    if (cached) return cached;
    const pending = this.options.repository(session.id).catch(() => {
      this.repositories.delete(session.directory);
      return null;
    });
    remember(
      this.repositories,
      session.directory,
      pending,
      REPOSITORY_CACHE_LIMIT,
    );
    return pending;
  }
}
