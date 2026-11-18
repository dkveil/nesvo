import { type DesktopEvent } from '@nesvo/contracts';

const MAX_BUFFERED_ENTITIES = 4096;

const entityKey = (event: DesktopEvent, sequence: number) => {
  switch (event.type) {
    case 'session-changed':
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
    default:
      return `event:${sequence}`;
  }
};

const revisionOf = (event: DesktopEvent) => {
  switch (event.type) {
    case 'session-changed':
      return event.session.revision;
    case 'review-changed':
      return event.review.revision;
    case 'workflow-run-changed':
      return event.run.revision;
    case 'workflow-step-changed':
      return event.step.revision;
    default:
      return null;
  }
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
    } else if (this.events.size >= MAX_BUFFERED_ENTITIES) return false;
    this.events.set(key, event);
    return true;
  }

  drain() {
    const events = [...this.events.values()];
    this.events.clear();
    return events;
  }
}
