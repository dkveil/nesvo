import {
  configurationLimits,
  configurationMutationSchema,
  workLaptopRestriction,
  type ConfigurationChange,
  type ConfigurationDecision,
  type ConfigurationError,
  type ConfigurationHistoryInput,
  type ConfigurationMutation,
  type ConfigurationOwnerFlowStart,
  type ConfigurationOwnerFlowFinish,
  type ConfigurationReceipt,
  type ConfigurationSource,
  type ConfigurationTarget,
  type ConfigurationUndo,
  type ConfigurationValue,
} from '@nesvo/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { redactLogMessage } from '../log-redaction';
import { filterResultText } from './evidence';
import type {
  ConfigurationAction,
  ConfigurationChangeStore,
  ConfigurationIntent,
  ConfigurationSnapshot,
  StoredConfigurationChange,
} from './assistant-change-store';

type Classification = ConfigurationChange['classification'];

type Prepared = {
  after: ConfigurationSnapshot;
  classification: Classification;
};

export type ConfigurationSlot<Effect> = {
  read: () => ConfigurationSnapshot;
  prepare: (
    mutation: ConfigurationMutation,
    before: ConfigurationSnapshot,
    restore?: ConfigurationSnapshot,
  ) => Prepared;
  verify?: (
    from: ConfigurationSnapshot,
    to: ConfigurationSnapshot,
  ) => Promise<void>;
  write: (intent: ConfigurationIntent, authorize: () => void) => Effect;
};

export type ConfigurationWriter =
  | {
      kind: 'database';
      open: (target: ConfigurationTarget) => ConfigurationSlot<void>;
    }
  | {
      kind: 'file';
      locked: <T>(
        target: ConfigurationTarget,
        work: (slot: ConfigurationSlot<Promise<void>>) => Promise<T>,
        recovery?: boolean,
      ) => Promise<T>;
      allocate?: (target: ConfigurationTarget) => ConfigurationTarget;
    };

export type ConfigurationVerb = 'read' | 'propose' | 'apply';

export function revisionedSlot(
  key: string,
  current: () => { value: ConfigurationValue; revision: number },
  save: (value: ConfigurationValue) => void,
  classify: (
    before: ConfigurationValue | null,
    after: ConfigurationValue,
  ) => Classification,
  validate: (value: ConfigurationValue) => ConfigurationValue = value => value,
): ConfigurationSlot<void> {
  return {
    read: () => {
      const { value, revision } = current();
      return {
        version: { type: 'revision', revision },
        value,
        identity: key,
        dependencies: '',
      };
    },
    prepare: ({ draft }, before) => {
      if (!draft || before.version.type !== 'revision')
        throw new ConfigurationRefusal(
          'invalid-request',
          'Choose a value for this setting.',
        );
      const value = validate(draft);
      return {
        classification: classify(before.value, value),
        after: {
          ...before,
          value,
          version: { type: 'revision', revision: before.version.revision + 1 },
        },
      };
    },
    write: ({ to }) => {
      if (!to.value)
        throw new ConfigurationRefusal(
          'invalid-request',
          'Choose a value for this setting.',
        );
      save(to.value);
    },
  };
}
export type ConfigurationPrincipal = {
  source: ConfigurationSource;
  authorize: (verb: ConfigurationVerb, target: ConfigurationTarget) => void;
};

export class ConfigurationRefusal extends Error {
  constructor(
    readonly code: ConfigurationError['code'],
    message: string,
    readonly issues: ConfigurationError['issues'] = [],
  ) {
    super(message);
  }
}

export const absentConfigurationVersion = { type: 'absent' } as const;

export function configurationHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function configurationText(value: string): string {
  return filterResultText(redactLogMessage(value)).replace(
    /\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.[A-Za-z0-9_-]{43}\b/g,
    '[redacted]',
  );
}

function recordText(value: ConfigurationValue | null): string {
  if (value === null) return '';
  return value.kind === 'markdown'
    ? value.document
    : JSON.stringify(value.value, null, 2);
}

function resourceLabel(value: ConfigurationValue | null): string | undefined {
  if (value?.kind === 'session-groups' || value?.kind === 'automations')
    return configurationText(value.value.name).slice(0, 160);
  if (value?.kind === 'budgets') {
    const scope = value.value.scope;
    return scope[0]!.toUpperCase() + scope.slice(1) + ' budget';
  }
}

function preview(before: ConfigurationSnapshot, after: ConfigurationSnapshot) {
  const oldText = configurationText(
    before.document ?? recordText(before.value),
  );
  const newText = configurationText(after.document ?? recordText(after.value));
  const lines = (text: string) => (text ? text.split('\n') : []);
  const oldLines = lines(oldText);
  const newLines = lines(newText);
  let start = 0;
  while (start < oldLines.length && oldLines[start] === newLines[start])
    start++;
  let end = 0;
  while (
    oldLines.length - end > start &&
    newLines.length - end > start &&
    oldLines.at(-1 - end) === newLines.at(-1 - end)
  )
    end++;
  const removed = oldLines.slice(start, oldLines.length - end);
  const added = newLines.slice(start, newLines.length - end);
  const oldStart = removed.length ? start + 1 : start;
  const newStart = added.length ? start + 1 : start;
  const text = [
    '--- Before',
    '+++ After',
    `@@ -${oldStart},${removed.length} +${newStart},${added.length} @@`,
    ...removed.map(line => '-' + line),
    ...added.map(line => '+' + line),
  ].join('\n');
  return {
    text: text.slice(0, configurationLimits.preview),
    truncated: text.length > configurationLimits.preview,
  };
}

function fingerprint(value: unknown): string {
  return configurationHash(
    JSON.stringify(value, (_, entry: unknown) =>
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.entries(entry).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : entry,
    ),
  );
}

function same(left: unknown, right: unknown): boolean {
  return fingerprint(left) === fingerprint(right);
}

function principalId(source: ConfigurationSource): string {
  if (source.kind === 'device') return `device:${source.deviceId}`;
  if (source.kind === 'assistant') return `assistant:${source.sessionId}`;
  return 'owner';
}

function conflict(message: string): never {
  throw new ConfigurationRefusal('conflict', message);
}

function readMutation(input: ConfigurationMutation): ConfigurationMutation {
  const parsed = configurationMutationSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new ConfigurationRefusal(
    'invalid-request',
    'Check the configuration change.',
    parsed.error.issues.slice(0, 20).map(issue => ({
      field: String(issue.path[0] ?? ''),
      message: configurationText(issue.message).slice(0, 400),
    })),
  );
}

const now = () => new Date().toISOString();

function modeConfirmation(
  target: Extract<ConfigurationTarget, { area: 'authority' }>,
  before: ConfigurationSnapshot,
  after: ConfigurationSnapshot,
) {
  if (
    before.version.type !== 'revision' ||
    before.value?.kind !== 'authority' ||
    typeof before.value.value !== 'string' ||
    after.value?.kind !== 'authority' ||
    typeof after.value.value !== 'string'
  )
    throw new ConfigurationRefusal(
      'unavailable',
      'The session permission preview is unavailable.',
    );
  return {
    sessionId: target.id,
    modeRevision: before.version.revision,
    from: before.value.value,
    to: after.value.value,
  };
}

function reviewFields(
  target: ConfigurationTarget,
  before: ConfigurationSnapshot,
  after: ConfigurationSnapshot,
  classification: Classification,
) {
  const mode =
    target.area === 'authority' && target.subject === 'session-mode'
      ? modeConfirmation(target, before, after)
      : undefined;
  return {
    label: before.label ?? resourceLabel(after.value ?? before.value),
    sessionMode:
      mode && before.provider
        ? { ...mode, provider: before.provider }
        : undefined,
    ownerEffect: after.ownerEffect,
    baseVersion: before.version,
    classification,
    diff: preview(before, after),
  };
}

export class ConfigurationChanges {
  private tail: Promise<unknown> = Promise.resolve();
  private writers = new Map<ConfigurationTarget['area'], ConfigurationWriter>();
  private readonly ownerFlows = new Map<
    string,
    {
      action: ConfigurationAction;
      record: StoredConfigurationChange;
    }
  >();

  constructor(
    private readonly store: ConfigurationChangeStore,
    private readonly publish: (change: ConfigurationChange) => void,
    private readonly deviceCanPropose: (
      source: Extract<ConfigurationSource, { kind: 'device' }>,
      target: ConfigurationTarget,
    ) => boolean,
    private readonly workLaptopMode = false,
  ) {}

  register(
    area: ConfigurationTarget['area'],
    writer: ConfigurationWriter,
  ): void {
    this.writers.set(area, writer);
  }

  private writer(target: ConfigurationTarget): ConfigurationWriter {
    const writer = this.writers.get(target.area);
    if (!writer)
      throw new ConfigurationRefusal(
        'unsupported',
        'This computer does not support the target.',
      );
    return writer;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private retry(action: ConfigurationAction): ConfigurationReceipt | null {
    const existing = this.store.receipt(action.principal, action.id);
    if (existing && existing.fingerprint !== action.fingerprint)
      conflict('This action ID belongs to a different request.');
    return existing?.receipt ?? null;
  }

  private action(
    source: ConfigurationSource,
    id: string,
    payload: unknown,
  ): ConfigurationAction {
    return {
      principal: principalId(source),
      id,
      fingerprint: fingerprint(payload),
    };
  }

  list(input: ConfigurationHistoryInput) {
    return this.store.list(input);
  }

  latestEntry(area: 'lessons' | 'gate-rules', root: string, name: string) {
    return this.store.latestEntry(area, root, name);
  }

  draft(input: Pick<ConfigurationDecision, 'id' | 'revision'>) {
    return this.requireProposal(input).mutation.draft;
  }

  status(principal: ConfigurationPrincipal, id: string) {
    const receipt = this.store.receipt(
      principalId(principal.source),
      id,
    )?.receipt;
    const record = this.store.get(receipt?.id ?? id);
    if (
      !record ||
      principalId(record.change.source) !== principalId(principal.source)
    )
      throw new ConfigurationRefusal(
        'unavailable',
        'The configuration action is unavailable.',
      );
    principal.authorize(record.verb ?? 'propose', record.change.target);
    const { revision, status, resultingVersion } = record.change;
    return { id: record.change.id, revision, status, resultingVersion };
  }

  async get(principal: ConfigurationPrincipal, target: ConfigurationTarget) {
    principal.authorize('read', target);
    const writer = this.writer(target);
    const read = (slot: ConfigurationSlot<unknown>) => {
      principal.authorize('read', target);
      const { version, value, document } = slot.read();
      const text = document ?? recordText(value);
      const normalized = text.replace(/\r\n?/g, '\n');
      const withheld = configurationText(text) !== normalized;
      const operations: ConfigurationMutation['operation'][] = withheld
        ? []
        : 'key' in target || target.area === 'authority'
          ? ['update']
          : value === null
            ? ['create']
            : ['update', 'delete'];
      return {
        target,
        version,
        value: withheld ? null : value,
        withheld,
        operations,
      };
    };
    return writer.kind === 'database'
      ? read(writer.open(target))
      : writer.locked(target, async slot => read(slot));
  }

  submit(
    principal: ConfigurationPrincipal,
    verb: 'propose' | 'apply',
    input: ConfigurationMutation,
  ) {
    const request = readMutation(input);
    return this.serial(async () => {
      const { actionId } = request;
      principal.authorize(verb, request.target);
      const action = this.action(principal.source, actionId, {
        verb,
        mutation: request,
      });
      const duplicate = this.retry(action);
      if (duplicate)
        return {
          receipt: duplicate,
          change: this.store.get(duplicate.id)?.change ?? null,
        };
      const writer = this.writer(request.target);
      if (verb === 'apply' && writer.kind === 'file')
        throw new ConfigurationRefusal(
          'review-required',
          'Review this file change in Nesvo.',
        );
      const target =
        writer.kind === 'file' &&
        verb === 'propose' &&
        request.operation === 'create'
          ? (writer.allocate?.(request.target) ?? request.target)
          : request.target;
      const authorize = () => principal.authorize(verb, target);
      const mutation = { ...request, target };
      const prepare = (slot: ConfigurationSlot<unknown>) => {
        const before = slot.read();
        const { after, classification } = this.prepare(slot, mutation, before);
        if (verb === 'apply' && classification !== 'direct')
          throw new ConfigurationRefusal(
            'review-required',
            'Review this change in Nesvo.',
          );
        return this.record(
          principal.source,
          mutation,
          before,
          after,
          classification,
          verb,
        );
      };
      if (verb === 'propose') {
        const propose = (record: StoredConfigurationChange) => {
          authorize();
          const counts = this.store.pending(
            principal.source.kind === 'device'
              ? principal.source.deviceId
              : null,
          );
          if (
            counts.total >= configurationLimits.pendingPerHost ||
            counts.device >= configurationLimits.pendingPerDevice
          )
            throw new ConfigurationRefusal(
              'pending-limit',
              'The pending configuration proposal limit was reached.',
            );
          return { record, receipt: this.store.settle(action, record) };
        };
        const result =
          writer.kind === 'database'
            ? this.store.transaction(() =>
                propose(prepare(writer.open(target))),
              )
            : await writer.locked(target, async slot => {
                const record = prepare(slot);
                await slot.verify?.(record.before, record.after);
                return this.store.transaction(() => propose(record));
              });
        this.publish(result.record.change);
        return { receipt: result.receipt, change: result.record.change };
      }
      return this.commit(writer, target, action, authorize, prepare);
    });
  }

  decide(input: ConfigurationDecision) {
    return this.serial(async () => {
      const action = this.action({ kind: 'owner' }, input.actionId, {
        decide: input,
      });
      const duplicate = this.retry(action);
      if (duplicate) return duplicate;
      const record =
        input.decision === 'accept'
          ? this.require(input.id, input.revision, 'pending')
          : this.requireProposal(input);
      if (input.decision === 'edit') {
        const writer = this.writer(record.change.target);
        const revise = (slot: ConfigurationSlot<unknown>) => {
          const before = slot.read();
          const mutation = readMutation({
            ...record.mutation,
            baseVersion: before.version,
            draft: input.draft ?? null,
          });
          const { after, classification } = this.prepare(
            slot,
            mutation,
            before,
          );
          const { change } = this.transition(record, 'pending', 'owner');
          const next = {
            ...record,
            mutation,
            before,
            after,
            change: {
              ...change,
              ...reviewFields(mutation.target, before, after, classification),
            },
          };
          return next;
        };
        const save = (next: StoredConfigurationChange) => ({
          next,
          receipt: this.store.settle(action, next),
        });
        const result =
          writer.kind === 'database'
            ? this.store.transaction(() =>
                save(revise(writer.open(record.change.target))),
              )
            : await writer.locked(record.change.target, async slot => {
                const next = revise(slot);
                await slot.verify?.(next.before, next.after);
                return this.store.transaction(() => save(next));
              });
        this.publish(result.next.change);
        return result.receipt;
      }
      if (input.decision === 'dismiss') {
        const dismissed = this.transition(record, 'dismissed', 'owner');
        const receipt = this.store.transaction(() =>
          this.store.settle(action, dismissed),
        );
        this.publish(dismissed.change);
        return receipt;
      }
      if (record.change.ownerEffect)
        throw new ConfigurationRefusal(
          'review-required',
          'Complete this proposal in its desktop confirmation flow.',
        );
      const authorize = () => {
        const { source, target } = record.change;
        if (
          source.kind === 'device' &&
          !this.deviceCanPropose(source, target) &&
          !input.reviewRevocation
        )
          throw new ConfigurationRefusal(
            'review-required',
            'Review this proposal again after its device grant changed.',
          );
        if (target.area === 'authority')
          this.confirmMode(target, record.before, record.after, input);
        else
          this.confirmAuthority(
            record.change.classification,
            input.confirmAuthority,
          );
      };
      const prepare = (slot: ConfigurationSlot<unknown>) => {
        const before = slot.read();
        const { after, classification } = this.prepare(
          slot,
          record.mutation,
          before,
        );
        if (
          !same(before, record.before) ||
          !same(
            { ...after, state: undefined },
            { ...record.after, state: undefined },
          ) ||
          classification !== record.change.classification
        )
          conflict('The reviewed effect changed. Prepare a fresh proposal.');
        return this.transition(record, 'applied', 'owner');
      };
      try {
        return (
          await this.commit(
            this.writer(record.change.target),
            record.change.target,
            action,
            authorize,
            prepare,
          )
        ).receipt;
      } catch (error) {
        if (
          !(error instanceof ConfigurationRefusal) ||
          error.code !== 'conflict'
        )
          throw error;
        const conflicted = this.transition(record, 'conflicted', 'owner');
        const receipt = this.store.transaction(() =>
          this.store.settle(action, conflicted),
        );
        this.publish(conflicted.change);
        return receipt;
      }
    });
  }

  undo(input: ConfigurationUndo) {
    return this.serial(async () => {
      const action = this.action({ kind: 'owner' }, input.actionId, {
        undo: input,
      });
      const duplicate = this.retry(action);
      if (duplicate) return duplicate;
      const record = this.require(input.id, input.revision, 'applied');
      if (record.change.ownerEffect)
        throw new ConfigurationRefusal(
          'review-required',
          'Make a new owner decision in the original settings flow.',
        );
      const target = record.change.target;
      const restore = (slot: ConfigurationSlot<unknown>) => {
        const before = slot.read();
        if (
          before.identity !== record.after.identity ||
          before.dependencies !== record.after.dependencies ||
          !same(before.version, record.after.version)
        )
          conflict(
            'The configuration changed after this action. Undo would overwrite a newer edit.',
          );
        const mutation = readMutation({
          target,
          actionId: input.actionId,
          baseVersion: before.version,
          operation:
            record.mutation.operation === 'create'
              ? 'delete'
              : record.mutation.operation === 'delete'
                ? 'create'
                : 'update',
          draft: record.before.value,
        });
        const { after, classification } = this.prepare(
          slot,
          mutation,
          before,
          record.before,
        );
        if (target.area === 'authority')
          this.confirmMode(target, before, after, input);
        else this.confirmAuthority(classification, input.confirmAuthority);
        const undone = this.transition(record, 'undone', 'owner');
        return {
          record: {
            ...undone,
            change: { ...undone.change, resultingVersion: after.version },
          },
          from: before,
          to: after,
        };
      };
      return (
        await this.commit(
          this.writer(target),
          target,
          action,
          () => undefined,
          restore,
        )
      ).receipt;
    });
  }

  startOwnerFlow(input: ConfigurationOwnerFlowStart) {
    return this.serial(async () => {
      if (this.workLaptopMode)
        throw new ConfigurationRefusal('unsupported', workLaptopRestriction);
      const action = this.action({ kind: 'owner' }, input.actionId, {
        ownerFlow: input,
      });
      if (this.retry(action))
        throw new ConfigurationRefusal(
          'conflict',
          'This confirmation was already used. Check Change history.',
        );
      const record = this.require(input.id, input.revision, 'pending');
      const { target, source, ownerEffect } = record.change;
      if (!ownerEffect || !same(ownerEffect, input.effect))
        throw new ConfigurationRefusal(
          'review-required',
          'Confirm the reviewed action in its desktop flow.',
        );
      if (
        source.kind === 'device' &&
        !this.deviceCanPropose(source, target) &&
        !input.reviewRevocation
      )
        throw new ConfigurationRefusal(
          'review-required',
          'Review this proposal again after its device grant changed.',
        );
      const writer = this.writer(target);
      if (writer.kind !== 'database')
        throw new ConfigurationRefusal(
          'unsupported',
          'The confirmation flow is unavailable.',
        );
      const claim = randomUUID();
      const intent = this.store.transaction(() => {
        const slot = writer.open(target);
        const before = slot.read();
        const { after } = this.prepare(slot, record.mutation, before);
        if (!same(before, record.before) || !same(after, record.after))
          conflict('The reviewed action changed. Prepare a fresh proposal.');
        const next = this.transition(record, 'inspection-required', 'owner');
        this.store.settle(action, next);
        return next;
      });
      this.ownerFlows.set(claim, { action, record: intent });
      this.publish(intent.change);
      return { claim, change: record.change };
    });
  }

  finishOwnerFlow(input: ConfigurationOwnerFlowFinish) {
    return this.serial(async () => {
      const running = this.ownerFlows.get(input.claim);
      if (!running)
        throw new ConfigurationRefusal(
          'conflict',
          'This confirmation is no longer active. Check Change history.',
        );
      const { id, revision } = running.record.change;
      this.require(id, revision, 'inspection-required');
      this.ownerFlows.delete(input.claim);
      if (!input.outcome) return;
      const change = this.transition(running.record, 'applied', 'owner');
      change.change.resultingVersion = null;
      change.change.outcome = {
        ...input.outcome,
        description: configurationText(input.outcome.description).slice(0, 200),
      };
      const receipt = this.store.transaction(() =>
        this.store.settleOwnerFlow(running.action, change),
      );
      this.publish(change.change);
      return receipt;
    });
  }

  async recover(): Promise<void> {
    for (const intent of this.store.intents()) await this.reconcile(intent);
  }

  private confirmAuthority(classification: Classification, confirmed: boolean) {
    if (classification === 'authority' && this.workLaptopMode)
      throw new ConfigurationRefusal('unsupported', workLaptopRestriction);
    if (classification === 'authority' && !confirmed)
      throw new ConfigurationRefusal(
        'review-required',
        'Confirm the change in authority in Nesvo.',
      );
  }

  private confirmMode(
    target: Extract<ConfigurationTarget, { area: 'authority' }>,
    before: ConfigurationSnapshot,
    after: ConfigurationSnapshot,
    input: ConfigurationDecision | ConfigurationUndo,
  ) {
    if (
      !input.confirmSessionMode ||
      !same(input.confirmSessionMode, modeConfirmation(target, before, after))
    )
      throw new ConfigurationRefusal(
        'review-required',
        'Confirm the exact permission mode and session in Nesvo.',
      );
  }

  private require(
    id: string,
    revision: number,
    status: ConfigurationChange['status'],
  ) {
    const record = this.store.get(id);
    if (
      !record ||
      record.change.revision !== revision ||
      record.change.status !== status
    )
      conflict(
        'The configuration change is no longer at the reviewed revision.',
      );
    if (this.store.hasIntent(id))
      throw new ConfigurationRefusal(
        'busy',
        'The outcome of a file write is being reconciled.',
      );
    return record;
  }

  private requireProposal(
    input: Pick<ConfigurationDecision, 'id' | 'revision'>,
  ) {
    const status = this.store.get(input.id)?.change.status;
    if (status !== 'pending' && status !== 'conflicted')
      conflict('This configuration proposal can no longer be edited.');
    return this.require(input.id, input.revision, status);
  }

  private prepare(
    slot: ConfigurationSlot<unknown>,
    mutation: ConfigurationMutation,
    before: ConfigurationSnapshot,
    restore?: ConfigurationSnapshot,
  ) {
    if (!same(mutation.baseVersion, before.version))
      conflict('The configuration version changed. Read it again.');
    if (
      mutation.draft &&
      configurationText(recordText(mutation.draft)) !==
        recordText(mutation.draft).replace(/\r\n?/g, '\n')
    )
      throw new ConfigurationRefusal(
        'invalid-request',
        'The draft contains credential-like or unsupported text.',
      );
    const prepared = slot.prepare(mutation, before, restore);
    if (same(before.value, prepared.after.value))
      throw new ConfigurationRefusal(
        'invalid-request',
        'The configuration is already set to this value.',
      );
    return prepared;
  }

  private record(
    source: ConfigurationSource,
    mutation: ConfigurationMutation,
    before: ConfigurationSnapshot,
    after: ConfigurationSnapshot,
    classification: Classification,
    verb: 'apply' | 'propose',
  ): StoredConfigurationChange {
    const at = now();
    return {
      mutation,
      before,
      after,
      verb,
      change: {
        id: randomUUID(),
        revision: 1,
        source,
        target: mutation.target,
        ...reviewFields(mutation.target, before, after, classification),
        operation: mutation.operation,
        status: verb === 'propose' ? 'pending' : 'applied',
        createdAt: at,
        updatedAt: at,
        resultingVersion: verb === 'apply' ? after.version : null,
        decidedBy:
          verb === 'apply'
            ? source.kind === 'device'
              ? 'device'
              : 'owner'
            : null,
      },
    };
  }

  private transition(
    record: StoredConfigurationChange,
    status: ConfigurationChange['status'],
    decidedBy: 'owner' | 'device' | null,
  ): StoredConfigurationChange {
    return {
      ...record,
      change: {
        ...record.change,
        status,
        decidedBy,
        updatedAt: now(),
        revision: record.change.revision + 1,
        resultingVersion: status === 'applied' ? record.after.version : null,
      },
    };
  }

  private async commit(
    writer: ConfigurationWriter,
    target: ConfigurationTarget,
    action: ConfigurationAction,
    authorize: () => void,
    prepare: (
      slot: ConfigurationSlot<unknown>,
    ) => StoredConfigurationChange | Omit<ConfigurationIntent, 'action'>,
  ) {
    const planned = (slot: ConfigurationSlot<unknown>): ConfigurationIntent => {
      const result = prepare(slot);
      authorize();
      if ('record' in result) return { action, ...result };
      return { action, record: result, from: result.before, to: result.after };
    };
    const result =
      writer.kind === 'database'
        ? this.store.transaction(() => {
            const slot = writer.open(target);
            const intent = planned(slot);
            slot.write(intent, authorize);
            return {
              intent,
              receipt: this.store.settle(action, intent.record),
            };
          })
        : await writer.locked(target, async slot => {
            const intent = planned(slot);
            await slot.verify?.(intent.from, intent.to);
            authorize();
            this.store.intent(intent);
            try {
              await slot.write(intent, authorize);
            } catch {
              return { intent, receipt: null };
            }
            return { intent, receipt: this.store.completeIntent(intent) };
          });
    if (!result.receipt) return this.reconcile(result.intent);
    this.publish(result.intent.record.change);
    return { receipt: result.receipt, change: result.intent.record.change };
  }

  private async reconcile(intent: ConfigurationIntent) {
    const target = intent.record.change.target;
    const writer = this.writers.get(target.area);
    let status: ConfigurationChange['status'] = 'inspection-required';
    if (writer?.kind === 'file') {
      try {
        status = await writer.locked(
          target,
          async slot => {
            const current = slot.read();
            if (
              current.identity === intent.to.identity &&
              same(current.version, intent.to.version)
            )
              return intent.record.change.status;
            if (
              current.identity === intent.from.identity &&
              same(current.version, intent.from.version)
            )
              return 'conflicted';
            return 'inspection-required';
          },
          true,
        );
      } catch {
        status = 'inspection-required';
      }
    }
    const settled =
      status === intent.record.change.status
        ? intent.record
        : {
            ...intent.record,
            change: {
              ...intent.record.change,
              status,
              resultingVersion: null,
              updatedAt: now(),
            },
          };
    const receipt = this.store.completeIntent({ ...intent, record: settled });
    this.publish(settled.change);
    return { receipt, change: settled.change };
  }
}
