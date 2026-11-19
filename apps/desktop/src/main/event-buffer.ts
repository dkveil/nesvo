import {
  applySessionChange,
  type DesktopEvent,
  type SessionChange,
} from '@nesvo/contracts';

const MAX_BUFFERED_ENTITIES = 4096;

type SessionEvent = Extract<
  DesktopEvent,
  { type: 'session-changed' | 'session-message-upserted' }
>;

const isSessionEvent = (event: DesktopEvent): event is SessionEvent =>
  event.type === 'session-changed' || event.type === 'session-message-upserted';

const entityKey = (event: DesktopEvent, sequence: number) => {
  switch (event.type) {
    case 'session-changed':
    case 'session-message-upserted':
      return `session:${event.session.id}`;
    case 'review-changed':
      return `review:${event.review.id}`;
    case 'scheduled-job-changed':
      return `scheduled-job:${event.scheduledJob.id}`;
    case 'scheduled-job-removed':
      return `scheduled-job:${event.scheduledJobId}`;
    case 'scheduled-job-run-changed':
      return `scheduled-job-run:${event.run.id}`;
    case 'workflow-run-changed':
      return `workflow-run:${event.run.id}`;
    case 'workflow-step-changed':
      return `workflow-step:${event.step.id}`;
    case 'session-groups-changed':
      return 'session-groups';
    case 'coordinator-wake-changed':
      return 'coordinator-wake';
    case 'pull-request-review-changed':
      return `pull-request-review:${event.draft.id}`;
    default:
      return `event:${sequence}`;
  }
};

const revisionOf = (event: DesktopEvent) => {
  switch (event.type) {
    case 'session-changed':
    case 'session-message-upserted':
      return event.session.revision;
    case 'review-changed':
      return event.review.revision;
    case 'workflow-run-changed':
      return event.run.revision;
    case 'workflow-step-changed':
      return event.step.revision;
    case 'pull-request-review-changed':
      return event.draft.revision;
    default:
      return null;
  }
};

const toChange = (event: SessionEvent): SessionChange =>
  event.type === 'session-changed'
    ? { type: 'snapshot', session: event.session }
    : { ...event, type: 'upsert' };

const combine = (previous: DesktopEvent, next: DesktopEvent): DesktopEvent => {
  if (!isSessionEvent(previous) || !isSessionEvent(next)) return next;
  if (previous.type === 'session-changed') {
    const applied = applySessionChange(previous.session, toChange(next));
    return applied && !applied.gap
      ? { type: 'session-changed', session: applied.session }
      : next;
  }
  return next.type === 'session-message-upserted' &&
    next.baseRevision === previous.session.revision &&
    next.index === previous.index
    ? { ...next, baseRevision: previous.baseRevision }
    : next;
};

export class EventBuffer {
  private readonly events = new Map<string, DesktopEvent>();
  private sequence = 0;

  add(event: DesktopEvent) {
    const key = entityKey(event, this.sequence++);
    const previous = this.events.get(key);
    if (previous) {
      const before = revisionOf(previous);
      const after = revisionOf(event);
      if (before !== null && after !== null && after < before) return true;
      this.events.delete(key);
      this.events.set(key, combine(previous, event));
      return true;
    }
    if (this.events.size >= MAX_BUFFERED_ENTITIES) return false;
    this.events.set(key, event);
    return true;
  }

  drain() {
    const events = [...this.events.values()];
    this.events.clear();
    return events;
  }
}
