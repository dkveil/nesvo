import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  reviewSchema,
  type Review,
  type ReviewDiff,
  type Session,
} from '@nesvo/contracts';

export class ReviewStore {
  constructor(private readonly database: DatabaseSync) {}

  list(): Review[] {
    return this.database
      .prepare('SELECT document FROM reviews ORDER BY updated_at DESC, id')
      .all()
      .map(row => reviewSchema.parse(JSON.parse(String(row.document))));
  }

  get(id: string): Review | undefined {
    const row = this.database
      .prepare('SELECT document FROM reviews WHERE id = ?')
      .get(id);
    return row
      ? reviewSchema.parse(JSON.parse(String(row.document)))
      : undefined;
  }

  latest(sessionId: string): Review | undefined {
    const row = this.database
      .prepare(
        'SELECT document FROM reviews WHERE session_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(sessionId);
    return row
      ? reviewSchema.parse(JSON.parse(String(row.document)))
      : undefined;
  }

  byDecision(id: string): Review | undefined {
    const row = this.database
      .prepare(
        "SELECT document FROM reviews WHERE json_extract(document, '$.decision.id') = ?",
      )
      .get(id);
    return row
      ? reviewSchema.parse(JSON.parse(String(row.document)))
      : undefined;
  }

  saveMany(reviews: Review[]): void {
    const records = reviews.map(review => reviewSchema.parse(review));
    const statement = this.database.prepare(
      'INSERT INTO reviews (id, session_id, run_id, version, document, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at',
    );
    for (const review of records)
      statement.run(
        review.id,
        review.sessionId,
        review.runId,
        review.version,
        JSON.stringify(review),
        review.updatedAt,
      );
  }

  supersededBy(sessionId: string): Review[] {
    return this.list()
      .filter(
        review =>
          review.status !== 'superseded' &&
          (review.sessionId === sessionId ||
            review.dependencies.some(
              dependency => dependency.sessionId === sessionId,
            )),
      )
      .map(review => this.change(review, { status: 'superseded' }));
  }

  change(
    review: Review,
    update: Partial<Pick<Review, 'status' | 'decision'>>,
  ): Review {
    return {
      ...review,
      ...update,
      revision: review.revision + 1,
      updatedAt: new Date().toISOString(),
    };
  }

  inherited(
    sessionId: string,
    delegations: Session['delegations'] = [],
  ): Review[] {
    const dependencies = this.latest(sessionId)?.dependencies ?? [];
    const previousGroup = delegations.at(-1)?.runId;
    const groupChildren = delegations
      .filter(
        proposal => proposal.runId === previousGroup && proposal.childSessionId,
      )
      .map(proposal => proposal.childSessionId!);
    const children = groupChildren.length
      ? groupChildren
      : dependencies.map(dependency => dependency.sessionId);
    return [...new Set(children)]
      .map(childId => this.latest(childId))
      .filter(
        (review): review is Review =>
          !!review && review.status !== 'superseded',
      );
  }

  result(session: Session, diff: ReviewDiff): Review {
    const now = new Date().toISOString();
    const dependencies: Review['dependencies'] = [];
    for (const proposal of session.delegations) {
      if (proposal.runId !== session.runId || !proposal.childSessionId)
        continue;
      const child = this.latest(proposal.childSessionId);
      if (child && child.status !== 'superseded')
        dependencies.push({
          sessionId: child.sessionId,
          reviewId: child.id,
          version: child.version,
        });
    }
    if (dependencies.length === 0 && session.role === 'orchestrator') {
      for (const current of this.inherited(session.id, session.delegations))
        dependencies.push({
          sessionId: current.sessionId,
          reviewId: current.id,
          version: current.version,
        });
    }
    return reviewSchema.parse({
      id: randomUUID(),
      sessionId: session.id,
      runId: session.runId,
      version: (this.latest(session.id)?.version ?? 0) + 1,
      revision: 1,
      title: session.title,
      provider: session.provider,
      role: session.role,
      model: session.actualModel ?? session.model,
      directory: session.directory,
      scope: session.scope,
      task:
        session.messages.find(
          message =>
            message.runId === session.runId && message.author === 'operator',
        )?.body ?? '',
      summary: session.messages
        .filter(
          message =>
            message.runId === session.runId && message.author === 'agent',
        )
        .map(message => message.body)
        .join('\n'),
      status: 'pending',
      decision: null,
      dependencies,
      diff,
      createdAt: now,
      updatedAt: now,
    });
  }
}
