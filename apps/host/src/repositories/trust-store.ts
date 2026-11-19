import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  repositoryTrustDecisionSchema,
  repositoryTrustRuleSchema,
  type Provider,
  type RepositoryIdentity,
  type RepositoryTrustDecision,
  type RepositoryTrustReviewInput,
  type RepositoryTrustRule,
  type RepositoryTrustSettingsInput,
} from '@nesvo/contracts';
import { directoryKey } from '../mcp/scoped-config';
import { SessionError } from '../sessions/session-error';
import { matchesRepositoryPattern } from './identity';

type Digests = ReadonlyArray<readonly [string, string]>;
type Review = {
  identity: RepositoryIdentity;
  sessionId: string | null;
  provider: Provider;
  fingerprint: string;
  definitions: Digests;
};

const repositoryScope = (directory: string) =>
  'repository:' + directoryKey(directory);
const patternScope = (pattern: string) => 'pattern:' + pattern;
const parseRule = (row: Record<string, unknown>) =>
  repositoryTrustRuleSchema.parse(JSON.parse(String(row.document)));

export class RepositoryTrustStore {
  constructor(private readonly database: DatabaseSync) {}

  private rule(scope: string) {
    const row = this.database
      .prepare(
        'SELECT document FROM repository_trust_rules WHERE scope_key = ?',
      )
      .get(scope);
    return row ? parseRule(row) : undefined;
  }

  private rules() {
    return this.database
      .prepare(
        'SELECT document FROM repository_trust_rules ORDER BY rowid DESC LIMIT 256',
      )
      .all()
      .map(parseRule);
  }

  private writeRule(scope: string, rule: RepositoryTrustRule) {
    if (!this.rule(scope) && this.rules().length >= 256)
      throw new SessionError(
        'invalid-request',
        'The computer has reached the repository trust history limit.',
      );
    this.database
      .prepare(
        'INSERT INTO repository_trust_rules (id, scope_key, document) VALUES (?, ?, ?) ON CONFLICT(scope_key) DO UPDATE SET document = excluded.document',
      )
      .run(rule.id, scope, JSON.stringify(rule));
    return rule;
  }

  private record(
    id: string,
    payload: unknown,
    execute: (
      now: string,
    ) => Omit<RepositoryTrustDecision, 'id' | 'at' | 'actor' | 'hostId'>,
    actor: RepositoryTrustDecision['actor'] = 'operator',
  ) {
    const key = JSON.stringify(payload);
    const earlier = this.database
      .prepare('SELECT payload FROM repository_trust_actions WHERE id = ?')
      .get(id);
    if (earlier) {
      if (earlier.payload !== key)
        throw new SessionError(
          'invalid-request',
          'This repository trust action ID is already in use.',
        );
      return;
    }
    const at = new Date().toISOString();
    const hostId = this.database
      .prepare("SELECT value FROM metadata WHERE key = 'instance_id'")
      .get()!.value;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const decision = repositoryTrustDecisionSchema.parse({
        ...execute(at),
        id,
        hostId,
        actor,
        at,
      });
      this.database
        .prepare('INSERT INTO repository_trust_actions VALUES (?, ?, ?)')
        .run(id, key, JSON.stringify(decision));
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private addPattern(pattern: string, now: string) {
    const scope = patternScope(pattern);
    const earlier = this.rule(scope);
    if (earlier && !earlier.revokedAt) return earlier;
    return this.writeRule(scope, {
      id: earlier?.id ?? randomUUID(),
      kind: 'pattern',
      pattern,
      createdAt: now,
      revokedAt: null,
    });
  }

  settings(input: RepositoryTrustSettingsInput) {
    if (input.action !== 'read')
      this.record(input.actionId, input, now => {
        const rule =
          input.action === 'add-pattern'
            ? this.addPattern(input.pattern, now)
            : this.rules().find(rule => rule.id === input.ruleId);
        if (!rule)
          throw new SessionError(
            'not-found',
            'The repository trust rule was not found.',
          );
        const target =
          rule.kind === 'pattern' ? rule.pattern : rule.gitDirectory;
        if (input.action === 'revoke' && !rule.revokedAt) {
          this.writeRule(
            rule.kind === 'pattern'
              ? patternScope(target)
              : repositoryScope(target),
            {
              ...rule,
              revokedAt: now,
            },
          );
          this.database
            .prepare('DELETE FROM repository_trust_approvals WHERE rule_id = ?')
            .run(rule.id);
        }
        return {
          action: input.action,
          target,
          ruleId: rule.id,
          provider: null,
          sessionId: null,
          fingerprint: null,
        };
      });
    return {
      rules: this.rules(),
      history: this.database
        .prepare(
          'SELECT document FROM repository_trust_actions ORDER BY rowid DESC LIMIT 100',
        )
        .all()
        .map(row =>
          repositoryTrustDecisionSchema.parse(JSON.parse(String(row.document))),
        ),
    };
  }

  private target(identity: RepositoryIdentity) {
    if (identity.status !== 'remote' && identity.status !== 'local')
      return null;
    return {
      gitDirectory: identity.gitDirectory,
      remote: identity.status === 'remote' ? identity.remote : null,
    };
  }

  private approvalKey(
    gitDirectory: string,
    remote: string | null,
    kind: RepositoryTrustRule['kind'],
  ) {
    return kind === 'pattern'
      ? remote!
      : JSON.stringify([directoryKey(gitDirectory), remote]);
  }

  decision(
    review: Review,
    input: RepositoryTrustReviewInput,
    actor: RepositoryTrustDecision['actor'] = 'operator',
  ) {
    const { identity, sessionId, provider, fingerprint } = review;
    const target = this.target(identity);
    this.record(
      input.actionId,
      [input, identity.root, sessionId, provider, fingerprint],
      now => {
        let ruleId: string | null = null;
        if (input.action === 'approve') {
          if (!target)
            throw new SessionError(
              'invalid-request',
              'Verify a single Git repository identity before approving a rule.',
            );
          const { gitDirectory, remote } = target;
          const scope = repositoryScope(gitDirectory);
          const earlier = this.rule(scope);
          let rule: RepositoryTrustRule;
          if (input.pattern) {
            if (!remote || !matchesRepositoryPattern(input.pattern, remote))
              throw new SessionError(
                'invalid-request',
                'The pattern must match the full canonical repository address.',
              );
            if (earlier)
              throw new SessionError(
                'invalid-request',
                'An exact repository decision takes precedence. Review this repository by its exact identity.',
              );
            rule = this.addPattern(input.pattern, now);
            const matching = this.matchingPatterns(remote);
            if (matching.length !== 1)
              throw new SessionError(
                'invalid-request',
                'Resolve the overlapping repository patterns before approving definitions.',
              );
          } else {
            if (earlier?.kind === 'repository' && earlier.remote !== remote)
              this.database
                .prepare(
                  'DELETE FROM repository_trust_approvals WHERE rule_id = ?',
                )
                .run(earlier.id);
            rule = this.writeRule(scope, {
              id: earlier?.id ?? randomUUID(),
              kind: 'repository',
              gitDirectory,
              remote,
              createdAt: earlier?.createdAt ?? now,
              revokedAt: null,
            });
          }
          ruleId = rule.id;
          this.database
            .prepare(
              'INSERT INTO repository_trust_approvals VALUES (?, ?, ?, ?) ON CONFLICT(rule_id, provider, repository_key) DO UPDATE SET definitions = excluded.definitions',
            )
            .run(
              ruleId,
              provider,
              this.approvalKey(gitDirectory, remote, rule.kind),
              JSON.stringify(review.definitions),
            );
        }
        return {
          action: actor === 'host' ? 'migrate' : input.action,
          target: target?.remote ?? target?.gitDirectory ?? identity.root,
          ruleId,
          sessionId,
          provider,
          fingerprint,
        };
      },
      actor,
    );
  }

  migrate(
    review: Review,
    checkout: string,
    previous: readonly { id: string; hash: string }[],
  ) {
    if (
      !this.target(review.identity) ||
      directoryKey(review.identity.root) !== checkout ||
      this.rules().length >= 256 ||
      this.resolve(review.identity, review.provider).state !== 'none' ||
      previous.length !== review.definitions.length ||
      previous.some(
        (entry, index) =>
          entry?.id !== review.definitions[index]?.[0] ||
          entry?.hash !== review.definitions[index]?.[1],
      )
    )
      return false;
    this.decision(
      review,
      { action: 'approve', actionId: randomUUID() },
      'host',
    );
    return true;
  }

  private matchingPatterns(remote: string) {
    return this.rules().filter(
      rule =>
        rule.kind === 'pattern' &&
        !rule.revokedAt &&
        matchesRepositoryPattern(rule.pattern, remote),
    );
  }

  resolve(identity: RepositoryIdentity, provider: Provider) {
    const target = this.target(identity);
    if (!target) return { state: 'unverified' as const };
    const { gitDirectory, remote } = target;
    const exact = this.rule(repositoryScope(gitDirectory));
    const patterns = !exact && remote ? this.matchingPatterns(remote) : [];
    if (patterns.length > 1) return { state: 'ambiguous' as const };
    const rule = exact ?? patterns[0];
    if (!rule) {
      const revoked =
        remote &&
        this.rules().some(
          entry =>
            entry.kind === 'pattern' &&
            entry.revokedAt &&
            matchesRepositoryPattern(entry.pattern, remote),
        );
      return { state: revoked ? ('withheld' as const) : ('none' as const) };
    }
    if (
      rule.revokedAt ||
      (rule.kind === 'repository' && rule.remote !== remote)
    )
      return { state: 'withheld' as const };
    const row = this.database
      .prepare(
        'SELECT definitions FROM repository_trust_approvals WHERE rule_id = ? AND provider = ? AND repository_key = ?',
      )
      .get(
        rule.id,
        provider,
        this.approvalKey(gitDirectory, remote, rule.kind),
      );
    return {
      state: 'eligible' as const,
      rule,
      definitions: new Map<string, string>(
        row ? (JSON.parse(String(row.definitions)) as Digests) : [],
      ),
    };
  }
}
