import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  providerUsageHoldSchema,
  providerUsagePolicySchema,
  type ProviderUsage,
  type ProviderUsageEvidence,
  type ProviderUsageGateInput,
  type ProviderUsageGateSettings,
  type ProviderUsageHold,
  type ProviderUsageInput,
  type ProviderUsagePolicy,
} from '@nesvo/contracts';
import { SessionError } from '../sessions/session-error';
import type { ProviderUsageService } from './usage-service';
import { SetupNativeBindings } from '../setup-native-bindings';
import type { SetupReviewInspection } from '../setup-profile-review-queue';
import { activeSetupProfile } from '../setup-profile-service';
import { readSetupProfile } from '../setup-profile-file';

type Entry = ProviderUsageGateSettings['history'][number];
export type UsageIntent = Omit<
  ProviderUsageHold,
  'createdAt' | 'status' | 'revision' | 'evidence'
>;

export class ProviderUsageHeld extends SessionError {
  constructor(readonly hold: ProviderUsageHold) {
    super(
      'busy',
      `${hold.evidence.reason ?? 'Provider usage held this request.'} Check again in Settings › Permissions.`,
    );
  }
}

const targetOf = ({
  provider,
  profileId,
}: ProviderUsageInput): ProviderUsageInput => ({
  provider,
  profileId: profileId ?? null,
});
const targetKey = (input: ProviderUsageInput) =>
  JSON.stringify(targetOf(input));
const digest = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');
const empty = {
  reason: null,
  sampledAt: null,
  resetsAt: null,
  windowId: null,
  usedPercent: null,
};
const allowed = { ...empty, state: 'allowed' as const };

const relevantWindow = (id: string, model: string) => {
  const family = /(?:^|[_-])(opus|sonnet|haiku)(?:$|[_-])/i.exec(id)?.[1];
  return !family || model.toLowerCase().includes(family.toLowerCase());
};

export class ProviderUsageGates {
  private readonly profile: SetupNativeBindings;

  constructor(
    private readonly database: DatabaseSync,
    private readonly usage: ProviderUsageService,
    private readonly environment: (
      target: ProviderUsageInput,
      signal: AbortSignal,
    ) => Promise<Readonly<Record<string, string>> | undefined>,
    private readonly accountAlias?: (
      provider: ProviderUsageInput['provider'],
      alias?: string,
    ) => string | null | undefined,
  ) {
    this.profile = new SetupNativeBindings(database, 'usage');
  }

  inspectProfile: SetupReviewInspection = async (
    profile,
    entry,
    instanceId,
  ) => {
    if (!entry.key.startsWith('limits/')) return undefined;
    const limit = profile.usageLimits?.find(
      item => entry.key === 'limits/' + item.id,
    );
    if (!limit || 'disabled' in limit) return undefined;
    const profileId = this.accountAlias?.(limit.provider, limit.account);
    if (profileId === undefined)
      return 'Bind the named provider account on this computer.';
    const target = { provider: limit.provider, profileId };
    const usage = this.usage.observation(target);
    if (
      usage?.status !== 'ready' ||
      !usage.windows.some(window => window.id === limit.window)
    )
      return 'Refresh the selected account’s usage and verify this exact quota window.';
    const policy = providerUsagePolicySchema.parse({
      ...target,
      policy: limit.effect,
      threshold: limit.threshold,
      windows: [limit.window],
      onUnavailable: 'warn',
    });
    const id = digest([instanceId, entry.key]);
    const fingerprint = digest([
      target,
      policy,
      this.profile.get(id)?.generation ?? 0,
    ]);
    return {
      fingerprint,
      description: `${limit.provider} · ${limit.account ?? 'Default account'}\n${limit.effect === 'hold' ? 'Hold' : 'Warn'} at ${limit.threshold}% for ${limit.window}. Unavailable usage warns.`,
      accept: () => {
        this.database
          .prepare(
            `
          INSERT INTO setup_usage_policies (id, target, document) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET target = excluded.target, document = excluded.document
        `,
          )
          .run(id, targetKey(target), JSON.stringify(policy));
        this.profile.bind(id, profile, entry.key, entry.revision, fingerprint);
      },
      applied: () =>
        this.profile.get(id)?.fingerprint === fingerprint &&
        this.profile.passes(id),
      revoke: () => {
        this.profile.revoke(id);
        this.database
          .prepare('DELETE FROM setup_usage_policies WHERE id = ?')
          .run(id);
      },
    };
  };

  private profilePolicies(target?: ProviderUsageInput) {
    const rows = target
      ? this.database
          .prepare(
            'SELECT document FROM setup_usage_policies WHERE target = ? LIMIT 100',
          )
          .all(targetKey(target))
      : this.database
          .prepare('SELECT document FROM setup_usage_policies LIMIT 100')
          .all();
    return rows.map(row =>
      providerUsagePolicySchema.parse(JSON.parse(String(row.document))),
    );
  }

  private canReleaseProfilePolicy(id: string) {
    const binding = this.profile.get(id);
    if (!binding) return false;
    const selected = activeSetupProfile(this.database);
    if (!selected) return true;
    try {
      if (readSetupProfile(selected.path).revision !== selected.revision)
        return false;
    } catch {
      return false;
    }
    return (
      selected.path !== binding.profile ||
      !selected.declarations.some(
        entry =>
          entry.key === binding.declaration &&
          entry.revision === binding.revision,
      )
    );
  }

  private read() {
    return {
      policies: this.database
        .prepare(
          'SELECT document FROM provider_usage_policies ORDER BY rowid DESC LIMIT 100',
        )
        .all()
        .map(row =>
          providerUsagePolicySchema.parse(JSON.parse(String(row.document))),
        ),
      profilePolicies: this.database
        .prepare('SELECT id, document FROM setup_usage_policies LIMIT 100')
        .all()
        .flatMap(row => {
          const id = String(row.id);
          const binding = this.profile.get(id);
          return binding
            ? [
                {
                  ...providerUsagePolicySchema.parse(
                    JSON.parse(String(row.document)),
                  ),
                  id,
                  revision: binding.fingerprint,
                  canRelease: this.canReleaseProfilePolicy(id),
                },
              ]
            : [];
        }),
      holds: this.database
        .prepare(
          'SELECT document FROM provider_usage_holds ORDER BY rowid DESC LIMIT 100',
        )
        .all()
        .map(row =>
          providerUsageHoldSchema.parse(JSON.parse(String(row.document))),
        ),
      history: this.database
        .prepare(
          'SELECT document FROM provider_usage_actions ORDER BY rowid DESC LIMIT 100',
        )
        .all()
        .map(row => JSON.parse(String(row.document)) as Entry),
    };
  }

  private hold(id: string) {
    const row = this.database
      .prepare('SELECT document FROM provider_usage_holds WHERE id = ?')
      .get(id);
    return row
      ? providerUsageHoldSchema.parse(JSON.parse(String(row.document)))
      : undefined;
  }

  private writeHold(hold: ProviderUsageHold) {
    this.database
      .prepare(
        'INSERT INTO provider_usage_holds (id, document) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document',
      )
      .run(hold.id, JSON.stringify(hold));
  }

  private transaction(execute: () => void) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      execute();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private previous(id: string, input: unknown) {
    const row = this.database
      .prepare('SELECT payload FROM provider_usage_actions WHERE id = ?')
      .get(id);
    if (row && row.payload !== digest(input))
      throw new SessionError(
        'invalid-request',
        'This usage action ID is already in use.',
      );
    return !!row;
  }

  private history(
    id: string,
    action: Entry['action'],
    actor: Entry['actor'],
    target: ProviderUsageInput,
    payload: unknown,
    holdId: string | null = null,
  ) {
    const hostId = String(
      this.database
        .prepare("SELECT value FROM metadata WHERE key = 'instance_id'")
        .get()!.value,
    );
    const revision = digest(payload);
    const entry: Entry = {
      id,
      action,
      actor,
      target: targetOf(target),
      holdId,
      revision,
      hostId,
      at: new Date().toISOString(),
    };
    this.database
      .prepare(
        'INSERT INTO provider_usage_actions (id, payload, document) VALUES (?, ?, ?)',
      )
      .run(id, revision, JSON.stringify(entry));
  }

  private async observe(
    target: ProviderUsageInput,
    model: string,
    signal: AbortSignal,
    refresh = false,
  ): Promise<ProviderUsageEvidence> {
    const key = targetKey(target);
    const rejection = this.database
      .prepare(
        'SELECT resets_at, sampled_at FROM provider_usage_rejections WHERE target = ?',
      )
      .get(key);
    const now = Date.now();
    if (rejection) {
      const sampledAt = String(rejection.sampled_at);
      const reset =
        typeof rejection.resets_at === 'string' ? rejection.resets_at : null;
      if (now < (reset ? Date.parse(reset) : Date.parse(sampledAt) + 300_000))
        return {
          ...empty,
          state: 'held',
          reason: `${target.provider} reported an account limit.`,
          sampledAt,
          resetsAt: reset,
        };
    }
    const row = this.database
      .prepare('SELECT document FROM provider_usage_policies WHERE target = ?')
      .get(key);
    const policies = [
      ...(row
        ? [providerUsagePolicySchema.parse(JSON.parse(String(row.document)))]
        : []),
      ...this.profilePolicies(target),
    ];
    if (!policies.length) return allowed;
    const environment = await this.environment(target, signal);
    const usage = await this.usage.read(target, environment, refresh);
    signal.throwIfAborted();
    const severity = { allowed: 0, warning: 1, held: 2 } as const;
    return policies
      .map(policy => this.evaluate(target, model, usage, policy))
      .sort((left, right) => severity[right.state] - severity[left.state])[0]!;
  }

  private evaluate(
    target: ProviderUsageInput,
    model: string,
    usage: ProviderUsage,
    policy: ProviderUsagePolicy,
  ): ProviderUsageEvidence {
    const fresh =
      Date.now() - Date.parse(usage.checkedAt) <=
      (target.provider === 'Codex' ? 60_000 : 300_000);
    const windows = usage.windows.filter(
      window =>
        relevantWindow(window.id, model) &&
        (!policy.windows.length || policy.windows.includes(window.id)) &&
        (!window.resetsAt || Date.parse(window.resetsAt) > Date.now()),
    );
    if (
      fresh &&
      usage.status === 'ready' &&
      usage.ordinaryUsageAllowed === false
    )
      return {
        ...empty,
        state: 'held',
        sampledAt: usage.checkedAt,
        reason: `${target.provider} reports that normal account usage is unavailable.`,
        resetsAt: this.latestReset(windows),
      };
    if (!fresh || usage.status !== 'ready' || !windows.length)
      return {
        ...empty,
        state: policy.onUnavailable === 'hold' ? 'held' : 'warning',
        reason: 'Current usage is unavailable for this account and model.',
        sampledAt: usage.checkedAt,
      };
    const highest = [...windows].sort(
      (a, b) => b.usedPercent - a.usedPercent,
    )[0]!;
    if (highest.usedPercent < policy.threshold)
      return { ...allowed, sampledAt: usage.checkedAt };
    return {
      state: policy.policy === 'hold' ? 'held' : 'warning',
      reason: `${target.provider} reports ${highest.usedPercent}% used for ${highest.label}. This computer’s threshold is ${policy.threshold}%.`,
      resetsAt: highest.resetsAt,
      sampledAt: usage.checkedAt,
      usedPercent: highest.usedPercent,
      windowId: highest.id,
    };
  }

  private latestReset(windows: ProviderUsage['windows']) {
    return (
      windows
        .flatMap(window => (window.resetsAt ? [window.resetsAt] : []))
        .sort()
        .at(-1) ?? null
    );
  }

  async require(intent: UsageIntent, payload: unknown, signal: AbortSignal) {
    const revision = digest([intent, payload]);
    const check = () => {
      const previous = this.hold(intent.id);
      if (!previous) return;
      if (previous.revision !== revision || previous.status === 'cancelled')
        throw new SessionError(
          'invalid-request',
          'This usage hold no longer matches the request.',
        );
      if (previous.status === 'held') throw new ProviderUsageHeld(previous);
      return previous;
    };
    check();
    const evidence = await this.observe(targetOf(intent), intent.model, signal);
    const previous = check();
    if (evidence.state === 'held') {
      const hold: ProviderUsageHold = {
        ...intent,
        ...targetOf(intent),
        revision,
        status: 'held',
        evidence,
        createdAt: previous?.createdAt ?? new Date().toISOString(),
      };
      this.transaction(() => {
        this.writeHold(hold);
        this.history(randomUUID(), 'hold', 'host', intent, evidence, hold.id);
      });
      throw new ProviderUsageHeld(hold);
    }
    if (previous?.status === 'ready')
      this.transaction(() => {
        this.writeHold({ ...previous, evidence, status: 'dispatched' });
        this.history(
          randomUUID(),
          'dispatch',
          'host',
          intent,
          evidence,
          intent.id,
        );
      });
    if (evidence.state === 'warning')
      this.history(randomUUID(), 'warn', 'host', intent, evidence);
    return evidence;
  }

  async checkLaunch(
    target: ProviderUsageInput,
    model: string,
    signal: AbortSignal,
  ) {
    return this.observe(target, model, signal);
  }

  reject(target: ProviderUsageInput, resetsAt: string | null) {
    if (
      !this.database
        .prepare('SELECT target FROM provider_usage_policies WHERE target = ?')
        .get(targetKey(target)) &&
      !this.profilePolicies(target).length
    )
      return;
    this.transaction(() => {
      this.database
        .prepare(
          'INSERT INTO provider_usage_rejections VALUES (?, ?, ?) ON CONFLICT(target) DO UPDATE SET resets_at = excluded.resets_at, sampled_at = excluded.sampled_at',
        )
        .run(targetKey(target), resetsAt, new Date().toISOString());
      this.history(randomUUID(), 'provider-rejected', 'provider', target, [
        targetOf(target),
        resetsAt,
      ]);
    });
  }

  async settings(
    input: ProviderUsageGateInput,
    signal: AbortSignal,
  ): Promise<ProviderUsageGateSettings> {
    if (input.action === 'read' || this.previous(input.actionId, input))
      return this.read();
    if (input.action === 'release-profile') {
      const row = this.database
        .prepare('SELECT document FROM setup_usage_policies WHERE id = ?')
        .get(input.id);
      if (
        !row ||
        this.profile.get(input.id)?.fingerprint !== input.revision ||
        !this.canReleaseProfilePolicy(input.id)
      )
        throw new SessionError(
          'invalid-request',
          'Review the current profile before releasing this restriction.',
        );
      const policy = providerUsagePolicySchema.parse(
        JSON.parse(String(row.document)),
      );
      this.transaction(() => {
        this.profile.revoke(input.id);
        this.database
          .prepare('DELETE FROM setup_usage_policies WHERE id = ?')
          .run(input.id);
        this.history(input.actionId, input.action, 'operator', policy, input);
      });
      return this.read();
    }
    if (input.action === 'save' || input.action === 'remove') {
      const target = input.action === 'save' ? input.policy : input.target;
      if (input.action === 'save') await this.environment(target, signal);
      if (this.previous(input.actionId, input)) return this.read();
      this.transaction(() => {
        if (input.action === 'save')
          this.database
            .prepare(
              'INSERT INTO provider_usage_policies VALUES (?, ?) ON CONFLICT(target) DO UPDATE SET document = excluded.document',
            )
            .run(
              targetKey(target),
              JSON.stringify({ ...input.policy, ...targetOf(target) }),
            );
        else
          this.database
            .prepare('DELETE FROM provider_usage_policies WHERE target = ?')
            .run(targetKey(target));
        this.history(input.actionId, input.action, 'operator', target, input);
      });
      return this.read();
    }
    const hold = this.hold(input.holdId);
    if (!hold || hold.status === 'dispatched' || hold.status === 'cancelled')
      throw new SessionError('not-found', 'This request is no longer held.');
    const evidence =
      input.action === 'check'
        ? await this.observe(hold, hold.model, signal, true)
        : hold.evidence;
    if (this.previous(input.actionId, input)) return this.read();
    const current = this.hold(hold.id);
    if (
      !current ||
      current.status === 'dispatched' ||
      current.status === 'cancelled'
    )
      throw new SessionError('not-found', 'This request is no longer held.');
    this.transaction(() => {
      this.writeHold({
        ...current,
        status:
          input.action === 'cancel'
            ? 'cancelled'
            : evidence.state === 'held'
              ? 'held'
              : 'ready',
        evidence,
      });
      this.history(
        input.actionId,
        input.action,
        'operator',
        hold,
        input,
        hold.id,
      );
    });
    return this.read();
  }
}
