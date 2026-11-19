import {
  configurationLimits,
  configurationMutationSchema,
  type ConfigurationChange,
  type ConfigurationDecision,
  type ConfigurationError,
  type ConfigurationHistoryInput,
  type ConfigurationMutation,
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
  ) => Prepared;
  write: (intent: ConfigurationIntent) => Effect;
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

function preview(
  before: ConfigurationValue | null,
  after: ConfigurationValue | null,
) {
  const oldText = configurationText(recordText(before));
  const newText = configurationText(recordText(after));
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

export class ConfigurationChanges {
  private tail: Promise<unknown> = Promise.resolve();
  private writers = new Map<ConfigurationTarget['area'], ConfigurationWriter>();

  constructor(
    private readonly store: ConfigurationChangeStore,
    private readonly publish: (change: ConfigurationChange) => void,
    private readonly deviceCanPropose: (
      source: Extract<ConfigurationSource, { kind: 'device' }>,
      target: ConfigurationTarget,
    ) => boolean,
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
      const { version, value } = slot.read();
      const text = recordText(value);
      const normalized = text.replace(/\r\n?/g, '\n');
      const withheld = configurationText(text) !== normalized;
      const operations: ConfigurationMutation['operation'][] = withheld
        ? []
        : writer.kind === 'database'
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
    const mutation = readMutation(input);
    return this.serial(async () => {
      const { target, actionId } = mutation;
      const authorize = () => principal.authorize(verb, target);
      authorize();
      const action = this.action(principal.source, actionId, {
        verb,
        mutation,
      });
      const duplicate = this.retry(action);
      if (duplicate)
        return {
          receipt: duplicate,
          change: this.store.get(duplicate.id)?.change ?? null,
        };
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
      const writer = this.writer(target);
      if (verb === 'propose') {
        const propose = (slot: ConfigurationSlot<unknown>) => {
          const record = prepare(slot);
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
            ? this.store.transaction(() => propose(writer.open(target)))
            : await writer.locked(target, async slot =>
                this.store.transaction(() => propose(slot)),
              );
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
        input.decision === 'edit'
          ? this.requireProposal(input)
          : this.require(input.id, input.revision, 'pending');
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
              classification,
              baseVersion: before.version,
              diff: preview(before.value, after.value),
            },
          };
          return { next, receipt: this.store.settle(action, next) };
        };
        const result =
          writer.kind === 'database'
            ? this.store.transaction(() =>
                revise(writer.open(record.change.target)),
              )
            : await writer.locked(record.change.target, async slot =>
                this.store.transaction(() => revise(slot)),
              );
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
          !same(after, record.after) ||
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
      const target = record.change.target;
      const restore = (slot: ConfigurationSlot<unknown>) => {
        const before = slot.read();
        if (
          before.identity !== record.after.identity ||
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
        const { after, classification } = this.prepare(slot, mutation, before);
        this.confirmAuthority(classification, input.confirmAuthority);
        return {
          ...this.transition(record, 'undone', 'owner'),
          change: {
            ...this.transition(record, 'undone', 'owner').change,
            resultingVersion: after.version,
          },
        };
      };
      return (
        await this.commit(
          this.writer(target),
          target,
          action,
          () => undefined,
          restore,
          record,
        )
      ).receipt;
    });
  }

  async recover(): Promise<void> {
    for (const intent of this.store.intents()) await this.reconcile(intent);
  }

  private confirmAuthority(classification: Classification, confirmed: boolean) {
    if (classification === 'authority' && !confirmed)
      throw new ConfigurationRefusal(
        'review-required',
        'Confirm the change in authority in Nesvo.',
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
    const prepared = slot.prepare(mutation, before);
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
        operation: mutation.operation,
        baseVersion: before.version,
        classification,
        status: verb === 'propose' ? 'pending' : 'applied',
        diff: preview(before.value, after.value),
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
    prepare: (slot: ConfigurationSlot<unknown>) => StoredConfigurationChange,
    undo?: StoredConfigurationChange,
  ) {
    const planned = (slot: ConfigurationSlot<unknown>): ConfigurationIntent => {
      const record = prepare(slot);
      authorize();
      if (!undo)
        return { action, record, from: record.before, to: record.after };
      const current = slot.read();
      return {
        action,
        record,
        from: current,
        to: {
          ...current,
          version: record.change.resultingVersion!,
          value: undo.before.value,
        },
      };
    };
    const result =
      writer.kind === 'database'
        ? this.store.transaction(() => {
            const slot = writer.open(target);
            const intent = planned(slot);
            slot.write(intent);
            return {
              intent,
              receipt: this.store.settle(action, intent.record),
            };
          })
        : await writer.locked(target, async slot => {
            const intent = planned(slot);
            this.store.intent(intent);
            try {
              await slot.write(intent);
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
