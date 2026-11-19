import {
  actOnPullRequestSchema,
  decideInboxItemSchema,
  externalInboxLimits,
  inboxRuleLimits,
  isGatingTrigger,
  matchesCommandPattern,
  matchesNameFilter,
  matchesPathGlob,
  matchesToolPattern,
  routesToParent,
  ruleCommandPatterns,
  type ActOnPullRequestInput,
  type Approval,
  type DecisionRoute,
  type DesktopEvent,
  type ExternalInboxItem,
  type ExternalInboxPost,
  type InboxItem,
  type InboxItemDiff,
  type InboxRule,
  type InboxRuleCatalog,
  type InboxRuleEntry,
  type InboxRuleIssue,
  type InboxRuleScope,
  type InboxRuleSessionKind,
  type InboxRuleTrigger,
  type InboxSettings,
  type RuleInboxItem,
  type PullRequestActionResult,
  type PullRequestReference,
  type RespondApprovalInput,
  type SaveInboxRuleInput,
  type Session,
  type SessionChanges,
  type SessionGroup,
  type SessionMode,
  type SessionStageRecord,
  type StageActor,
  type StageReport,
  type WorkflowRun,
  type ConfigurationValue,
} from '@nesvo/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, dirname, isAbsolute } from 'node:path';
import type { z } from 'zod';
import type {
  StepExecution,
  StepExecutor,
  StepOutcome,
} from '../workflows/runner';
import { hostResult } from '../workflows/steps/host-result';
import {
  absentConfigurationVersion,
  configurationHash,
  ConfigurationRefusal,
  type ConfigurationWriter,
} from '../workflows/configuration-changes';
import { claudeAskRule, enforcementFor, ruleEnforcement } from './enforcement';
import {
  InboxRuleFileError,
  deleteRuleFile,
  globalRulesRoot,
  parseRuleText,
  projectRulesRoot,
  readRuleRoot,
  withEnabled,
  withConfigRuleFile,
  writeRuleFile,
  type RuleFile,
} from './files';
import type { InboxBinding, InboxItemStore } from './store';
import {
  commandOf,
  type PreparedTurnRules,
  type ProviderToolSubject,
} from './turn-gate';

const DEFAULT_ROUTE_KEY = 'default-route';
const CI_SWEEP_MS = 60_000;
const CI_SESSIONS_PER_SWEEP = 20;
const WORKFLOW_HOLD_POLL_MS = 500;

type ApplicableRule = { rule: InboxRule; scope: InboxRuleScope };

type CiStatus = {
  headSha: string;
  status: 'red' | 'green' | 'pending';
  failing: string[];
};

export type InboxRulesPorts = {
  store: InboxItemStore;
  sessions: {
    snapshot: (sessionId: string) => Session | undefined;
    list: () => Session[];
    respondApproval: (input: RespondApprovalInput) => Session;
    appendDecisionRecord: (
      sessionId: string,
      record: SessionStageRecord,
    ) => void;
    queueOwnerMessage: (sessionId: string, text: string) => void;
    releaseInboxHold: (sessionId: string) => void;
    holdQueue: (sessionId: string) => void;
  };
  repositoryStatus: (
    provider: Session['provider'],
    directory: string,
    signal: AbortSignal,
  ) => Promise<string>;
  projectRoot: (directory: string, signal: AbortSignal) => Promise<string>;
  changes: (sessionId: string, signal: AbortSignal) => Promise<SessionChanges>;
  group: (groupId: string) => SessionGroup | undefined;
  workflowRun: (runId: string) => WorkflowRun | undefined;
  actOnPullRequest: (
    input: z.output<typeof actOnPullRequestSchema>,
  ) => Promise<PullRequestActionResult>;
  ciStatus: (session: Session, signal: AbortSignal) => Promise<CiStatus | null>;
  coordinator: (
    child: Session,
    type: 'decision-needed' | 'decision-made',
    summary: string,
    detail: string | null,
  ) => void;
  emit: (event: DesktopEvent) => void;
  signal: AbortSignal;
};

export class InboxRuleError extends Error {
  constructor(
    readonly code: 'invalid-request' | 'busy' | 'not-found' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'InboxRuleError';
  }
}

const unique = <T>(values: T[]) => [...new Set(values)];

const sessionKinds = (session: Session): InboxRuleSessionKind[] => {
  const kinds: InboxRuleSessionKind[] = [];
  if (session.parentId) kinds.push('child');
  if (session.workflowRunId) kinds.push('workflow');
  if (session.scheduledJobId) kinds.push('automation');
  return kinds.length ? kinds : ['manual'];
};

const pullRequestUrl = (reference: PullRequestReference | null) =>
  reference
    ? `https://github.com/${reference.repository}/pull/${reference.number}`
    : '';

const surfaceAction = (
  input: ActOnPullRequestInput,
): 'merge' | 'comment' | 'review' | null => {
  const action = input.action.action;
  if (action === 'merge') return 'merge';
  if (
    action === 'comment' ||
    action === 'reply-thread' ||
    action === 'line-comment'
  )
    return 'comment';
  if (action === 'review' || action === 'submit-review') return 'review';
  return null;
};

const render = (template: string, values: Record<string, string>) =>
  template
    .replace(/\{\{\s*([a-z.]+)\s*\}\}/gi, (_, key: string) =>
      (values[key] ?? '').slice(0, 2000),
    )
    .slice(0, inboxRuleLimits.template);

const ownerActor = (via: InboxItem['decidedVia']): StageActor => ({
  kind: 'owner',
  via: via === 'parent' ? 'parent' : via === 'mobile' ? 'mobile' : 'desktop',
  sessionId: null,
});

export class InboxRules {
  private readonly turns = new Map<
    string,
    { runId: string | null; rules: ApplicableRule[] }
  >();
  private readonly ciSeen = new Map<string, string>();
  private readonly skippedProject = new Map<string, number>();
  private ciTimer: ReturnType<typeof setInterval> | null = null;
  private ciSweeping = false;

  constructor(private readonly ports: InboxRulesPorts) {}

  start(): void {
    const at = new Date().toISOString();
    for (const { item, binding } of this.ports.store.pending())
      if (binding.kind === 'provider' && item.binding !== 'external')
        this.settle(item, 'pending', {
          status: 'interrupted',
          outcome:
            'The host restarted before a decision. Nothing was approved and the held action did not run. Send a new message to continue.',
          decidedAt: at,
          decidedVia: null,
        });
    this.ciTimer = setInterval(() => void this.sweepCi(), CI_SWEEP_MS);
    this.ciTimer.unref?.();
  }

  close(): void {
    if (this.ciTimer) clearInterval(this.ciTimer);
    this.ciTimer = null;
  }

  settings(): InboxSettings {
    const stored = this.ports.store.setting(DEFAULT_ROUTE_KEY);
    return {
      defaultRoute:
        stored === 'parent' || stored === 'both' ? stored : 'inbox',
    };
  }

  saveSettings(settings: InboxSettings): InboxSettings {
    this.ports.store.saveSetting(DEFAULT_ROUTE_KEY, settings.defaultRoute);
    return this.settings();
  }

  configurationSettings(): ConfigurationWriter {
    return {
      kind: 'database',
      open: target => {
        if (target.area !== 'settings' || target.key !== 'inbox-routing')
          throw new ConfigurationRefusal(
            'unsupported',
            'This setting is unavailable on this computer.',
          );
        const read = () => ({
          value: {
            kind: 'route' as const,
            value: this.settings().defaultRoute,
          },
          version: {
            type: 'revision' as const,
            revision: this.ports.store.settingRevision(DEFAULT_ROUTE_KEY),
          },
          identity: DEFAULT_ROUTE_KEY,
          dependencies: '',
        });
        return {
          read,
          prepare: (mutation, before) => {
            if (
              before.version.type !== 'revision' ||
              mutation.draft?.kind !== 'route'
            )
              throw new ConfigurationRefusal(
                'invalid-request',
                'Select an Inbox route.',
              );
            return {
              classification: 'review',
              after: {
                ...before,
                value: mutation.draft,
                version: {
                  type: 'revision',
                  revision: before.version.revision + 1,
                },
              },
            };
          },
          write: ({ to }) => {
            if (to.value?.kind !== 'route')
              throw new ConfigurationRefusal(
                'invalid-request',
                'Select an Inbox route.',
              );
            this.saveSettings({ defaultRoute: to.value.value });
          },
        };
      },
    };
  }

  configurationRules(): ConfigurationWriter {
    const signal = this.ports.signal;
    return {
      kind: 'file',
      locked: async (target, use, recovery) => {
        if (target.area !== 'inbox-rules')
          throw new ConfigurationRefusal(
            'unsupported',
            'Choose an Inbox rule.',
          );
        const project =
          target.scope.kind === 'project' ? target.scope.root : null;
        if (project && !isAbsolute(project))
          throw new ConfigurationRefusal(
            'invalid-request',
            'Choose an absolute project root.',
          );
        const globalAnchor =
          process.env.NESVO_TEST_MODE === '1' &&
          process.env.NESVO_WORKFLOWS_HOME
            ? dirname(globalRulesRoot())
            : homedir();
        const anchor = await realpath(project ?? globalAnchor).catch(() => {
          throw new ConfigurationRefusal(
            'conflict',
            'The Inbox rule root is unavailable.',
          );
        });
        if (
          project &&
          (anchor !== project ||
            (await this.ports.projectRoot(anchor, signal)) !== anchor)
        )
          throw new ConfigurationRefusal(
            'conflict',
            'Choose the verified project root.',
          );
        const root = project ? projectRulesRoot(anchor) : globalRulesRoot();
        const access = async () => {
          if (
            !recovery &&
            project &&
            !(await this.projectTrusted(anchor, null, signal))
          )
            throw new ConfigurationRefusal(
              'unauthorized',
              'Trust this project before changing Inbox rules.',
            );
        };
        return withConfigRuleFile(
          anchor,
          root,
          target.name,
          signal,
          access,
          (file, identity, write) => {
            const current = file?.text ?? null;
            const value: ConfigurationValue | null =
              current === null ? null : { kind: 'markdown', document: current };
            const read = () => ({
              value,
              identity,
              dependencies: '',
              version: file
                ? { type: 'hash' as const, hash: file.contentHash }
                : absentConfigurationVersion,
            });
            return use({
              read,
              prepare: (mutation, before) => {
                const draft =
                  mutation.draft?.kind === 'markdown'
                    ? mutation.draft.document
                    : null;
                const old = current
                  ? parseRuleText(current, '', target.name).rule
                  : null;
                const next = draft
                  ? parseRuleText(draft, '', target.name)
                  : null;
                if (next && !next.rule)
                  throw new ConfigurationRefusal(
                    'invalid-request',
                    'The Inbox rule is invalid.',
                    next.issues.slice(0, 20).map(issue => ({
                      field: issue.line ? `line ${issue.line}` : 'document',
                      message: 'Check this part of the Inbox rule definition.',
                    })),
                  );
                if (
                  old?.enabled &&
                  old.action === 'hold' &&
                  old.trigger === 'workflow-step'
                ) {
                  const guard = (rule: InboxRule | null) =>
                    rule &&
                    JSON.stringify([
                      rule.enabled,
                      rule.action,
                      rule.trigger,
                      rule.workflow,
                      rule.step,
                      rule.phase,
                      rule.group,
                      rule.computer,
                      rule.repository,
                    ]);
                  if (guard(old) !== guard(next?.rule ?? null))
                    throw new ConfigurationRefusal(
                      'review-required',
                      'Review workflow guards in the Inbox rule editor before changing this hold.',
                    );
                }
                return {
                  classification:
                    old?.enabled && old.action === 'hold'
                      ? 'authority'
                      : 'review',
                  after: {
                    ...before,
                    value: mutation.draft,
                    version:
                      draft === null
                        ? absentConfigurationVersion
                        : { type: 'hash', hash: configurationHash(draft) },
                  },
                };
              },
              write: ({ to }) =>
                write(to.value?.kind === 'markdown' ? to.value.document : null),
            });
          },
        );
      },
    };
  }

  items(): InboxItem[] {
    return this.ports.store.list().map(entry => entry.item);
  }

  externalItem(deviceId: string, itemId: string): ExternalInboxItem | null {
    const stored = this.ports.store.get(itemId);
    if (
      stored?.binding.kind !== 'external' ||
      stored.binding.deviceId !== deviceId ||
      stored.item.binding !== 'external'
    )
      return null;
    return stored.item;
  }

  cancelExternal(item: ExternalInboxItem): ExternalInboxItem {
    if (item.status !== 'pending') return item;
    return this.settle(item, 'pending', {
      status: 'cancelled',
      outcome: 'Withdrawn by the sender.',
      decidedAt: new Date().toISOString(),
    }) ?? item;
  }

  async postExternal(
    deviceId: string,
    deviceName: string,
    input: ExternalInboxPost,
    active: () => boolean,
  ) {
    const digest = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    const dedupe = `external:${deviceId}:${digest(input.idempotencyKey)}`;
    const payloadHash = digest(JSON.stringify(input));
    const existing = () => {
      const stored = this.ports.store.findByDedupe(dedupe);
      if (!stored) return null;
      if (
        stored.binding.kind !== 'external' ||
        stored.item.binding !== 'external' ||
        stored.binding.payloadHash !== payloadHash
      )
        return 'conflict' as const;
      return stored.item;
    };
    const before = existing();
    if (before) return before;
    const initialSession = input.sessionId
      ? this.ports.sessions.snapshot(input.sessionId)
      : undefined;
    if (input.sessionId && !initialSession) return 'not-found' as const;
    const source = input.source ?? deviceName;
    const rules = initialSession
      ? await this.rulesFor(initialSession, this.ports.signal)
      : [];
    const entry = rules.find(
      ({ rule }) =>
        rule.trigger === 'external' &&
        (!rule.pattern || matchesNameFilter(rule.pattern, source)),
    );
    if (!active()) return 'unauthorized' as const;
    const after = existing();
    if (after) return after;
    const session = initialSession
      ? this.ports.sessions.snapshot(initialSession.id)
      : undefined;
    if (initialSession && !session) return 'not-found' as const;
    const now = Date.now();
    const counts = this.ports.store.externalCounts(
      deviceId,
      new Date(now - 60_000).toISOString(),
    );
    if (counts.recent >= externalInboxLimits.perMinute)
      return 'rate-limit' as const;
    if (
      counts.pending >= externalInboxLimits.pending ||
      counts.hostPending >= externalInboxLimits.hostPending
    )
      return 'pending-limit' as const;
    const item: ExternalInboxItem = {
      id: randomUUID(),
      rule: entry
        ? {
            name: entry.rule.name,
            scope: entry.scope,
            description: entry.rule.description,
          }
        : null,
      action: 'ask',
      trigger: 'external',
      subject: input.title,
      binding: 'external',
      source,
      deviceName,
      sessionId: session?.id ?? null,
      sessionTitle: session?.title.slice(0, 200) ?? '',
      parentId: session?.parentId ?? null,
      route: this.routeFor(entry?.rule ?? null, session ?? null),
      status: 'pending',
      options: input.actions,
      presentation: {
        text: input.body,
        show: [],
        command: null,
        diff: null,
        pullRequest: null,
        plan: null,
        report: null,
      },
      note: null,
      answer: null,
      outcome: null,
      decidedVia: null,
      createdAt: new Date(now).toISOString(),
      decidedAt: null,
    };
    if (
      !this.ports.store.insert(
        { item, binding: { kind: 'external', deviceId, payloadHash } },
        dedupe,
      )
    )
      return 'conflict' as const;
    this.ports.emit({ type: 'inbox-item-changed', item });
    return item;
  }

  async catalog(
    directory: string | undefined,
    signal: AbortSignal,
  ): Promise<InboxRuleCatalog> {
    const issues: InboxRuleIssue[] = [];
    const globalRoot = globalRulesRoot();
    const global = await readRuleRoot(globalRoot, 'global', signal, issues);
    let projectRoot: string | null = null;
    let project: RuleFile[] = [];
    let trust: InboxRuleCatalog['projectTrust'] = 'none';
    if (directory) {
      const root = await this.ports.projectRoot(directory, signal);
      projectRoot = projectRulesRoot(root);
      project = await readRuleRoot(projectRoot, 'project', signal, issues);
      if (project.length)
        trust = (await this.projectTrusted(directory, null, signal))
          ? 'trusted'
          : 'untrusted';
    }
    const entry = (file: RuleFile): InboxRuleEntry => {
      const inactiveReason = !file.rule
        ? 'The rule has errors.'
        : !file.rule.enabled
          ? 'Disabled.'
          : file.scope === 'project' && trust !== 'trusted'
            ? 'Waiting for repository trust. Project rules apply after you trust this repository.'
            : null;
      return {
        scope: file.scope,
        path: file.path,
        contentHash: file.contentHash,
        text: file.text,
        name: file.name.slice(0, 200),
        rule: file.rule,
        active: inactiveReason === null,
        inactiveReason,
        issues: file.issues.slice(0, inboxRuleLimits.issues),
        enforcement: file.rule ? ruleEnforcement(file.rule) : [],
      };
    };
    return {
      roots: { global: globalRoot, project: projectRoot },
      projectTrust: trust,
      rules: [...global, ...project].map(entry),
      issues: issues.slice(0, inboxRuleLimits.issues),
      defaultRoute: this.settings().defaultRoute,
    };
  }

  validate(text: string) {
    const parsed = parseRuleText(text, 'rule.md');
    return { rule: parsed.rule, issues: parsed.issues };
  }

  private async rootFor(
    scope: InboxRuleScope,
    directory: string | undefined,
    signal: AbortSignal,
  ) {
    if (scope === 'global') return globalRulesRoot();
    if (!directory)
      throw new InboxRuleError(
        'invalid-request',
        'Choose a project folder for a project rule.',
      );
    return projectRulesRoot(await this.ports.projectRoot(directory, signal));
  }

  async save(input: SaveInboxRuleInput, signal: AbortSignal) {
    const root = await this.rootFor(input.scope, input.directory, signal);
    await writeRuleFile(
      root,
      input.text,
      input.expectedHash,
      input.previousName,
      signal,
    );
    return this.catalog(input.directory, signal);
  }

  async remove(
    input: { scope: InboxRuleScope; directory?: string; name: string; expectedHash: string },
    signal: AbortSignal,
  ) {
    const root = await this.rootFor(input.scope, input.directory, signal);
    await deleteRuleFile(root, input.name, input.expectedHash, signal);
    return this.catalog(input.directory, signal);
  }

  async setEnabled(
    input: {
      scope: InboxRuleScope;
      directory?: string;
      name: string;
      expectedHash: string;
      enabled: boolean;
    },
    signal: AbortSignal,
  ) {
    const catalog = await this.catalog(input.directory, signal);
    const current = catalog.rules.find(
      rule => rule.scope === input.scope && rule.name === input.name,
    );
    if (!current)
      throw new InboxRuleError('not-found', 'The rule no longer exists.');
    if (current.contentHash !== input.expectedHash)
      throw new InboxRuleError(
        'busy',
        'The rule file changed on disk. Reload the rules and try again.',
      );
    return this.save(
      {
        scope: input.scope,
        directory: input.directory,
        text: withEnabled(current.text, input.enabled),
        expectedHash: input.expectedHash,
      },
      signal,
    );
  }

  private async projectTrusted(
    directory: string,
    provider: Session['provider'] | null,
    signal: AbortSignal,
  ) {
    const providers: Session['provider'][] = provider
      ? [provider]
      : ['Claude Code', 'Codex'];
    for (const candidate of providers) {
      const status = await this.ports
        .repositoryStatus(candidate, directory, signal)
        .catch(() => 'unavailable');
      if (status === 'trusted') return true;
    }
    return false;
  }

  private loadRules(session: Session, signal: AbortSignal) {
    const key = `${session.provider}\u0000${session.directory}`;
    const rules = (async (): Promise<ApplicableRule[]> => {
      const issues: InboxRuleIssue[] = [];
      const global = await readRuleRoot(
        globalRulesRoot(),
        'global',
        signal,
        issues,
      );
      let project: RuleFile[] = [];
      try {
        const root = await this.ports.projectRoot(session.directory, signal);
        project = await readRuleRoot(
          projectRulesRoot(root),
          'project',
          signal,
          issues,
        );
        if (
          project.length &&
          !(await this.projectTrusted(
            session.directory,
            session.provider,
            signal,
          ))
        ) {
          this.skippedProject.set(key, project.length);
          project = [];
        } else this.skippedProject.delete(key);
      } catch {
        this.skippedProject.set(key, -1);
        project = [];
      }
      return [...global, ...project].flatMap(file =>
        file.rule?.enabled ? [{ rule: file.rule, scope: file.scope }] : [],
      );
    })();
    return rules;
  }

  private async rulesFor(session: Session, signal: AbortSignal) {
    const rules = await this.loadRules(session, signal).catch(
      () => [] as ApplicableRule[],
    );
    const projectRoot = await this.ports
      .projectRoot(session.directory, signal)
      .catch(() => session.directory);
    return rules.filter(entry => this.applies(entry.rule, session, projectRoot));
  }

  private workflowName(session: Session): string | null {
    const run = session.workflowRunId
      ? this.ports.workflowRun(session.workflowRunId)
      : undefined;
    return run?.workflow.name ?? session.workflow?.name ?? null;
  }

  private applies(rule: InboxRule, session: Session, projectRoot: string) {
    if (rule.providers && !rule.providers.includes(session.provider))
      return false;
    if (rule.modes && !rule.modes.includes(session.mode)) return false;
    if (rule.kinds && !sessionKinds(session).some(kind => rule.kinds!.includes(kind)))
      return false;
    if (
      rule.repository &&
      !matchesNameFilter(rule.repository, basename(projectRoot)) &&
      !matchesNameFilter(rule.repository, projectRoot.replace(/\\/g, '/'))
    )
      return false;
    if (rule.workflow) {
      const name = this.workflowName(session);
      if (!name || !matchesNameFilter(rule.workflow, name)) return false;
    }
    if (rule.group) {
      const group = session.groupId
        ? this.ports.group(session.groupId)
        : undefined;
      if (
        !group ||
        (!matchesNameFilter(rule.group, group.name) &&
          !matchesNameFilter(rule.group, group.id))
      )
        return false;
    }
    if (rule.computer && !matchesNameFilter(rule.computer, hostname()))
      return false;
    return true;
  }

  private routeFor(rule: InboxRule | null, session: Session | null): DecisionRoute {
    const group = session?.groupId
      ? this.ports.group(session.groupId)
      : undefined;
    const route =
      rule?.route ??
      session?.decisionRouteOverride ??
      session?.decisionRoute ??
      group?.defaults.decisionRoute ??
      this.settings().defaultRoute;
    return session?.parentId ? route : 'inbox';
  }

  async prepareTurn(
    session: Session,
    turn: { mode: SessionMode },
    signal: AbortSignal,
  ): Promise<PreparedTurnRules> {
    const rules = await this.rulesFor(session, signal);
    this.turns.set(session.id, { runId: session.runId, rules });
    const holds = rules.filter(
      ({ rule }) =>
        rule.action === 'hold' &&
        (rule.trigger === 'command' ||
          rule.trigger === 'pull-request' ||
          rule.trigger === 'mcp-tool'),
    );
    const refusals: string[] = [];
    const warnings: string[] = [];
    const skipped = this.skippedProject.get(
      `${session.provider}\u0000${session.directory}`,
    );
    if (skipped)
      warnings.push(
        skipped < 0
          ? 'Project Inbox rules could not be read, so only global rules apply to this turn.'
          : `${skipped} project Inbox ${skipped === 1 ? 'rule is' : 'rules are'} not applied: this repository is not trusted, or its rules changed since you trusted it. Review the repository to apply them.`,
      );
    const askRules: string[] = [];
    const needPrompts: InboxRule[] = [];
    for (const { rule } of holds) {
      const enforcement = enforcementFor(
        rule.trigger,
        session.provider,
        turn.mode,
      );
      if (enforcement.status === 'unreachable') continue;
      if (enforcement.status === 'unsupported') {
        const message = `The Inbox rule "${rule.name}" cannot hold this ${rule.trigger === 'mcp-tool' ? 'MCP tool call' : 'command'} here: ${enforcement.detail}`;
        (rule.on_unsupported === 'refuse' ? refusals : warnings).push(message);
        continue;
      }
      if (session.provider !== 'Claude Code') continue;
      needPrompts.push(rule);
      if (turn.mode === 'read-only') continue;
      if (rule.trigger === 'mcp-tool' && rule.pattern)
        askRules.push(rule.pattern);
      else askRules.push(...ruleCommandPatterns(rule).map(claudeAskRule));
    }
    const promptMessage = (rule: InboxRule) =>
      `The Inbox rule "${rule.name}" needs the Claude Code host permission prompt, which this CLI or turn does not offer.`;
    const refusing = needPrompts.find(rule => rule.on_unsupported === 'refuse');
    const warning = needPrompts.find(rule => rule.on_unsupported === 'warn');
    const route = (trigger: InboxRuleTrigger) => {
      const match = rules.find(({ rule }) => rule.trigger === trigger && rule.action === 'route');
      return match ? this.routeFor(match.rule, session) : undefined;
    };
    return {
      decisionRoute: route('decision-needed'),
      questionRoute: route('question-for-you'),
      resultRoute: route('result-to-review'),
      refusal: refusals.length
        ? `${refusals.join(' ')} No provider turn was started.`
        : null,
      warnings,
      gate: {
        askRules: unique(askRules),
        holds: subject => !!this.matchSubject(holds, subject),
        withoutHostPrompts: {
          refusal: refusing
            ? `${promptMessage(refusing)} No provider turn was started.`
            : null,
          warning: warning ? promptMessage(warning) : null,
        },
      },
    };
  }

  private matchSubject(
    rules: readonly ApplicableRule[],
    subject: ProviderToolSubject,
  ): ApplicableRule | null {
    const command = commandOf(subject);
    return (
      rules.find(({ rule }) => {
        if (rule.trigger === 'mcp-tool')
          return (
            subject.tool.startsWith('mcp__') &&
            !!rule.pattern &&
            matchesToolPattern(rule.pattern, subject.tool)
          );
        if (rule.trigger !== 'command' && rule.trigger !== 'pull-request')
          return false;
        return (
          command !== null &&
          ruleCommandPatterns(rule).some(pattern =>
            matchesCommandPattern(pattern, command),
          )
        );
      }) ?? null
    );
  }

  approvalRequested(
    session: Session,
    approval: Approval,
    subject: ProviderToolSubject | null,
  ): string | null {
    const turn = this.turns.get(session.id);
    if (!subject || !turn || turn.runId !== session.runId || !session.runId)
      return null;
    const gating = turn.rules.filter(({ rule }) => isGatingTrigger(rule.trigger));
    const hold = this.matchSubject(
      gating.filter(({ rule }) => rule.action === 'hold'),
      subject,
    );
    const command = commandOf(subject);
    for (const entry of gating.filter(({ rule }) => rule.action === 'notify'))
      if (this.matchSubject([entry], subject))
        this.create(entry, session, {
          trigger: entry.rule.trigger,
          subject: command ?? subject.tool,
          binding: { kind: 'session', runId: session.runId },
          dedupe: `notify:${session.runId}:${approval.id}:${entry.scope}:${entry.rule.name}`,
          values: { command: command ?? subject.tool },
          command: command ?? approval.detail.slice(0, 8000),
        });
    if (!hold) return null;
    const item = this.create(hold, session, {
      trigger: hold.rule.trigger,
      subject: command ?? subject.tool,
      binding: {
        kind: 'provider',
        runId: session.runId,
        approvalId: approval.id,
        fingerprint: approval.fingerprint ?? null,
      },
      dedupe: `provider:${session.runId}:${approval.id}`,
      values: { command: command ?? subject.tool },
      command: command ?? approval.detail.slice(0, 8000),
    });
    return item ? this.waitingText(item, session) : null;
  }

  private waitingText(item: RuleInboxItem, session: Session) {
    const parent = session.parentId
      ? this.ports.sessions.snapshot(session.parentId)
      : undefined;
    const where =
      item.route === 'parent' && parent
        ? `in ${parent.title}`
        : item.route === 'both' && parent
          ? `in the Inbox and in ${parent.title}`
          : 'in the Inbox';
    return `Waiting for the owner's decision ${where} (Inbox rule ${item.rule.name})…`;
  }

  holdsAfterRun(session: Session): boolean {
    const turn = this.turns.get(session.id);
    if (!turn || !session.runId || turn.runId !== session.runId) return false;
    const runId = session.runId;
    let held = false;
    const fire = (
      entry: ApplicableRule,
      trigger: InboxRuleTrigger,
      subject: string,
      extra: Partial<CreateInput> = {},
    ) => {
      const item = this.create(entry, session, {
        trigger,
        subject,
        binding: { kind: 'session', runId },
        dedupe: `${trigger}:${runId}:${entry.scope}:${entry.rule.name}`,
        ...extra,
      });
      if (item && entry.rule.action === 'hold') held = true;
    };
    const planReady =
      session.plan?.status === 'plan-ready' && session.plan.runId === runId;
    const finished = session.status === 'completed' || session.status === 'failed';
    const usage = session.messages.findLast(
      message => message.runId === runId && message.author === 'agent',
    )?.usage;
    const cost = usage?.source === 'provider-report' ? usage.costUsd : null;
    for (const entry of turn.rules) {
      const { rule } = entry;
      if (rule.trigger === 'plan-ready' && planReady)
        fire(entry, 'plan-ready', 'Plan ready', {
          plan: session.plan?.text ?? null,
        });
      if (rule.trigger === 'session-finished' && finished)
        fire(entry, 'session-finished', `Session ${session.status}`);
      if (
        rule.trigger === 'run-cost' &&
        cost !== null &&
        rule.above_usd !== undefined &&
        cost > rule.above_usd
      )
        fire(entry, 'run-cost', `Run cost $${cost.toFixed(2)}`, {
          values: { cost: cost.toFixed(2) },
        });
    }
    const fileRules = turn.rules.filter(
      ({ rule }) => rule.trigger === 'files-changed',
    );
    if (fileRules.length && finished)
      void this.filesChanged(session, runId, fileRules);
    return held;
  }

  private async filesChanged(
    session: Session,
    runId: string,
    rules: ApplicableRule[],
  ) {
    let changes: SessionChanges;
    try {
      changes = await this.ports.changes(session.id, this.ports.signal);
    } catch {
      return;
    }
    const paths = unique([
      ...changes.uncommitted.files.map(file => file.path),
      ...changes.branch.files.map(file => file.path),
    ]);
    for (const entry of rules) {
      const matched = paths.filter(path =>
        matchesPathGlob(entry.rule.glob ?? '', path),
      );
      if (!matched.length) continue;
      const item = this.create(entry, session, {
        trigger: 'files-changed',
        subject: `${matched.length} matching ${matched.length === 1 ? 'file' : 'files'} changed`,
        binding: { kind: 'session', runId },
        dedupe: `files-changed:${runId}:${entry.scope}:${entry.rule.name}`,
        values: { files: matched.slice(0, 20).join(', ') },
      });
      if (item && entry.rule.action === 'hold')
        this.ports.sessions.holdQueue(session.id);
    }
  }

  stageRecorded(session: Session, records: readonly SessionStageRecord[]) {
    const turn = this.turns.get(session.id);
    if (!turn) return;
    for (const record of records) {
      if (record.kind !== 'report' && !(record.kind === 'question' && record.status === 'pending'))
        continue;
      const trigger: InboxRuleTrigger =
        record.kind === 'report' ? 'stage-report' : 'stage-question';
      for (const entry of turn.rules) {
        if (entry.rule.trigger !== trigger) continue;
        const report: StageReport | null =
          record.kind === 'report' ? record.report : null;
        const item = this.create(entry, session, {
          trigger,
          subject:
            record.kind === 'report'
              ? `Report: ${record.report.status}`
              : `Question: ${record.question.question.slice(0, 200)}`,
          binding: { kind: 'session', runId: session.runId },
          dedupe: `${trigger}:${record.id}:${entry.scope}:${entry.rule.name}`,
          report,
          values: {
            report: report?.summary ?? '',
            question: record.kind === 'question' ? record.question.question : '',
          },
        });
        if (item && entry.rule.action === 'hold')
          this.ports.sessions.holdQueue(session.id);
      }
    }
  }

  heldReason(sessionId: string): string | null {
    const pending = this.ports.store
      .pending()
      .find(
        ({ item, binding }) =>
          item.sessionId === sessionId &&
          item.action === 'hold' &&
          binding.kind === 'session',
      );
    return pending && pending.item.binding !== 'external'
      ? `This session waits for the owner's decision on the Inbox rule "${pending.item.rule.name}". Decide it in the Inbox first.`
      : null;
  }

  async beforePullRequestAction(
    input: ActOnPullRequestInput,
    signal: AbortSignal,
  ): Promise<RuleInboxItem | null> {
    const action = surfaceAction(input);
    if (!action) return null;
    const session =
      this.ports.sessions
        .list()
        .find(
          candidate =>
            candidate.pullRequest?.number === input.reference.number &&
            candidate.pullRequest.repository.toLowerCase() ===
              input.reference.repository.toLowerCase(),
        ) ?? null;
    const rules = session
      ? await this.rulesFor(session, signal)
      : await this.globalRules(signal);
    const matching = rules.filter(
      ({ rule }) =>
        rule.trigger === 'pull-request' && rule.actions?.includes(action),
    );
    const url = pullRequestUrl(input.reference);
    for (const entry of matching.filter(({ rule }) => rule.action === 'notify'))
      this.create(entry, session, {
        trigger: 'pull-request',
        subject: `${action} ${url}`,
        binding: { kind: 'session', runId: null },
        dedupe: `pull-request:${input.actionId}:${entry.scope}:${entry.rule.name}`,
        pullRequest: input.reference,
        values: { pr: url, action },
        command: `${action} ${url}`,
      });
    const hold = matching.find(({ rule }) => rule.action === 'hold');
    if (!hold) return null;
    const dedupe = `pull-request-hold:${input.actionId}`;
    const existing = this.ports.store.findByDedupe(dedupe);
    if (existing?.item.binding === 'pull-request') return existing.item;
    return this.create(hold, session, {
      trigger: 'pull-request',
      subject: `${action} ${url}`,
      binding: { kind: 'pull-request', input },
      dedupe,
      pullRequest: input.reference,
      values: { pr: url, action },
      command: `${action} ${url}`,
    });
  }

  private async globalRules(signal: AbortSignal): Promise<ApplicableRule[]> {
    const issues: InboxRuleIssue[] = [];
    return (
      await readRuleRoot(globalRulesRoot(), 'global', signal, issues)
    ).flatMap(file =>
      file.rule?.enabled &&
      !file.rule.repository &&
      !file.rule.workflow &&
      !file.rule.group
        ? [{ rule: file.rule, scope: file.scope }]
        : [],
    );
  }

  wrapStepExecutor(executor: StepExecutor): StepExecutor {
    return async execution => {
      const outcome = await this.beforeWorkflowStep(execution);
      return outcome ?? executor(execution);
    };
  }

  private async beforeWorkflowStep(
    execution: StepExecution,
  ): Promise<StepOutcome | null> {
    const { run, step, signal } = execution;
    const session = run.sessionId
      ? this.ports.sessions.snapshot(run.sessionId)
      : undefined;
    if (!session) return null;
    const rules = (await this.rulesFor(session, signal)).filter(
      ({ rule }) =>
        rule.trigger === 'workflow-step' &&
        (!rule.step || matchesNameFilter(rule.step, step.name)) &&
        (!rule.phase || rule.phase === step.phase),
    );
    if (!rules.length) return null;
    const subject = `${run.workflow.name} › ${step.name} (${step.phase})`;
    const values = { step: step.name, phase: step.phase, workflow: run.workflow.name };
    for (const entry of rules.filter(({ rule }) => rule.action === 'notify'))
      this.create(entry, session, {
        trigger: 'workflow-step',
        subject,
        binding: { kind: 'session', runId: null },
        dedupe: `workflow-step:${run.id}:${step.name}:${step.attempt}:${entry.scope}:${entry.rule.name}`,
        values,
      });
    const hold = rules.find(({ rule }) => rule.action === 'hold');
    if (!hold) return null;
    const dedupe = `workflow-step-hold:${run.id}:${step.name}:${step.attempt}:${hold.scope}:${hold.rule.name}`;
    const existing = this.ports.store
      .list()
      .find(
        ({ item, binding }) =>
          binding.kind === 'workflow-step' &&
          binding.runId === run.id &&
          binding.stepName === step.name &&
          (binding.attempt === step.attempt || item.status === 'pending'),
      );
    const item =
      existing?.item ??
      this.create(hold, session, {
        trigger: 'workflow-step',
        subject,
        binding: {
          kind: 'workflow-step',
          runId: run.id,
          stepName: step.name,
          attempt: step.attempt,
        },
        dedupe,
        values,
      });
    if (!item) return null;
    while (!signal.aborted) {
      const current = this.ports.store.get(item.id)?.item;
      if (!current) return null;
      if (current.status === 'approved') return null;
      if (current.status !== 'pending')
        return hostResult(
          execution,
          'fail',
          `The owner declined this step under the Inbox rule "${current.rule?.name}".${current.note ? ` Their note: ${current.note}` : ''}`,
        );
      await new Promise(resolve => {
        const timer = setTimeout(resolve, WORKFLOW_HOLD_POLL_MS);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve(undefined);
          },
          { once: true },
        );
      });
    }
    return { kind: 'interrupted' };
  }

  private async sweepCi() {
    if (this.ciSweeping) return;
    this.ciSweeping = true;
    try {
      const candidates = this.ports.sessions
        .list()
        .filter(session => session.pullRequest && !session.archivedAt)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, CI_SESSIONS_PER_SWEEP);
      for (const session of candidates) {
        if (this.ports.signal.aborted) return;
        const rules = (await this.rulesFor(session, this.ports.signal)).filter(
          ({ rule }) => rule.trigger === 'ci-checks',
        );
        if (!rules.length) continue;
        const status = await this.ports
          .ciStatus(session, this.ports.signal)
          .catch(() => null);
        if (!status || status.status === 'pending') continue;
        const key = `${status.headSha}:${status.status}`;
        const previous = this.ciSeen.get(session.id);
        this.ciSeen.set(session.id, key);
        if (previous === key) continue;
        for (const entry of rules.filter(({ rule }) => rule.status === status.status)) {
          const item = this.create(entry, session, {
            trigger: 'ci-checks',
            subject:
              status.status === 'red'
                ? `Checks failed: ${status.failing.slice(0, 5).join(', ')}`
                : 'Checks passed',
            binding: { kind: 'session', runId: null },
            dedupe: `ci-checks:${session.id}:${key}:${entry.scope}:${entry.rule.name}`,
            pullRequest: session.pullRequest,
            values: { checks: status.failing.join(', '), pr: pullRequestUrl(session.pullRequest) },
          });
          if (item && entry.rule.action === 'hold')
            this.ports.sessions.holdQueue(session.id);
        }
      }
    } finally {
      this.ciSweeping = false;
    }
  }

  private create(
    entry: ApplicableRule,
    session: Session | null,
    input: CreateInput,
  ): RuleInboxItem | null {
    const { rule } = entry;
    const route = this.routeFor(rule, session);
    const values: Record<string, string> = {
      'rule.name': rule.name,
      'session.title': session?.title ?? 'A pull request',
      'session.id': session?.id ?? '',
      trigger: input.trigger,
      subject: input.subject,
      pr: pullRequestUrl(input.pullRequest ?? session?.pullRequest ?? null),
      plan: input.plan ?? '',
      ...input.values,
    };
    const show = rule.show;
    const item: RuleInboxItem = {
      id: randomUUID(),
      rule: { name: rule.name, scope: entry.scope, description: rule.description },
      action: rule.action,
      trigger: input.trigger,
      subject: input.subject.slice(0, 500),
      binding: input.binding.kind,
      sessionId: session?.id ?? null,
      sessionTitle: (session?.title ?? 'Pull request').slice(0, 200),
      parentId: session?.parentId ?? null,
      route,
      status: 'pending',
      options: rule.action === 'ask' ? (rule.options ?? []) : [],
      presentation: {
        text: render(rule.body || rule.description || rule.name, values),
        show,
        command: show.includes('command') ? (input.command ?? null) : null,
        diff: null,
        pullRequest: show.includes('pull-request')
          ? (input.pullRequest ?? session?.pullRequest ?? null)
          : null,
        plan: show.includes('plan') ? (input.plan ?? session?.plan?.text ?? null) : null,
        report: show.includes('report') ? (input.report ?? null) : null,
      },
      note: null,
      answer: null,
      outcome: null,
      decidedVia: null,
      createdAt: new Date().toISOString(),
      decidedAt: null,
    };
    const binding: InboxBinding =
      input.binding.kind === 'pull-request'
        ? { kind: 'pull-request', input: input.binding.input }
        : input.binding;
    if (!this.ports.store.insert({ item, binding }, input.dedupe ?? null))
      return null;
    this.ports.emit({ type: 'inbox-item-changed', item });
    if (session) this.announce(item, session, 'needed');
    if (session && show.includes('diff')) void this.attachDiff(item, session, rule.diff);
    return item;
  }

  private async attachDiff(
    item: InboxItem,
    session: Session,
    scope: InboxItemDiff['scope'],
  ) {
    let diff: InboxItemDiff;
    try {
      const changes = await this.ports.changes(session.id, this.ports.signal);
      const set = scope === 'branch' ? changes.branch : changes.uncommitted;
      diff = {
        scope,
        files: set.files.slice(0, inboxRuleLimits.diffFiles).map(file => ({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
        })),
        truncated: set.truncated || set.files.length > inboxRuleLimits.diffFiles,
        error: set.status === 'available' ? null : (set.detail ?? 'The diff is unavailable.'),
      };
    } catch (error) {
      diff = {
        scope,
        files: [],
        truncated: false,
        error: (error instanceof Error ? error.message : 'The diff could not be read.').slice(0, 500),
      };
    }
    const stored = this.ports.store.get(item.id);
    if (!stored) return;
    const next = {
      ...stored.item,
      presentation: { ...stored.item.presentation, diff },
    };
    if (this.ports.store.update(next, stored.item.status))
      this.ports.emit({ type: 'inbox-item-changed', item: next });
  }

  private announce(item: RuleInboxItem, session: Session, status: 'needed' | 'decided') {
    const title = `${item.rule.name}: ${item.subject}`.slice(0, 500);
    const by = status === 'decided' ? ownerActor(item.decidedVia) : null;
    const base = {
      at: new Date().toISOString(),
      kind: 'decision' as const,
      subject: 'rule' as const,
      itemId: item.id,
      title,
      route: item.route,
      status,
      outcome: status === 'decided' ? this.outcomeText(item) : null,
      by,
    };
    if (item.action !== 'notify')
      this.safely(() =>
        this.ports.sessions.appendDecisionRecord(session.id, {
          ...base,
          id: randomUUID(),
          childId: null,
          childTitle: null,
        }),
      );
    if (session.parentId && routesToParent(item.route))
      this.safely(() =>
        this.ports.sessions.appendDecisionRecord(session.parentId!, {
          ...base,
          id: randomUUID(),
          childId: session.id,
          childTitle: session.title.slice(0, 200),
        }),
      );
    if (session.parentId)
      this.safely(() =>
        this.ports.coordinator(
          session,
          status === 'needed' ? 'decision-needed' : 'decision-made',
          status === 'needed'
            ? `${session.title} waits for the owner's decision on the Inbox rule "${item.rule.name}" (${item.route === 'inbox' ? 'in the Inbox' : item.route === 'parent' ? 'in your conversation' : 'in the Inbox and your conversation'}). Only the owner can decide it.`
            : `The owner decided the Inbox rule "${item.rule.name}" for ${session.title}: ${this.outcomeText(item)}.`,
          item.subject,
        ),
      );
  }

  private outcomeText(item: InboxItem) {
    return item.status === 'answered'
      ? `answered ${item.answer ?? ''}`.trim()
      : item.status;
  }

  private safely(work: () => void) {
    try {
      work();
    } catch {
      return;
    }
  }

  private settle<T extends InboxItem>(
    item: T,
    expected: T['status'],
    changes: Partial<NoInfer<T>>,
  ): T | null {
    const next = { ...item, ...changes };
    if (!this.ports.store.update(next, expected)) return null;
    this.ports.emit({ type: 'inbox-item-changed', item: next });
    return next;
  }

  async decide(
    raw: z.input<typeof decideInboxItemSchema>,
  ): Promise<InboxItem> {
    const input = decideInboxItemSchema.parse(raw);
    const stored = this.ports.store.get(input.itemId);
    if (!stored)
      throw new InboxRuleError('not-found', 'This Inbox item no longer exists.');
    const { item, binding } = stored;
    if (item.status !== 'pending') return item;
    if (item.binding === 'external') {
      const answer = item.options.find(option => option === input.option);
      if (input.decision !== 'answer' || !answer)
        throw new InboxRuleError(
          'invalid-request',
          'Choose one of the offered actions.',
        );
      return this.settle(item, 'pending', {
        status: 'answered',
        answer,
        note: input.note ?? null,
        decidedVia: input.via,
        decidedAt: new Date().toISOString(),
      }) ?? item;
    }
    const allowed =
      item.action === 'hold'
        ? ['approve', 'decline']
        : item.action === 'ask'
          ? ['answer', 'dismiss']
          : ['dismiss'];
    if (!allowed.includes(input.decision))
      throw new InboxRuleError(
        'invalid-request',
        `This ${item.action} item accepts ${allowed.join(' or ')}.`,
      );
    if (
      input.decision === 'answer' &&
      !item.options.some(option => option.toLowerCase() === input.option?.toLowerCase())
    )
      throw new InboxRuleError('invalid-request', 'Choose one of the offered options.');
    const at = new Date().toISOString();
    const status: InboxItem['status'] =
      input.decision === 'approve'
        ? 'approved'
        : input.decision === 'decline'
          ? 'declined'
          : input.decision === 'answer'
            ? 'answered'
            : 'dismissed';
    const answer =
      input.decision === 'answer'
        ? (item.options.find(option => option.toLowerCase() === input.option!.toLowerCase()) ?? null)
        : null;
    const claimed = this.settle(item, 'pending', {
      status,
      note: input.note ?? null,
      answer,
      decidedAt: at,
      decidedVia: input.via,
    });
    if (!claimed) {
      const current = this.ports.store.get(item.id)?.item;
      if (current) return current;
      throw new InboxRuleError('not-found', 'This Inbox item no longer exists.');
    }
    const outcome = await this.apply(claimed, binding, input.note ?? null);
    const current = this.ports.store.get(item.id)?.item;
    const finished = current && current.binding !== 'external' ? current : claimed;
    const result: RuleInboxItem = { ...finished, ...outcome };
    this.ports.store.update(result, finished.status);
    this.ports.emit({ type: 'inbox-item-changed', item: result });
    const session = result.sessionId
      ? this.ports.sessions.snapshot(result.sessionId)
      : undefined;
    if (session) this.announce(result, session, 'decided');
    return result;
  }

  private async apply(
    item: RuleInboxItem,
    binding: InboxBinding,
    note: string | null,
  ): Promise<Partial<RuleInboxItem>> {
    const declined = `The owner declined this under the Inbox rule "${item.rule.name}".${note ? ` Their note: ${note}` : ''}`;
    if (binding.kind === 'provider') {
      const session = item.sessionId
        ? this.ports.sessions.snapshot(item.sessionId)
        : undefined;
      try {
        this.ports.sessions.respondApproval({
          sessionId: item.sessionId!,
          runId: binding.runId,
          requestId: binding.approvalId,
          decision: item.status === 'approved' ? 'accept' : 'decline',
          ...(binding.fingerprint ? { fingerprint: binding.fingerprint } : {}),
          ...(item.status === 'declined' && session?.provider === 'Claude Code'
            ? { message: declined.slice(0, 2000) }
            : {}),
        });
        return {
          outcome:
            item.status === 'approved'
              ? 'Approved. The session continues.'
              : 'Declined. The agent received the refusal.',
        };
      } catch (error) {
        return {
          status: 'interrupted',
          outcome: `The held request is no longer active, so nothing ran. ${error instanceof Error ? error.message : ''}`.trim().slice(0, 1000),
        };
      }
    }
    if (binding.kind === 'pull-request') {
      if (item.status !== 'approved') return { outcome: 'Declined. Nothing was sent to GitHub.' };
      try {
        const result = await this.ports.actOnPullRequest(
          actOnPullRequestSchema.parse(binding.input),
        );
        return { outcome: (result.detail ?? `Approved. The ${result.action} was sent.`).slice(0, 1000) };
      } catch (error) {
        return {
          outcome: `Approved, but the action failed: ${error instanceof Error ? error.message : 'unknown error'}`.slice(0, 1000),
        };
      }
    }
    if (binding.kind === 'workflow-step')
      return {
        outcome:
          item.status === 'approved'
            ? 'Approved. The workflow step runs.'
            : 'Declined. The workflow step fails with your note.',
      };
    if (!item.sessionId) return {};
    try {
      if (item.action === 'hold') {
        if (item.status === 'declined')
          this.ports.sessions.queueOwnerMessage(item.sessionId, declined);
        this.ports.sessions.releaseInboxHold(item.sessionId);
      }
      if (item.status === 'answered' && item.answer)
        this.ports.sessions.queueOwnerMessage(
          item.sessionId,
          `The owner answered under the Inbox rule "${item.rule.name}": ${item.answer}${note ? `\n\n${note}` : ''}`,
        );
    } catch (error) {
      return {
        outcome: `Recorded, but the session could not be updated: ${error instanceof Error ? error.message : ''}`.slice(0, 1000),
      };
    }
    return {
      outcome:
        item.status === 'approved'
          ? 'Approved. The session can continue.'
          : item.status === 'declined'
            ? 'Declined. Your note was sent to the session.'
            : item.status === 'answered'
              ? 'Answered. The answer was sent to the session.'
              : 'Dismissed.',
    };
  }
}

type CreateInput = {
  trigger: InboxRuleTrigger;
  subject: string;
  binding: Exclude<InboxBinding, { kind: 'external' }>;
  dedupe?: string;
  values?: Record<string, string>;
  command?: string | null;
  pullRequest?: PullRequestReference | null;
  plan?: string | null;
  report?: StageReport | null;
};

export { InboxRuleFileError };
