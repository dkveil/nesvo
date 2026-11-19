import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import {
  childResultSchema,
  childWorkPageSchema,
  toSessionMessagePage,
  toSessionWindow,
  type ChildResultInput,
  type ChildWorkInput,
  type ChildWorkItem,
  type ChildWorkPage,
  type Session,
  type SessionControlRefusalCode,
} from '@nesvo/contracts';
import { redactLogMessage } from '../log-redaction';
import type { ReviewStore } from '../review/store';

const MAX_CONTENT_CHARS = 12_000;
const MAX_ITEM_CHARS = 2_000;
const READ_WINDOW = 60_000;
const READ_LIMIT = 60;

const cursorSchema = z.strictObject({
  h: z.uuid(),
  p: z.uuid(),
  c: z.uuid(),
  v: z.enum(['transcript', 'activity']),
  r: z.uuid().nullable(),
  latest: z.string().nullable(),
  oldest: z.string().nullable(),
  rev: z.number().int().nonnegative(),
  before: z.string().optional(),
});

type Cursor = z.infer<typeof cursorSchema>;

const activityLabels = {
  command: 'Command',
  'file-change': 'File changes',
  read: 'File read',
  search: 'Search',
  tool: 'Tool call',
  thinking: 'Reasoning',
} as const;

const visibleText = (text: string) =>
  redactLogMessage(
    stripVTControlCharacters(text)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
      .replace(
        /(\b[a-z][a-z\d+.-]*:\/\/)[^/\s@]+:[^/\s@]+@/gi,
        '$1[redacted]@',
      ),
  );

export class ChildReadRefusal extends Error {
  constructor(
    readonly code: SessionControlRefusalCode,
    message: string,
    readonly retryAt?: string,
  ) {
    super(message);
  }
}

export class ChildHistory {
  private readonly reads = new Map<string, number[]>();

  constructor(
    private readonly hostId: string,
    private readonly secret: string,
    private readonly reviews: ReviewStore,
  ) {}

  checkRate(caller: string) {
    const now = Date.now();
    const min = now - READ_WINDOW;
    for (const [id, entries] of this.reads)
      if (entries.at(-1)! <= min) this.reads.delete(id);
    const reads = (this.reads.get(caller) ?? []).filter(at => at > min);
    if (reads.length >= READ_LIMIT)
      throw new ChildReadRefusal(
        'rate-limit',
        'Retry after the current read window resets.',
        new Date(reads[0]! + READ_WINDOW).toISOString(),
      );
    reads.push(now);
    this.reads.set(caller, reads);
  }

  private sign(payload: string) {
    return createHmac('sha256', this.secret).update(payload).digest();
  }

  private encode(cursor: Cursor): string {
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return payload + '.' + this.sign(payload).toString('base64url');
  }

  private decode(token: string): Cursor {
    const invalid = new ChildReadRefusal(
      'invalid',
      'The page cursor is invalid. Start a new read.',
    );
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw invalid;
    const [payload, signature] = token.split('.') as [string, string];
    const bytes = Buffer.from(signature, 'base64url');
    if (
      bytes.length !== 32 ||
      bytes.toString('base64url') !== signature ||
      !timingSafeEqual(bytes, this.sign(payload))
    )
      throw invalid;
    try {
      return cursorSchema.parse(
        JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
      );
    } catch {
      throw invalid;
    }
  }

  read(caller: string, child: Session, input: ChildWorkInput): ChildWorkPage {
    const scope = {
      h: this.hostId,
      p: caller,
      c: child.id,
      v: input.view,
      r: input.runId ?? null,
    };
    const saved = input.cursor ? this.decode(input.cursor) : null;
    if (
      saved &&
      Object.entries(scope).some(
        ([key, value]) => saved[key as keyof Cursor] !== value,
      )
    )
      throw new ChildReadRefusal(
        'invalid',
        'This cursor belongs to a different child, run or view.',
      );
    const expired = () =>
      new ChildReadRefusal(
        'cursor-expired',
        'Some of the history was removed. Start a new read.',
      );
    const revision = saved?.rev ?? child.revision;
    const forRun = (item: { runId: string }) =>
      !input.runId || item.runId === input.runId;
    const transcript = input.view === 'transcript';
    const messages = transcript
      ? child.messages.filter(
          message =>
            forRun(message) &&
            (message.steering?.insertedRevision ?? 0) <= revision,
        )
      : [];
    const activity = transcript ? [] : child.activities.filter(forRun);
    const visible = activity.filter(item => item.kind !== 'thinking');
    const activityKey = (item: Session['activities'][number]) =>
      createHash('sha256')
        .update(item.runId + ':' + item.id)
        .digest('base64url');
    const keys = transcript
      ? messages.map(item => item.id)
      : visible.map(activityKey);
    const latest = saved ? saved.latest : (keys.at(-1) ?? null);
    const oldest = saved ? saved.oldest : (keys[0] ?? null);
    const end = saved?.before
      ? keys.indexOf(saved.before)
      : latest
        ? keys.indexOf(latest) + 1
        : 0;
    if (
      saved &&
      (!saved.before ||
        end < 0 ||
        !latest ||
        !keys.includes(latest) ||
        keys[0] !== oldest)
    )
      throw expired();
    const window = keys.slice(0, end);
    const messageScope = { ...child, messages: messages.slice(0, end) };
    const messagePage = transcript
      ? saved
        ? toSessionMessagePage(
            { ...child, messages },
            saved.before!,
            input.limit,
          )
        : toSessionWindow(messageScope, input.limit)
      : null;
    const items: ChildWorkItem[] = [];
    let remaining = MAX_CONTENT_CHARS;
    let truncated = false;
    const slice = messagePage?.messages ?? [];
    if (transcript) {
      for (const message of slice.toReversed()) {
        const text = visibleText(message.body);
        const body = text.slice(0, Math.min(MAX_ITEM_CHARS, remaining));
        remaining -= body.length;
        truncated ||= body.length < text.length;
        items.unshift({
          view: 'transcript',
          id: message.id,
          runId: message.runId,
          at: message.createdAt,
          author: message.author,
          actor:
            message.origin === 'coordinator-wake'
              ? 'nesvo'
              : message.steering?.senderSessionId
                ? 'coordinator'
                : message.author,
          state: message.state,
          revision: child.revision,
          partial: message.state === 'running' || message.state === 'stopping',
          body,
        });
        if (!remaining) break;
      }
    } else {
      for (const item of visible.slice(Math.max(0, end - input.limit), end))
        items.push({
          view: 'activity',
          id: item.id,
          runId: item.runId,
          at: item.startedAt,
          kind: item.kind,
          status: item.status,
          label: activityLabels[item.kind],
        });
    }
    const marker = { ...scope, latest, oldest, rev: revision };
    const omitted =
      !transcript &&
      (activity.length !== visible.length ||
        (input.runId
          ? child.activityTruncatedRunIds.includes(input.runId)
          : child.activitiesTruncated));
    return childWorkPageSchema.parse({
      sessionId: child.id,
      view: input.view,
      runId: scope.r,
      snapshot: this.encode(marker),
      items,
      nextCursor:
        items.length > 0 && items.length < window.length
          ? this.encode({
              ...marker,
              before: window[window.length - items.length],
            })
          : null,
      omitted,
      truncated,
      untrusted: true,
    });
  }

  result(child: Session, input: ChildResultInput) {
    const { runId } = input;
    const identity = { sessionId: child.id, runId };
    const review = input.resultId
      ? this.reviews.get(input.resultId)
      : this.reviews.forRun(child.id, runId);
    if (review) {
      if (
        review.sessionId !== child.id ||
        review.runId !== runId ||
        (input.version && input.version !== review.version)
      )
        throw new ChildReadRefusal(
          'invalid',
          'That saved result does not belong to the requested run and version.',
        );
      const text = visibleText(review.summary);
      return childResultSchema.parse({
        ...identity,
        status: 'saved',
        resultId: review.id,
        version: review.version,
        revision: review.revision,
        summary: text.slice(0, MAX_ITEM_CHARS),
        truncated: text.length > MAX_ITEM_CHARS,
        untrusted: true,
        diff: review.diff.status,
        destination: {
          ...identity,
          kind: 'saved-result',
          hostId: this.hostId,
          reviewId: review.id,
          version: review.version,
        },
      });
    }
    if (input.resultId)
      throw new ChildReadRefusal(
        'invalid',
        'The requested result and content version are unavailable.',
      );
    const agent = child.messages.findLast(
      message => message.runId === runId && message.author === 'agent',
    );
    if (agent?.state === 'running' || agent?.state === 'stopping')
      return childResultSchema.parse({
        ...identity,
        status: 'pending',
        reason: 'The requested run is still settling.',
      });
    if (!agent)
      return childResultSchema.parse({
        ...identity,
        status: 'unavailable',
        reason: 'The requested run is no longer available.',
      });
    return childResultSchema.parse({
      ...identity,
      status: 'no-result',
      reason:
        agent.state === 'completed'
          ? 'This turn did not save a result.'
          : 'This turn ended before a result was saved.',
    });
  }
}
