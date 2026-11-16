import type { DatabaseSync } from 'node:sqlite';
import {
  assistantChangeLimits,
  assistantChangeSchema,
  type AssistantChange,
} from '@nesvo/contracts';

export type StoredAssistantChange = {
  change: AssistantChange;
  previous: string | null;
};

export class AssistantChangeStore {
  constructor(private readonly database: DatabaseSync) {}

  nextSequence(conversationId: string): number {
    const row = this.database
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS last FROM assistant_changes WHERE conversation_id = ?',
      )
      .get(conversationId);
    return Number(row?.last ?? 0) + 1;
  }

  insert(change: AssistantChange, previous: string | null): void {
    this.database
      .prepare(
        'INSERT INTO assistant_changes (id, conversation_id, sequence, status, document, previous, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        change.changeId,
        change.conversationId,
        change.sequence,
        change.status,
        JSON.stringify(change),
        previous,
        change.at,
        change.at,
      );
  }

  markUndone(change: AssistantChange): boolean {
    return (
      this.database
        .prepare(
          "UPDATE assistant_changes SET status = 'undone', document = ?, updated_at = ? WHERE id = ? AND status = 'applied'",
        )
        .run(JSON.stringify(change), change.undoneAt, change.changeId)
        .changes === 1
    );
  }

  get(conversationId: string, changeId: string): StoredAssistantChange | null {
    const row = this.database
      .prepare(
        'SELECT document, previous FROM assistant_changes WHERE id = ? AND conversation_id = ?',
      )
      .get(changeId, conversationId);
    if (!row) return null;
    return {
      change: assistantChangeSchema.parse(JSON.parse(String(row.document))),
      previous: row.previous === null ? null : String(row.previous),
    };
  }

  list(conversationId: string): AssistantChange[] {
    return this.database
      .prepare(
        'SELECT document FROM (SELECT document, sequence FROM assistant_changes WHERE conversation_id = ? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence',
      )
      .all(conversationId, assistantChangeLimits.history)
      .map(row => assistantChangeSchema.parse(JSON.parse(String(row.document))));
  }
}
