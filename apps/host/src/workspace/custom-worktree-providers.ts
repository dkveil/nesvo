import { createHmac, randomUUID } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  worktreeProviderCheckoutSchema,
  worktreeProviderDefinitionSchema,
  worktreeProviderListingSchema,
  worktreeProviderRemovalSchema,
  worktreeProviderStatusSchema,
  type DirectCommand,
  type AttachWorktree,
  type RepositoryIdentity,
  type Session,
  type SessionWorktreeBinding,
  type WorktreeProviderDefinition,
  type WorktreeProviderInput,
  type WorktreeProviderReply,
  type WorktreeTaskFields,
} from '@nesvo/contracts';
import { redactLogMessage } from '../log-redaction';
import { directoryKey } from '../mcp/scoped-config';
import {
  inspectDirectCommand,
  runDirectCommand,
} from '../process/direct-command';
import {
  inspectRepositoryIdentity,
  matchesRepositoryPattern,
} from '../repositories/identity';
import { worktreeAttachmentClaimed } from '../sessions/folder-locks';
import { SessionError } from '../sessions/session-error';
import {
  nativeProfileCommand,
  SetupNativeBindings,
} from '../setup-native-bindings';
import { activeSetupProfile } from '../setup-profile-service';
import type { SetupReviewInspection } from '../setup-profile-review-queue';
import type { LoadedSetupProfile } from '../setup-profile-file';
import {
  readHeadCommit,
  readSessionWorktreeStatus,
  registeredWorktrees,
  runGit,
  SESSION_WORKTREE_BRANCH_PREFIX,
  worktreeSlug,
} from './isolation';

type ExternalProvider = Extract<
  WorktreeProviderDefinition,
  { kind: 'external' }
>;
type ReconciliationContext = {
  directory: string;
  gitDirectory: string;
  remote: string | null;
  roots: string[];
  branch: string;
  base: string;
  checkout: string | null;
};
type VerifiedRepository = Extract<
  RepositoryIdentity,
  { status: 'remote' | 'local' }
>;
type Settings = Extract<WorktreeProviderReply, { action: 'read' }>;
type Receipt = Settings['history'][number];
type Summary = Settings['providers'][number];
type Operation = 'create' | 'remove' | 'list' | 'status';
type Stored = {
  id: string;
  scope_key: string;
  fingerprint: string;
  definition: string;
  revoked: number;
};
type Candidate = {
  id: string;
  scopeKey: string;
  fingerprint: string;
  definition: WorktreeProviderDefinition;
};
type BranchPolicy = NonNullable<WorktreeProviderDefinition['branchPolicy']>;
type WorktreeRequest = {
  directory: string;
  title: string;
  sessionId: string;
  branch?: string;
  workerBranch?: string;
  base?: string;
  fields?: WorktreeTaskFields;
};

const operations = ['create', 'remove', 'list', 'status'] as const;
const builtinProviderId = '1f1d6934-0361-413b-a950-afb83ab659f9';
const commonPlaceholders = new Set([
  'repository',
  'task',
  'branch',
  'base',
  'title',
  'sessionId',
]);
const branchPolicyPattern = /^(?!.*\\[1-9])(?!.*\(\?[^:])(?!.*\)[+*?{]).+$/u;
const profileBranchPolicy = (template: string): BranchPolicy => ({
  template,
  validation: '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$',
});
const contains = (root: string, path: string) => {
  const tail = relative(root, path);
  return (
    !!tail && tail !== '..' && !tail.startsWith('..' + sep) && !isAbsolute(tail)
  );
};
const fail = (message: string): never => {
  throw new SessionError('invalid-request', message);
};
const canonicalPath = async (path: string) => {
  if (!isAbsolute(path))
    fail('Use an absolute folder path on the selected computer.');
  const result = await realpath(path);
  if (!(await stat(result)).isDirectory())
    fail('The selected path must be a folder.');
  return result;
};
const toCandidate = (row: Stored): Candidate => ({
  id: row.id,
  scopeKey: row.scope_key,
  fingerprint: row.fingerprint,
  definition: worktreeProviderDefinitionSchema.parse(
    JSON.parse(row.definition),
  ),
});

function summary(candidate: Candidate): Summary {
  return {
    providerId: candidate.id,
    name: candidate.definition.name,
    kind: candidate.definition.kind,
    scope: candidate.definition.scope,
    fingerprint: candidate.fingerprint,
  };
}

function remoteOf(identity: VerifiedRepository) {
  return identity.status === 'remote' ? identity.remote : null;
}

function exactKey(identity: VerifiedRepository) {
  return JSON.stringify([
    'repository',
    directoryKey(identity.gitDirectory),
    remoteOf(identity),
  ]);
}

function branchRule(pattern: string) {
  if (
    !branchPolicyPattern.test(pattern) ||
    (pattern.match(/[+*?{]/g)?.length ?? 0) > 6
  )
    fail('The branch validation pattern must use bounded, simple expressions.');
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return fail('The branch validation pattern is invalid.');
  }
}

export class CustomWorktreeProviders {
  private readonly key: string;
  readonly profile: SetupNativeBindings;

  constructor(
    private readonly database: DatabaseSync,
    private readonly directory: string,
    private readonly sessions: () => readonly Pick<
      Session,
      'directory' | 'worktree'
    >[],
  ) {
    this.profile = new SetupNativeBindings(database, 'worktree-providers');
    database
      .prepare(
        "INSERT OR IGNORE INTO metadata (key, value) VALUES ('custom_worktrees_key', ?)",
      )
      .run(randomUUID());
    this.key = String(
      database
        .prepare(
          "SELECT value FROM metadata WHERE key = 'custom_worktrees_key'",
        )
        .get()!.value,
    );
    const actions = database
      .prepare(
        "SELECT id, receipt FROM custom_worktree_actions WHERE json_extract(receipt, '$.state') = 'pending'",
      )
      .all();
    for (const action of actions) {
      const receipt = JSON.parse(String(action.receipt)) as Receipt;
      this.updateReceipt({
        ...receipt,
        state: 'uncertain',
        detail:
          'The host stopped before the command outcome could be recorded.',
      });
    }
  }

  inspectProfile(signal: AbortSignal): SetupReviewInspection {
    return async (profile, entry) => {
      if (!entry.key.startsWith('worktrees/')) return undefined;
      const item = profile.desired?.worktrees?.find(
        item => entry.key === 'worktrees/' + item.id,
      );
      if (!item || 'disabled' in item) return undefined;
      try {
        const definition = worktreeProviderDefinitionSchema.parse({
          name: item.name,
          version: 1,
          scope: item.scope,
          kind: item.kind,
          ...(item.branch
            ? {
                branchPolicy: profileBranchPolicy(item.branch),
              }
            : {}),
          ...(item.kind === 'external'
            ? {
                checkoutRoots: item.checkoutRoots,
                create: nativeProfileCommand(item.create),
                remove: nativeProfileCommand(item.remove),
                list: nativeProfileCommand(item.list),
                ...(item.status
                  ? { status: nativeProfileCommand(item.status) }
                  : {}),
              }
            : {}),
        });
        const inspected = await this.inspect(definition, signal);
        const existing = this.atScope(inspected.scopeKey);
        const binding = existing && this.profile.get(existing.id);
        return {
          fingerprint: this.sign([
            inspected.fingerprint,
            binding?.generation ?? 0,
          ]),
          description: [
            'Review worktree provider ' + definition.name + '.',
            'Scope: ' + inspected.scope,
            ...inspected.roots.map(root => 'Checkout root: ' + root),
            ...inspected.commands.map(
              command =>
                command.operation +
                ': ' +
                JSON.stringify([command.executable, ...command.argv]),
            ),
            ...(existing && !binding
              ? ['Transfer the current provider at this scope to the profile.']
              : []),
            'Verified digest: ' + inspected.fingerprint,
          ]
            .map(line => redactLogMessage(line))
            .join('\n'),
          accept: () => {
            const result = this.saveApproved(
              {
                action: 'approve',
                actionId: randomUUID(),
                definition,
                fingerprint: inspected.fingerprint,
              },
              inspected,
              true,
            );
            this.profile.bind(
              result.provider.providerId,
              profile,
              entry.key,
              entry.revision,
              inspected.fingerprint,
            );
          },
          applied: () => {
            const row = this.atScope(inspected.scopeKey);
            return (
              !!row &&
              !row.revoked &&
              row.fingerprint === inspected.fingerprint &&
              this.profile.get(row.id)?.revision === entry.revision &&
              this.profile.passes(row.id)
            );
          },
          revoke: () => {
            const row = this.atScope(inspected.scopeKey);
            if (row) this.profile.revoke(row.id);
          },
        };
      } catch (error) {
        return redactLogMessage(
          error instanceof Error
            ? error.message
            : 'The worktree provider could not be verified.',
        ).slice(0, 300);
      }
    };
  }

  private sign(value: unknown) {
    return createHmac('sha256', this.key)
      .update(JSON.stringify(value))
      .digest('hex');
  }

  private row(id: string) {
    return this.database
      .prepare('SELECT * FROM custom_worktree_providers WHERE id = ?')
      .get(id) as Stored | undefined;
  }

  private providers() {
    return (
      this.database
        .prepare(
          'SELECT * FROM custom_worktree_providers WHERE revoked = 0 ORDER BY rowid DESC LIMIT 128',
        )
        .all() as unknown as Stored[]
    )
      .filter(row => this.profile.passes(row.id))
      .map(toCandidate);
  }

  private atScope(scopeKey: string) {
    return this.database
      .prepare('SELECT * FROM custom_worktree_providers WHERE scope_key = ?')
      .get(scopeKey) as Stored | undefined;
  }

  private async identity(directory: string, signal: AbortSignal) {
    const identity = await inspectRepositoryIdentity(directory, signal);
    if (identity.status !== 'remote' && identity.status !== 'local')
      return fail(
        'The Git repository identity could not be verified for this worktree operation.',
      );
    return identity;
  }

  private async inspect(
    definition: WorktreeProviderDefinition,
    signal: AbortSignal,
  ) {
    const { scope } = definition;
    const identity =
      scope.kind === 'repository'
        ? await this.identity(scope.directory, signal)
        : null;
    const scopeKey = identity
      ? exactKey(identity)
      : scope.kind === 'pattern'
        ? 'pattern:' + scope.pattern
        : 'computer';
    if (definition.branchPolicy) branchRule(definition.branchPolicy.validation);
    const roots =
      definition.kind === 'external'
        ? await Promise.all(definition.checkoutRoots.map(canonicalPath))
        : [];
    const commands = [];
    if (definition.kind === 'external') {
      for (const operation of operations) {
        const command = definition[operation];
        if (!command) continue;
        this.validateCommand(command, operation);
        const verified = await inspectDirectCommand(
          command,
          this.directory,
          scopeKey,
          this.key,
          signal,
        );
        commands.push({
          operation,
          fingerprint: verified.fingerprint,
          executable: verified.executable,
          argv: command.argv.map(value =>
            redactLogMessage(value).slice(0, 4096),
          ),
        });
      }
    }
    return {
      scopeKey,
      scope: identity
        ? (remoteOf(identity) ?? identity.gitDirectory)
        : scope.kind === 'pattern'
          ? scope.pattern
          : 'This computer',
      roots,
      commands,
      fingerprint: this.sign([
        scopeKey,
        definition,
        roots,
        commands.map(command => [command.operation, command.fingerprint]),
      ]),
    };
  }

  private validateCommand(command: DirectCommand, operation: Operation) {
    if (command.files.some(file => !isAbsolute(file)))
      fail('Use absolute paths for command artifacts.');
    if (
      command.argv.some(argument =>
        /(?:--?(?:token|password|api[-_]?key|secret|authorization)\b|:\/\/[^/\s]+@)/i.test(
          argument,
        ),
      )
    )
      fail('Keep credentials out of the command arguments.');
    for (const argument of command.argv)
      for (const [, name] of argument.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)>/g))
        if (
          !commonPlaceholders.has(name!) &&
          (name !== 'path' || operation === 'create' || operation === 'list')
        )
          fail('This operation uses an unsupported argument placeholder.');
  }

  private previous(id: string, payload: unknown) {
    const row = this.database
      .prepare(
        'SELECT payload, receipt, result FROM custom_worktree_actions WHERE id = ?',
      )
      .get(id);
    if (!row) return null;
    if (row.payload !== this.sign(payload))
      fail('This worktree action ID is already in use.');
    return {
      receipt: JSON.parse(String(row.receipt)) as Receipt,
      result:
        row.result === null
          ? null
          : (JSON.parse(String(row.result)) as unknown),
    };
  }

  private insertReceipt(receipt: Receipt, payload: unknown) {
    this.database
      .prepare(
        'INSERT INTO custom_worktree_actions (id, payload, receipt) VALUES (?, ?, ?)',
      )
      .run(receipt.actionId, this.sign(payload), JSON.stringify(receipt));
  }

  private updateReceipt(receipt: Receipt, result?: unknown) {
    this.database
      .prepare(
        'UPDATE custom_worktree_actions SET receipt = ?, result = ? WHERE id = ?',
      )
      .run(
        JSON.stringify(receipt),
        result === undefined ? null : JSON.stringify(result),
        receipt.actionId,
      );
  }

  private receipt(
    actionId: string,
    provider: Candidate,
    operation: Receipt['operation'],
    sessionId: string | null,
    state: Receipt['state'],
  ): Receipt {
    return {
      actionId,
      operation,
      state,
      providerId: provider.id,
      fingerprint: provider.fingerprint,
      sessionId,
      at: new Date().toISOString(),
      exitCode: null,
      detail: null,
    };
  }

  async settings(
    input: WorktreeProviderInput,
    signal: AbortSignal,
  ): Promise<WorktreeProviderReply> {
    if (input.action === 'attachments')
      return this.attachments(input.directory, signal);
    if (input.action === 'reconcile') return this.reconcile(input, signal);
    if (input.action === 'read')
      return {
        action: 'read',
        providers: this.providers().map(summary),
        history: this.database
          .prepare(
            'SELECT receipt FROM custom_worktree_actions ORDER BY rowid DESC LIMIT 100',
          )
          .all()
          .map(row => JSON.parse(String(row.receipt)) as Receipt),
      };
    if (input.action === 'effective') {
      let provider: Candidate | undefined;
      try {
        const selected = await this.select(input.directory, signal);
        provider = selected?.provider;
        if (provider) await this.verify(provider, signal);
        return {
          action: 'effective',
          provider: provider ? summary(provider) : null,
          branch: this.branch(
            provider,
            {
              ...input,
              sessionId: '00000000-0000-0000-0000-000000000000',
            },
            selected?.branchPolicy,
          ),
          reason: null,
        };
      } catch (error) {
        return {
          action: 'effective',
          provider: provider ? summary(provider) : null,
          branch: null,
          reason:
            error instanceof Error
              ? error.message
              : 'Worktree policy is unavailable.',
        };
      }
    }
    if (input.action === 'inspect') {
      const inspected = await this.inspect(input.definition, signal);
      return {
        action: 'inspect',
        scope: inspected.scope,
        roots: inspected.roots,
        fingerprint: inspected.fingerprint,
        commands: inspected.commands.map(({ operation, executable, argv }) => ({
          operation,
          executable,
          argv,
        })),
      };
    }
    if (input.action === 'revoke') {
      if (this.previous(input.actionId, input)) return { action: 'revoke' };
      const row = this.row(input.providerId);
      if (!row) return fail('The worktree provider was not found.');
      if (this.profile.get(row.id))
        return fail(
          'This provider is managed by the profile. Edit it in Your setup.',
        );
      this.transaction(() => {
        this.database
          .prepare(
            'UPDATE custom_worktree_providers SET revoked = 1 WHERE id = ?',
          )
          .run(row.id);
        this.insertReceipt(
          this.receipt(
            input.actionId,
            toCandidate(row),
            'revoke',
            null,
            'succeeded',
          ),
          input,
        );
      });
      return { action: 'revoke' };
    }
    const inspected = await this.inspect(input.definition, signal);
    const previous = this.previous(input.actionId, input);
    if (previous?.result) return previous.result as WorktreeProviderReply;
    if (input.fingerprint !== inspected.fingerprint)
      return fail('The worktree provider changed. Review the command again.');
    return this.saveApproved(input, inspected);
  }

  private saveApproved(
    input: Extract<WorktreeProviderInput, { action: 'approve' }>,
    inspected: Awaited<ReturnType<CustomWorktreeProviders['inspect']>>,
    profile = false,
  ) {
    const row = this.atScope(inspected.scopeKey);
    if (!profile && row && this.profile.get(row.id))
      return fail(
        'This provider is managed by the profile. Edit it in Your setup.',
      );
    if ((!row || row.revoked) && this.providers().length >= 128)
      fail('This computer has reached its worktree provider limit.');
    const provider: Candidate = {
      id: row?.id ?? randomUUID(),
      scopeKey: inspected.scopeKey,
      fingerprint: inspected.fingerprint,
      definition: input.definition,
    };
    const result = { action: 'approve' as const, provider: summary(provider) };
    this.transaction(() => {
      this.database
        .prepare(
          'INSERT INTO custom_worktree_providers (id, scope_key, fingerprint, definition) VALUES (?, ?, ?, ?) ON CONFLICT(scope_key) DO UPDATE SET fingerprint = excluded.fingerprint, definition = excluded.definition, revoked = 0',
        )
        .run(
          provider.id,
          provider.scopeKey,
          provider.fingerprint,
          JSON.stringify(provider.definition),
        );
      const receipt = this.receipt(
        input.actionId,
        provider,
        'approve',
        null,
        'succeeded',
      );
      this.insertReceipt(receipt, input);
      this.updateReceipt(receipt, result);
    });
    return result;
  }

  private async reconcile(
    input: Extract<WorktreeProviderInput, { action: 'reconcile' }>,
    signal: AbortSignal,
  ) {
    type Result = Extract<WorktreeProviderReply, { action: 'reconcile' }>;
    const existing = this.previous(input.actionId, input);
    if (existing?.result) return existing.result as Result;
    const row = this.database
      .prepare(
        'SELECT receipt, context FROM custom_worktree_actions LEFT JOIN custom_worktree_reconciliation ON action_id = id WHERE id = ?',
      )
      .get(input.receiptId);
    if (!row) return fail('The worktree receipt was not found.');
    const original = JSON.parse(String(row.receipt)) as Receipt;
    if (
      original.state !== 'uncertain' ||
      (original.operation !== 'create' && original.operation !== 'remove')
    )
      return fail('Select an uncertain worktree create or remove receipt.');
    const context =
      typeof row.context === 'string'
        ? (JSON.parse(row.context) as ReconciliationContext)
        : null;
    let result: Result = {
      action: 'reconcile',
      receiptId: input.receiptId,
      decision: 'inconclusive',
      checkout: null,
      detail:
        'This older receipt has no verified checkout context. Inspect the registered worktrees before taking another action.',
    };
    if (context)
      result = await this.reconcileGit(
        original.operation,
        input.receiptId,
        context,
        signal,
      );
    signal.throwIfAborted();
    const repeated = this.previous(input.actionId, input);
    if (repeated?.result) return repeated.result as Result;
    const receipt: Receipt = {
      ...original,
      actionId: input.actionId,
      operation: 'reconcile',
      state: 'succeeded',
      at: new Date().toISOString(),
      exitCode: null,
      detail: result.detail,
    };
    this.transaction(() => {
      this.insertReceipt(receipt, input);
      this.updateReceipt(receipt, result);
    });
    return result;
  }

  private async reconcileGit(
    operation: 'create' | 'remove',
    receiptId: string,
    context: ReconciliationContext,
    signal: AbortSignal,
  ) {
    const result = (
      decision: 'checkout-present' | 'checkout-removed' | 'inconclusive',
      detail: string,
      checkout: string | null = null,
    ) => ({
      action: 'reconcile' as const,
      receiptId,
      decision,
      detail,
      checkout,
    });
    try {
      const identity = await this.identity(context.directory, signal);
      if (
        directoryKey(identity.gitDirectory) !==
          directoryKey(context.gitDirectory) ||
        remoteOf(identity) !== context.remote
      )
        return result(
          'inconclusive',
          'The recorded repository identity changed. Review it before taking another action.',
        );
      const entries = await registeredWorktrees(
        identity.root,
        signal,
        identity.gitDirectory,
      );
      const candidate = entries.filter(
        entry =>
          entry.branch === context.branch &&
          (!context.checkout ||
            directoryKey(entry.worktree) === directoryKey(context.checkout)),
      );
      if (candidate.length === 1 && !candidate[0]!.prunable) {
        const verified = await this.verifyCheckout(
          candidate[0]!.worktree,
          context.branch,
          identity,
          context.roots,
          signal,
        );
        if (operation === 'create' && verified.head !== context.base)
          return result(
            'inconclusive',
            'Git found the branch at a different commit. Review the checkout before attaching it.',
            verified.checkout,
          );
        return result(
          'checkout-present',
          operation === 'create'
            ? 'Git verified the checkout at the requested branch and commit. It can be reviewed in Attach existing worktree.'
            : 'Git verified that the original checkout is still registered.',
          verified.checkout,
        );
      }
      if (
        operation === 'remove' &&
        context.checkout &&
        !entries.some(
          entry =>
            directoryKey(entry.worktree) === directoryKey(context.checkout!),
        )
      ) {
        const exists = await lstat(context.checkout).then(
          () => true,
          error => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        );
        const branch = await runGit({
          args: [
            'show-ref',
            '--verify',
            '--quiet',
            'refs/heads/' + context.branch,
          ],
          cwd: identity.root,
          timeoutMs: 5000,
          signal,
        });
        if (!exists && branch.code === 0)
          return result(
            'checkout-removed',
            'Git verified that the pinned checkout is gone and its branch remains.',
          );
      }
      return result(
        'inconclusive',
        'Git could not verify the complete outcome. Inspect the repository before taking another action.',
      );
    } catch {
      signal.throwIfAborted();
      return result(
        'inconclusive',
        'Git could not verify the recorded checkout. No provider mutation was attempted.',
      );
    }
  }

  private transaction(apply: () => void) {
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) this.database.exec('BEGIN IMMEDIATE');
    try {
      apply();
      if (ownsTransaction) this.database.exec('COMMIT');
    } catch (error) {
      if (ownsTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async select(directory: string, signal: AbortSignal) {
    const providers = this.providers();
    const profile = activeSetupProfile(this.database);
    const desired = profile?.desired?.worktrees ?? [];
    const branches = profile?.portable?.branches ?? [];
    if (
      !providers.length &&
      ![...desired, ...branches].some(item => !('disabled' in item))
    )
      return null;
    const identity = await this.identity(directory, signal);
    const branchId = await this.profileSelection(branches, identity, signal);
    const branch = branches.find(item => item.id === branchId);
    const branchPolicy =
      branch && 'template' in branch
        ? profileBranchPolicy(branch.template)
        : undefined;
    const fromProfile = await this.profileSelection(desired, identity, signal);
    if (fromProfile) {
      const provider = providers.find(
        candidate =>
          this.profile.get(candidate.id)?.declaration ===
          'worktrees/' + fromProfile,
      );
      if (!provider)
        return fail(
          'Review the worktree provider declared by the active profile before creating or attaching a checkout.',
        );
      return { identity, provider, branchPolicy };
    }
    const exact = providers.find(
      provider => provider.scopeKey === exactKey(identity),
    );
    const remote = remoteOf(identity);
    const patterns =
      !exact && remote
        ? providers
            .flatMap(provider => {
              const { scope } = provider.definition;
              return scope.kind === 'pattern' &&
                matchesRepositoryPattern(scope.pattern, remote)
                ? [
                    {
                      provider,
                      specificity: scope.pattern
                        .split('/')
                        .filter(part => part !== '*').length,
                    },
                  ]
                : [];
            })
            .sort((first, second) => second.specificity - first.specificity)
        : [];
    if (patterns[0] && patterns[0].specificity === patterns[1]?.specificity)
      fail('Resolve the matching worktree provider patterns in Settings.');
    const fallback = providers.find(
      provider => provider.definition.scope.kind === 'computer',
    );
    return {
      identity,
      provider: exact ?? patterns[0]?.provider ?? fallback,
      branchPolicy,
    };
  }

  private async profileSelection(
    declared: ReadonlyArray<
      | NonNullable<
          NonNullable<LoadedSetupProfile['desired']>['worktrees']
        >[number]
      | NonNullable<
          NonNullable<LoadedSetupProfile['portable']>['branches']
        >[number]
    >,
    identity: VerifiedRepository,
    signal: AbortSignal,
  ) {
    const remote = remoteOf(identity);
    const matches: { id: string; rank: number }[] = [];
    for (const item of declared) {
      if ('disabled' in item) continue;
      const scope = item.scope;
      if (scope.kind === 'computer') matches.push({ id: item.id, rank: 0 });
      else if (
        scope.kind === 'pattern' &&
        remote &&
        matchesRepositoryPattern(scope.pattern, remote)
      )
        matches.push({
          id: item.id,
          rank: scope.pattern.split('/').filter(part => part !== '*').length,
        });
      else if (scope.kind === 'repository') {
        const source = await inspectRepositoryIdentity(
          scope.directory,
          signal,
        ).catch(() => null);
        if (
          source &&
          (source.status === 'remote' || source.status === 'local') &&
          exactKey(source) === exactKey(identity)
        )
          matches.push({ id: item.id, rank: 100 });
      }
    }
    matches.sort((a, b) => b.rank - a.rank);
    if (matches[0] && matches[0].rank === matches[1]?.rank)
      return fail(
        'Resolve the competing repository scopes in the active profile.',
      );
    return matches[0]?.id;
  }

  branch(
    provider: Candidate | undefined,
    request: WorktreeRequest,
    profile?: BranchPolicy,
  ) {
    const policy = profile ?? provider?.definition.branchPolicy;
    const slug = request.fields?.slug ?? worktreeSlug(request.title, 'session');
    if (!policy)
      return (
        request.branch ??
        request.workerBranch ??
        SESSION_WORKTREE_BRANCH_PREFIX +
          slug +
          '-' +
          request.sessionId.slice(0, 8)
      );
    const values = {
      ...request.fields,
      TICKET: request.fields?.ticket,
      slug,
      id: request.sessionId.slice(0, 8),
    };
    const branch =
      request.branch ??
      policy.template.replace(
        /<(type|TICKET|slug|id)>/g,
        (_, key: keyof typeof values) =>
          values[key] ??
          fail('Complete the task fields required by the branch policy.'),
      );
    if (branch.length > 200 || !branchRule(policy.validation).test(branch))
      fail('The branch does not match the selected worktree provider policy.');
    return branch;
  }

  private async verify(provider: Candidate, signal: AbortSignal) {
    const inspected = await this.inspect(provider.definition, signal);
    const current = this.row(provider.id);
    if (
      !current ||
      current.revoked ||
      !this.profile.passes(provider.id) ||
      current.fingerprint !== inspected.fingerprint ||
      inspected.fingerprint !== provider.fingerprint
    )
      fail(
        'The worktree provider is changed or revoked. Review it in Settings.',
      );
    return inspected;
  }

  private async verifyCheckout(
    path: string,
    branch: string,
    identity: VerifiedRepository,
    roots: string[],
    signal: AbortSignal,
    allowSource = false,
  ) {
    const checkout = await canonicalPath(path);
    const root = roots.find(root => contains(root, checkout));
    if (
      !root ||
      directoryKey(checkout) !== directoryKey(path) ||
      (!allowSource && directoryKey(checkout) === directoryKey(identity.root))
    )
      return fail(
        'The provider returned a checkout outside its approved roots.',
      );
    const entries = await registeredWorktrees(
      identity.root,
      signal,
      identity.gitDirectory,
    );
    const entry = entries
      .slice(1)
      .find(entry => directoryKey(entry.worktree) === directoryKey(checkout));
    if (!entry || entry.prunable || entry.branch !== branch || !entry.head)
      return fail(
        'The provider result does not match a registered Git checkout.',
      );
    const verified = await this.identity(checkout, signal);
    if (
      directoryKey(verified.gitDirectory) !==
        directoryKey(identity.gitDirectory) ||
      remoteOf(verified) !== remoteOf(identity)
    )
      return fail('The checkout does not belong to the approved repository.');
    return { checkout, root, head: entry.head };
  }

  private async execute<T>(
    operation: Operation,
    actionId: string,
    request: WorktreeRequest,
    identity: VerifiedRepository,
    provider: Candidate,
    bindings: Record<string, string>,
    signal: AbortSignal,
    read: (value: unknown, roots: string[]) => Promise<T>,
  ): Promise<T> {
    const definition = provider.definition as ExternalProvider;
    const command = definition[operation];
    if (!command)
      return fail('The selected provider does not support this operation.');
    const payload = [
      operation,
      provider.fingerprint,
      identity.gitDirectory,
      request,
      bindings,
    ];
    const previous = this.previous(actionId, payload);
    if (previous) {
      if (previous.receipt.state === 'succeeded' && previous.result)
        return previous.result as T;
      return fail(
        previous.receipt.detail ??
          'This action is already in progress. Inspect the checkout before retrying.',
      );
    }
    const inspected = await this.verify(provider, signal);
    const verified = await inspectDirectCommand(
      command,
      this.directory,
      provider.scopeKey,
      this.key,
      signal,
    );
    if (
      inspected.commands.find(command => command.operation === operation)
        ?.fingerprint !== verified.fingerprint
    )
      return fail('The executable changed before dispatch.');
    if (this.previous(actionId, payload))
      return fail('This action is already in progress.');
    const current = this.row(provider.id);
    if (
      current?.fingerprint !== provider.fingerprint ||
      current?.revoked ||
      !this.profile.passes(provider.id)
    )
      return fail('The worktree provider was edited before dispatch.');
    const receipt = this.receipt(
      actionId,
      provider,
      operation,
      request.sessionId,
      'pending',
    );
    this.transaction(() => {
      this.insertReceipt(receipt, payload);
      if (operation === 'create' || operation === 'remove') {
        const context: ReconciliationContext = {
          directory: identity.root,
          gitDirectory: identity.gitDirectory,
          remote: remoteOf(identity),
          roots: inspected.roots,
          branch: bindings.branch!,
          base: bindings.base!,
          checkout: bindings.path ?? null,
        };
        this.database
          .prepare(
            'INSERT INTO custom_worktree_reconciliation (action_id, context) VALUES (?, ?)',
          )
          .run(actionId, JSON.stringify(context));
      }
    });
    let exitCode: number | null = null;
    let diagnostic = '';
    try {
      const result = await runDirectCommand(
        command,
        { ...verified, cwd: identity.root },
        bindings,
        signal,
      );
      exitCode = result.code;
      diagnostic = redactLogMessage(result.stderr).trim().slice(0, 600);
      if (result.timedOut || result.code !== 0 || result.outputTruncated)
        fail(
          result.timedOut
            ? 'The worktree provider timed out.'
            : 'The worktree provider failed or exceeded its output limit.',
        );
      const line = result.stdout.trimEnd().split(/\r?\n/).at(-1) ?? '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail('The worktree provider did not return versioned JSON.');
      }
      const resolved = await read(parsed, inspected.roots);
      this.updateReceipt(
        {
          ...receipt,
          state: 'succeeded',
          exitCode,
          detail: diagnostic || null,
        },
        resolved,
      );
      return resolved;
    } catch (error) {
      const summary =
        error instanceof SessionError
          ? error.message
          : 'The provider result could not be verified.';
      const detail = [summary, diagnostic]
        .filter(Boolean)
        .join(' ')
        .slice(0, 1024);
      const state =
        operation === 'create' || operation === 'remove'
          ? 'uncertain'
          : 'failed';
      this.updateReceipt({ ...receipt, state, detail, exitCode });
      return fail(detail);
    }
  }

  async create(
    request: WorktreeRequest,
    selection: Awaited<ReturnType<CustomWorktreeProviders['select']>>,
    signal: AbortSignal,
  ) {
    const provider = selection?.provider;
    if (!selection) return null;
    const { identity } = selection;
    const branch = this.branch(provider, request, selection.branchPolicy);
    if (!provider)
      return selection.branchPolicy
        ? { kind: 'builtin' as const, branch }
        : null;
    if (provider.definition.kind === 'builtin') {
      await this.verify(provider, signal);
      return { kind: 'builtin' as const, branch };
    }
    const base = request.base ?? (await readHeadCommit(identity.root, signal));
    const check = await runGit({
      args: ['check-ref-format', '--branch', branch],
      cwd: identity.root,
      timeoutMs: 5000,
      signal,
    });
    if (check.code !== 0 || check.stdout.trim() !== branch)
      return fail('The requested branch is invalid.');
    const collision = await runGit({
      args: ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch],
      cwd: identity.root,
      timeoutMs: 5000,
      signal,
    });
    if (
      collision.code !== 1 &&
      !this.database
        .prepare('SELECT 1 FROM custom_worktree_actions WHERE id = ?')
        .get(request.sessionId)
    )
      return fail(
        'The worktree branch already exists or could not be checked.',
      );
    const bindings = this.bindings(identity, request, branch, base);
    const binding = await this.execute(
      'create',
      request.sessionId,
      request,
      identity,
      provider,
      bindings,
      signal,
      async (value, roots) => {
        const result = worktreeProviderCheckoutSchema.parse(value);
        if (result.branch !== branch || result.base !== base)
          return fail(
            'The provider returned a different branch or starting commit.',
          );
        const verified = await this.verifyCheckout(
          result.path,
          branch,
          identity,
          roots,
          signal,
        );
        if (verified.head !== base)
          fail('The registered checkout is not at the requested base commit.');
        return {
          version: 1,
          gitDirectory: identity.gitDirectory,
          repository: remoteOf(identity),
          checkout: verified.checkout,
          root: verified.root,
          ownership: 'created',
          providerId: provider.id,
          providerKind: 'external',
          revision: provider.fingerprint,
          branch,
          base,
        } satisfies SessionWorktreeBinding;
      },
    );
    await this.verifyCheckout(
      binding.checkout,
      binding.branch,
      identity,
      [binding.root],
      signal,
    );
    return {
      kind: 'external' as const,
      branch,
      base,
      binding,
      projectDirectory: identity.checkouts[0]!,
    };
  }

  private bindings(
    identity: VerifiedRepository,
    request: WorktreeRequest,
    branch: string,
    base: string,
  ) {
    return {
      repository: identity.root,
      task: request.fields?.slug ?? worktreeSlug(request.title, 'session'),
      branch,
      base,
      title: request.title,
      sessionId: request.sessionId,
    };
  }

  private async pinned(
    binding: SessionWorktreeBinding,
    directory: string,
    signal: AbortSignal,
  ) {
    const row = this.row(binding.providerId);
    if (!row || row.revoked || row.fingerprint !== binding.revision)
      return fail(
        'The pinned provider changed or was revoked. Review the checkout before cleanup.',
      );
    const identity = await this.identity(directory, signal);
    if (
      remoteOf(identity) !== binding.repository ||
      directoryKey(identity.gitDirectory) !== directoryKey(binding.gitDirectory)
    )
      return fail(
        'The repository identity changed after the checkout was bound.',
      );
    return { identity, provider: toCandidate(row) };
  }

  async remove(
    binding: SessionWorktreeBinding,
    request: WorktreeRequest,
    actionId: string,
    signal: AbortSignal,
  ) {
    const { identity, provider } = await this.pinned(
      binding,
      request.directory,
      signal,
    );
    const bindings = {
      ...this.bindings(identity, request, binding.branch, binding.base),
      path: binding.checkout,
    };
    await this.execute(
      'remove',
      actionId,
      request,
      identity,
      provider,
      bindings,
      signal,
      async value => {
        const result = worktreeProviderRemovalSchema.parse(value);
        if (
          directoryKey(result.path) !== directoryKey(binding.checkout) ||
          result.branch !== binding.branch ||
          result.base !== binding.base
        )
          return fail(
            'The removal acknowledgement does not match the pinned checkout.',
          );
        const exists = await lstat(binding.checkout).then(
          () => true,
          error => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        );
        const current = await registeredWorktrees(
          identity.root,
          signal,
          identity.gitDirectory,
        );
        const branch = await runGit({
          args: [
            'show-ref',
            '--verify',
            '--quiet',
            'refs/heads/' + binding.branch,
          ],
          cwd: identity.root,
          timeoutMs: 5000,
          signal,
        });
        if (
          exists ||
          current.some(
            entry =>
              directoryKey(entry.worktree) === directoryKey(binding.checkout),
          ) ||
          branch.code !== 0
        )
          return fail(
            'Git could not verify removal with the branch preserved.',
          );
        return result;
      },
    );
  }

  async list(request: WorktreeRequest, signal: AbortSignal) {
    const selection = await this.select(request.directory, signal);
    if (
      !selection?.provider ||
      selection.provider.definition.kind !== 'external'
    )
      return [];
    const { identity, provider } = selection;
    const base = await readHeadCommit(identity.root, signal);
    return this.execute(
      'list',
      randomUUID(),
      request,
      identity,
      provider,
      this.bindings(identity, request, '', base),
      signal,
      async (value, roots) => {
        const list = worktreeProviderListingSchema.parse(value);
        for (const item of list.checkouts)
          await this.verifyCheckout(
            item.path,
            item.branch,
            identity,
            roots,
            signal,
          );
        return list.checkouts;
      },
    );
  }

  async status(
    binding: SessionWorktreeBinding,
    request: WorktreeRequest,
    signal: AbortSignal,
  ) {
    const { identity, provider } = await this.pinned(
      binding,
      request.directory,
      signal,
    );
    if (provider.definition.kind !== 'external' || !provider.definition.status)
      return null;
    const bindings = {
      ...this.bindings(identity, request, binding.branch, binding.base),
      path: binding.checkout,
    };
    return this.execute(
      'status',
      randomUUID(),
      request,
      identity,
      provider,
      bindings,
      signal,
      async (value, roots) => {
        const status = worktreeProviderStatusSchema.parse(value);
        if (
          directoryKey(status.path) !== directoryKey(binding.checkout) ||
          status.branch !== binding.branch ||
          status.base !== binding.base
        )
          return fail(
            'The provider status does not match the pinned checkout.',
          );
        await this.verifyCheckout(
          status.path,
          status.branch,
          identity,
          roots,
          signal,
        );
        return status;
      },
    );
  }

  private attachmentRequest(directory: string): WorktreeRequest {
    return {
      directory,
      title: 'Attach existing worktree',
      sessionId: '00000000-0000-0000-0000-000000000000',
    };
  }

  private builtin(identity: VerifiedRepository): Candidate {
    return {
      id: builtinProviderId,
      scopeKey: exactKey(identity),
      fingerprint: this.sign(['builtin', exactKey(identity)]),
      definition: {
        version: 1,
        kind: 'builtin',
        name: 'Built-in Git',
        scope: { kind: 'repository', directory: identity.root },
      },
    };
  }

  private async attachments(
    directory: string,
    signal: AbortSignal,
  ): Promise<Extract<WorktreeProviderReply, { action: 'attachments' }>> {
    const identity = await this.identity(directory, signal);
    const entries = await registeredWorktrees(
      identity.root,
      signal,
      identity.gitDirectory,
    );
    const selection = await this.select(directory, signal);
    const external =
      selection?.provider?.definition.kind === 'external'
        ? selection.provider
        : undefined;
    let externalReason: string | null = null;
    const known = external
      ? await this.list(this.attachmentRequest(directory), signal).catch(
          error => {
            externalReason =
              error instanceof Error
                ? error.message
                : 'The external provider could not list its checkouts.';
            return [];
          },
        )
      : [];
    const rows: Extract<
      WorktreeProviderReply,
      { action: 'attachments' }
    >['rows'] = [];
    const builtin = this.builtin(identity);
    const sessions = this.sessions();
    for (const entry of entries.slice(1, 41)) {
      if (entry.prunable || !entry.branch || !entry.head) continue;
      const checkout = await realpath(entry.worktree).catch(() => null);
      if (
        !checkout ||
        directoryKey(checkout) !== directoryKey(entry.worktree) ||
        worktreeAttachmentClaimed(sessions, checkout)
      )
        continue;
      const binding: SessionWorktreeBinding = {
        version: 1,
        gitDirectory: identity.gitDirectory,
        repository: remoteOf(identity),
        checkout,
        root: dirname(checkout),
        ownership: 'adopted',
        providerId: builtin.id,
        providerKind: 'builtin',
        revision: builtin.fingerprint,
        branch: entry.branch,
        base: entry.head,
      };
      const checked = await readSessionWorktreeStatus({
        dataDirectory: this.directory,
        projectDirectory: identity.root,
        worktree: checkout,
        binding,
        signal,
      }).catch(() => null);
      if (!checked) continue;
      const claimed = known.filter(
        item =>
          directoryKey(item.path) === directoryKey(checkout) &&
          item.branch === entry.branch,
      );
      if (claimed.length > 1) continue;
      rows.push({
        checkout,
        branch: entry.branch,
        base: entry.head,
        dirty: checked.dirty,
        providerId: claimed.length ? external!.id : null,
        providerRevision: claimed.length ? external!.fingerprint : null,
      });
    }
    return { action: 'attachments', rows, externalReason };
  }

  async adopt(
    choice: AttachWorktree,
    request: WorktreeRequest,
    signal: AbortSignal,
  ) {
    const identity = await this.identity(request.directory, signal);
    const input = [choice, request];
    const previous = this.previous(request.sessionId, input);
    if (previous?.result)
      return previous.result as {
        binding: SessionWorktreeBinding;
        projectDirectory: string;
      };
    const options = await this.attachments(request.directory, signal);
    const chosen = options.rows.find(
      row =>
        row.checkout === choice.checkout &&
        row.branch === choice.branch &&
        row.base === choice.base &&
        row.providerId === choice.providerId &&
        row.providerRevision === choice.providerRevision,
    );
    if (!chosen || options.externalReason)
      return fail(
        'This checkout changed or its provider ownership could not be verified. Review it again.',
      );
    const row = choice.providerId ? this.row(choice.providerId) : undefined;
    if (choice.providerId && !row)
      return fail('The removal provider is unavailable.');
    const provider = row ? toCandidate(row) : this.builtin(identity);
    if (
      choice.providerRevision &&
      provider.fingerprint !== choice.providerRevision
    )
      return fail('The removal provider changed. Review it again.');
    const roots = row
      ? (await this.verify(provider, signal)).roots
      : [dirname(choice.checkout)];
    const verified = await this.verifyCheckout(
      choice.checkout,
      choice.branch,
      identity,
      roots,
      signal,
      true,
    );
    if (verified.head !== choice.base)
      return fail('The checkout base changed. Review it again.');
    const binding: SessionWorktreeBinding = {
      version: 1,
      gitDirectory: identity.gitDirectory,
      repository: remoteOf(identity),
      checkout: verified.checkout,
      root: verified.root,
      ownership: 'adopted',
      providerId: provider.id,
      providerKind: provider.definition.kind,
      revision: provider.fingerprint,
      branch: choice.branch,
      base: choice.base,
    };
    const result = { binding, projectDirectory: identity.checkouts[0]! };
    const receipt = this.receipt(
      request.sessionId,
      provider,
      'adopt',
      request.sessionId,
      'succeeded',
    );
    if (this.previous(request.sessionId, input))
      return fail('This adoption is already in progress.');
    this.transaction(() => {
      this.insertReceipt(receipt, input);
      this.updateReceipt(receipt, result);
    });
    return result;
  }

  async assertBuiltinBinding(
    binding: SessionWorktreeBinding,
    directory: string,
    signal: AbortSignal,
  ) {
    const identity = await this.identity(directory, signal);
    if (this.builtin(identity).fingerprint !== binding.revision)
      fail('The repository identity changed after the checkout was adopted.');
  }
}
