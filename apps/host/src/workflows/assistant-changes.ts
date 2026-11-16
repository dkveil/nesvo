import {
  assistantChangeLimits,
  assistantChangeRefusalSchema,
  assistantChangeSchema,
  saveScheduledJobSchema,
  type AssistantAutomationOperation,
  type AssistantChange,
  type AssistantChangeHistory,
  type AssistantChangeRefusal,
  type AssistantChangeTarget,
  type AssistantDefinitionOperation,
  type AssistantOperation,
  type AssistantUndoInput,
  type AssistantUndoResult,
  type DefinitionIssue,
  type DefinitionWriteResult,
  type DesktopEvent,
  type HostRequest,
  type ScheduledJob,
} from '@nesvo/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { ScheduledJobError } from '../scheduled-jobs/service';
import type { AssistantChangeStore } from './assistant-change-store';
import {
  DefinitionError,
  EXTERNAL_GUARD_NOTE,
  inside,
  type DefinitionFile,
} from './definitions';
import { filterResultText } from './evidence';
import type {
  DeleteDefinitionInput,
  SaveDefinitionInput,
  WriteOptions,
} from './writer';

export type ChangeContext = {
  conversationId: string;
  messageId: string;
  directory: string;
};

type SaveAutomationInput = Extract<
  HostRequest,
  { method: 'save-scheduled-job' }
>['input'];

type ChangePorts = {
  store: AssistantChangeStore;
  definitions: {
    save: (
      input: SaveDefinitionInput,
      options: WriteOptions,
    ) => Promise<DefinitionWriteResult>;
    remove: (
      input: DeleteDefinitionInput,
      options: WriteOptions,
    ) => Promise<DefinitionWriteResult>;
  };
  automations: {
    list: () => ScheduledJob[];
    save: (input: SaveAutomationInput) => ScheduledJob;
    delete: (input: { id: string; expectedRevision: number }) => void;
  };
  emit: (event: DesktopEvent) => void;
  now?: () => Date;
};

type Refusal = Pick<
  AssistantChangeRefusal,
  'kind' | 'op' | 'target' | 'summary' | 'reason' | 'issues'
>;

type Applied = Pick<
  AssistantChange,
  'kind' | 'op' | 'target' | 'before' | 'after' | 'summary'
> & { previous: string | null };

export class AssistantChangeError extends Error {
  constructor(
    readonly code: 'not-found' | 'invalid-request',
    message: string,
  ) {
    super(message);
  }
}

const hashOf = (text: string) =>
  createHash('sha256').update(text).digest('hex');

const issueAt = (path: string, message: string): DefinitionIssue => ({
  severity: 'error',
  path,
  line: null,
  message: message.slice(0, 800) || 'The change was refused.',
});

const summaryText = (summary: string) =>
  filterResultText(summary).trim().slice(0, assistantChangeLimits.summary);

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof DefinitionError ||
  error instanceof ScheduledJobError ||
  error instanceof AssistantChangeError
    ? error.message
    : fallback;

const canonical = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

export const automationsIn = (
  jobs: readonly ScheduledJob[],
  directory: string,
): ScheduledJob[] =>
  jobs.filter(job => {
    const folder = canonical(job.directory);
    return !!folder && inside(directory, folder);
  });

const automationDefinition = (job: ScheduledJob) => ({
  name: job.name,
  prompt: job.prompt,
  directory: job.directory,
  provider: job.provider,
  model: job.model,
  effort: job.effort,
  mode: job.mode,
  schedule: job.schedule,
  timeZone: job.timeZone,
  active: job.active,
  timeoutMinutes: job.timeoutMinutes,
  workflow: job.workflow,
});

type DefinitionTarget = Extract<AssistantChangeTarget, { type: 'definition' }>;

const definitionTarget = (
  operation: Pick<AssistantDefinitionOperation, 'kind' | 'scope' | 'name'>,
): DefinitionTarget => ({
  type: 'definition',
  root: operation.scope,
  path: `${operation.kind}s/${operation.name}.md`,
  name: operation.name,
});

const refusalOf = (
  operation: AssistantOperation,
  target: AssistantChangeTarget | null,
  reason: Refusal['reason'],
  issues: DefinitionIssue[],
): Refusal => ({
  kind: operation.kind,
  op: operation.op,
  target,
  summary: operation.summary,
  reason,
  issues: issues.slice(0, assistantChangeLimits.issues),
});

const isGuardIssue = (issue: DefinitionIssue) =>
  issue.message.endsWith(EXTERNAL_GUARD_NOTE);

export class AssistantChanges {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly ports: ChangePorts) {}

  apply(
    context: ChangeContext,
    operation: AssistantOperation,
  ): Promise<AssistantChange | null> {
    return this.serial(context.conversationId, () =>
      this.applyNow(context, operation),
    );
  }

  refuse(context: ChangeContext, refusal: Refusal): void {
    const parsed = assistantChangeRefusalSchema.safeParse({
      conversationId: context.conversationId,
      messageId: context.messageId,
      ...refusal,
      summary: summaryText(refusal.summary),
      at: this.now(),
    });
    if (parsed.success)
      this.ports.emit({
        type: 'workflow-assistant-change-refused',
        refusal: parsed.data,
      });
  }

  undo(input: AssistantUndoInput): Promise<AssistantUndoResult> {
    return this.serial(input.conversationId, () => this.undoNow(input));
  }

  history(conversationId: string): AssistantChangeHistory {
    return { conversationId, changes: this.ports.store.list(conversationId) };
  }

  async idle(conversationId: string): Promise<void> {
    await this.tails.get(conversationId)?.catch(() => undefined);
  }

  private serial<T>(conversationId: string, work: () => Promise<T>) {
    const previous = this.tails.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.tails.set(conversationId, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.tails.get(conversationId) === next)
          this.tails.delete(conversationId);
      });
    return next;
  }

  private now(): string {
    return (this.ports.now?.() ?? new Date()).toISOString();
  }

  private async applyNow(
    context: ChangeContext,
    operation: AssistantOperation,
  ): Promise<AssistantChange | null> {
    const outcome =
      operation.kind === 'automation'
        ? this.applyAutomation(context, operation)
        : await this.applyDefinition(context, operation);
    if ('reason' in outcome) {
      this.refuse(context, outcome);
      return null;
    }
    try {
      return this.record(context, outcome);
    } catch {
      this.refuse(context, {
        kind: outcome.kind,
        op: outcome.op,
        target: outcome.target,
        summary: outcome.summary,
        reason: 'unavailable',
        issues: [
          issueAt(
            outcome.target.type === 'definition' ? outcome.target.path : '',
            'The change was saved but could not be recorded, so it cannot be undone here.',
          ),
        ],
      });
      return null;
    }
  }

  private record(context: ChangeContext, applied: Applied): AssistantChange {
    const { previous, ...fields } = applied;
    const change = assistantChangeSchema.parse({
      conversationId: context.conversationId,
      messageId: context.messageId,
      changeId: randomUUID(),
      sequence: this.ports.store.nextSequence(context.conversationId),
      directory: context.directory,
      ...fields,
      summary: summaryText(fields.summary) || 'Assistant change.',
      createdBy: 'assistant',
      at: this.now(),
      status: 'applied',
      undoneAt: null,
    });
    this.ports.store.insert(change, previous);
    this.ports.emit({ type: 'workflow-assistant-change', change });
    return change;
  }

  private async applyDefinition(
    context: ChangeContext,
    operation: AssistantDefinitionOperation,
  ): Promise<Applied | Refusal> {
    const target = definitionTarget(operation);
    const invalid = (message: string) =>
      refusalOf(operation, target, 'invalid', [
        issueAt(target.path, message),
      ]);
    if (operation.op === 'create' && operation.basedOnHash !== null)
      return invalid('A create has no basedOnHash.');
    if (operation.op !== 'create' && operation.basedOnHash === null)
      return invalid('Name the hash of the file you change in basedOnHash.');
    if (operation.op !== 'delete' && operation.document === null)
      return invalid('A create or update needs the complete document.');
    let previous: DefinitionFile | null = null;
    const options: WriteOptions = {
      guardExternal: true,
      onPrevious: file => {
        previous = file;
      },
    };
    const base = {
      directory: context.directory,
      scope: operation.scope,
      kind: operation.kind,
      name: operation.name,
    };
    let result: DefinitionWriteResult;
    try {
      result =
        operation.op === 'delete'
          ? await this.ports.definitions.remove(
              { ...base, expectedHash: operation.basedOnHash! },
              options,
            )
          : await this.ports.definitions.save(
              {
                ...base,
                document: operation.document!,
                expectedHash: operation.basedOnHash,
              },
              options,
            );
    } catch (error) {
      return refusalOf(
        operation,
        target,
        error instanceof DefinitionError && error.kind === 'invalid'
          ? 'invalid'
          : 'unavailable',
        error instanceof DefinitionError && error.issues.length
          ? error.issues
          : [
              issueAt(
                target.path,
                errorMessage(error, 'The definition could not be written.'),
              ),
            ],
      );
    }
    if ('type' in result) {
      if (result.type === 'workflow-definition-conflict')
        return refusalOf(operation, target, 'conflict', [
          issueAt(
            result.path,
            result.currentHash
              ? `The file changed; its current hash is ${result.currentHash}.`
              : 'The file does not exist.',
          ),
        ]);
      return refusalOf(
        operation,
        target,
        result.issues.some(isGuardIssue) ? 'unsafe' : 'invalid',
        result.issues,
      );
    }
    const replaced = previous as DefinitionFile | null;
    return {
      kind: operation.kind,
      op: operation.op,
      target,
      before: replaced ? { type: 'hash', hash: replaced.contentHash } : null,
      after:
        operation.op === 'delete'
          ? null
          : { type: 'hash', hash: hashOf(operation.document!) },
      summary: operation.summary,
      previous: replaced?.text ?? null,
    };
  }

  private applyAutomation(
    context: ChangeContext,
    operation: AssistantAutomationOperation,
  ): Applied | Refusal {
    const target: AssistantChangeTarget | null = operation.automationId
      ? { type: 'automation', automationId: operation.automationId }
      : null;
    const refuse = (
      reason: Refusal['reason'],
      message: string,
      at: AssistantChangeTarget | null = target,
    ) => refusalOf(operation, at, reason, [issueAt('', message)]);
    if (operation.automation?.active === true)
      return refuse(
        'unsafe',
        'The assistant cannot enable an automation. It is saved disabled and the operator enables it.',
      );
    if (operation.op === 'create') {
      if (operation.basedOnRevision !== null || !operation.automation)
        return refuse(
          'invalid',
          'A create needs the automation fields and no basedOnRevision.',
        );
      const id = randomUUID();
      return this.saveAutomation(operation, null, {
        id,
        expectedRevision: null,
        ...operation.automation,
        directory: context.directory,
      });
    }
    if (!operation.automationId || operation.basedOnRevision === null)
      return refuse(
        'invalid',
        'Name the automation and the revision you change.',
      );
    const current = this.ports.automations
      .list()
      .find(job => job.id === operation.automationId);
    if (!current) return refuse('invalid', 'Automation not found.');
    const folder = canonical(current.directory);
    if (!folder || !inside(context.directory, folder))
      return refuse(
        'unsafe',
        'This automation belongs to another folder and cannot be changed from this conversation.',
      );
    if (current.revision !== operation.basedOnRevision)
      return refuse(
        'conflict',
        `The automation changed; its current revision is ${current.revision}.`,
      );
    if (operation.op === 'delete') {
      try {
        this.ports.automations.delete({
          id: current.id,
          expectedRevision: current.revision,
        });
      } catch (error) {
        return refuse(
          'unavailable',
          errorMessage(error, 'The automation could not be deleted.'),
        );
      }
      return {
        kind: 'automation',
        op: 'delete',
        target: { type: 'automation', automationId: current.id },
        before: { type: 'revision', revision: current.revision },
        after: null,
        summary: operation.summary,
        previous: JSON.stringify(current),
      };
    }
    if (!operation.automation)
      return refuse('invalid', 'An update needs the automation fields.');
    return this.saveAutomation(operation, current, {
      id: current.id,
      expectedRevision: current.revision,
      ...operation.automation,
      directory: current.directory,
    });
  }

  private saveAutomation(
    operation: AssistantAutomationOperation,
    current: ScheduledJob | null,
    fields: Record<string, unknown>,
  ): Applied | Refusal {
    const target: AssistantChangeTarget = {
      type: 'automation',
      automationId: String(fields.id),
    };
    const parsed = saveScheduledJobSchema.safeParse({
      ...fields,
      mode: 'read-only',
      active: false,
    });
    if (!parsed.success)
      return refusalOf(
        operation,
        target,
        'invalid',
        parsed.error.issues.map(item =>
          issueAt(item.path.join('.'), item.message),
        ),
      );
    let job: ScheduledJob;
    try {
      job = this.ports.automations.save(parsed.data);
    } catch (error) {
      return refusalOf(operation, target, 'invalid', [
        issueAt('', errorMessage(error, 'The automation could not be saved.')),
      ]);
    }
    return {
      kind: 'automation',
      op: operation.op,
      target,
      before: current ? { type: 'revision', revision: current.revision } : null,
      after: { type: 'revision', revision: job.revision },
      summary: operation.summary,
      previous: current ? JSON.stringify(current) : null,
    };
  }

  private async undoNow(input: AssistantUndoInput): Promise<AssistantUndoResult> {
    const stored = this.ports.store.get(input.conversationId, input.changeId);
    if (!stored)
      throw new AssistantChangeError('not-found', 'Change not found.');
    const { change, previous } = stored;
    if (change.status === 'undone')
      throw new AssistantChangeError(
        'invalid-request',
        'This change was already undone.',
      );
    const outcome =
      change.target.type === 'automation'
        ? this.undoAutomation(change, change.target.automationId, previous)
        : await this.undoDefinition(change, change.target, previous);
    if (outcome) return outcome;
    const undone = assistantChangeSchema.parse({
      ...change,
      status: 'undone',
      undoneAt: this.now(),
    });
    this.ports.store.markUndone(undone);
    this.ports.emit({ type: 'workflow-assistant-change', change: undone });
    return { status: 'undone', change: undone };
  }

  private async undoDefinition(
    change: AssistantChange,
    target: DefinitionTarget,
    previous: string | null,
  ): Promise<AssistantUndoResult | null> {
    const base = {
      directory: change.directory,
      scope: target.root,
      kind: change.kind as 'step' | 'workflow',
      name: target.name,
    };
    const afterHash = change.after?.type === 'hash' ? change.after.hash : null;
    let result: DefinitionWriteResult;
    try {
      if (change.op === 'create')
        result = await this.ports.definitions.remove(
          { ...base, expectedHash: afterHash! },
          {},
        );
      else
        result = await this.ports.definitions.save(
          {
            ...base,
            document: previous ?? '',
            expectedHash: change.op === 'update' ? afterHash : null,
          },
          {},
        );
    } catch (error) {
      return {
        status: 'refused',
        changeId: change.changeId,
        issues: [
          issueAt(
            target.path,
            errorMessage(error, 'The change could not be undone.'),
          ),
        ],
      };
    }
    if (!('type' in result)) return null;
    if (result.type === 'workflow-definition-conflict')
      return {
        status: 'conflict',
        changeId: change.changeId,
        current: result.currentHash
          ? { type: 'hash', hash: result.currentHash }
          : null,
        message:
          'The file changed after this assistant change. Undo would overwrite newer content, so nothing was changed.',
      };
    return {
      status: 'refused',
      changeId: change.changeId,
      issues: result.issues.length
        ? result.issues.slice(0, assistantChangeLimits.issues)
        : [issueAt(target.path, 'The change could not be undone.')],
    };
  }

  private undoAutomation(
    change: AssistantChange,
    automationId: string,
    previous: string | null,
  ): AssistantUndoResult | null {
    const current = this.ports.automations
      .list()
      .find(job => job.id === automationId);
    const expected =
      change.after?.type === 'revision' ? change.after.revision : null;
    if ((current?.revision ?? null) !== expected)
      return {
        status: 'conflict',
        changeId: change.changeId,
        current: current
          ? { type: 'revision', revision: current.revision }
          : null,
        message:
          'The automation changed after this assistant change. Undo would overwrite newer settings, so nothing was changed.',
      };
    try {
      if (change.op === 'create') {
        this.ports.automations.delete({
          id: automationId,
          expectedRevision: expected!,
        });
        return null;
      }
      const restored = JSON.parse(previous ?? 'null') as ScheduledJob;
      this.ports.automations.save(
        saveScheduledJobSchema.parse({
          id: automationId,
          expectedRevision: expected,
          ...automationDefinition(restored),
        }),
      );
      return null;
    } catch (error) {
      return {
        status: 'refused',
        changeId: change.changeId,
        issues: [
          issueAt(
            '',
            errorMessage(error, 'The automation could not be restored.'),
          ),
        ],
      };
    }
  }
}
