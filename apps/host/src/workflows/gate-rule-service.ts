import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  GATE_RULES_PER_STEP,
  gateRuleLimits,
  gateRuleOutputJsonSchema,
  ruleEntryLimits,
  type AssistantChange,
  serializeRuleEntry,
  type DecideGateRuleInput,
  type DesktopEvent,
  type GateRuleGeneration,
  type GateRuleOverview,
  type GateRuleProposal,
  type GateRulesInput,
  type Review,
  type RuleEntry,
  type WorkflowRun,
  type WorkflowStepRecord,
} from '@nesvo/contracts';
import type { ProviderUsageService } from '../providers/usage-service';
import {
  BudgetRefusal,
  SessionError,
  type RunFinished,
  type SessionService,
} from '../sessions/service';
import type { AssistantChanges } from './assistant-changes';
import {
  loadCatalog,
  readDefinitionFile,
  resolveWriteRoots,
} from './definitions';
import { filterResultText } from './evidence';
import {
  activeGateRule,
  gateRuleLimitMessage,
  gateRuleMatches,
  mergeGateRules,
} from './gate-rule-catalog';
import {
  admitGateRuleProposals,
  duplicateGateRule,
  gateRuleProposalPrompt,
  gateRuleSources,
  safeProposal,
  type GateRuleSource,
} from './gate-rule-proposal';
import type { GateRuleStore } from './gate-rule-store';
import {
  RULE_ENTRY_MAX_NUMBER,
  highestRuleEntryNumber,
  parseRuleEntryText,
  readRuleEntryFolder,
  ruleEntryHash,
  validateRuleEntryDocument,
  type RuleEntryRoot,
  type StoredRuleEntry,
} from './rule-entry-files';
import type { WorkflowRunStore } from './store';
import { quotaReason } from './steps/agent';

type Ports = {
  store: GateRuleStore;
  runs: Pick<WorkflowRunStore, 'getRun' | 'stepsForRun'>;
  changes: Pick<AssistantChanges, 'applyRuleEntry'>;
  appliedChange: (
    sessionId: string,
    changeId: string,
  ) => AssistantChange | null;
  sessions: Pick<
    SessionService,
    | 'create'
    | 'sendWorkflowTurn'
    | 'onRunFinished'
    | 'finished'
    | 'whenFolderFree'
    | 'stopActive'
  >;
  usage: Pick<ProviderUsageService, 'read'>;
  review: (id: string) => Review | undefined;
  emit: (event: DesktopEvent) => void;
};

const terminal = (run: WorkflowRun) =>
  run.status === 'passed' ||
  run.status === 'failed' ||
  run.status === 'rejected';

const messageOf = (error: unknown, fallback: string) =>
  filterResultText(error instanceof Error ? error.message : fallback).slice(
    0,
    800,
  ) || fallback;

const storedRules = (roots: readonly RuleEntryRoot[]) =>
  roots.flatMap(root => readRuleEntryFolder('gate-rule', root).entries);

const ruleEntryIn = (
  entries: readonly StoredRuleEntry[],
  update: NonNullable<GateRuleProposal['proposal']['update']>,
) =>
  entries.find(
    item => item.entry.id === update.id && item.root.scope === update.scope,
  );

const invalid = (message: string) =>
  new SessionError('invalid-request', message);

export class GateRuleService {
  private readonly controller = new AbortController();
  private readonly running = new Set<Promise<void>>();
  private decisions = Promise.resolve();

  constructor(private readonly ports: Ports) {
    ports.store.recover();
  }

  settled(run: WorkflowRun): void {
    const { store } = this.ports;
    if (this.controller.signal.aborted || !terminal(run) || !store.enabled())
      return;
    const sources = this.sources(run);
    if (
      !sources.length ||
      !run.workflow.steps.some(step => step.type === 'agent')
    )
      return;
    const generation = store.start(run.id);
    if (generation) this.launch(generation, run, sources);
  }

  async execute(input: GateRulesInput): Promise<GateRuleOverview> {
    const { store } = this.ports;
    if (input.action === 'read') return this.overview(input.runId);
    const previous = this.decisions;
    const next = previous.then(async () => {
      if (input.action === 'settings') {
        store.setEnabled(input.enabled);
        return this.overview();
      }
      if (input.action === 'retry') {
        this.retry(input.runId, input.requestId);
        return this.overview(input.runId);
      }
      return this.decide(input.decision);
    });
    this.decisions = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async close(): Promise<void> {
    this.controller.abort();
    await Promise.all([...this.running, this.decisions]);
  }

  undoFor(proposalId: string, hash: string) {
    const proposal = this.ports.store.proposal(proposalId)?.row;
    if (!proposal?.changeId) return undefined;
    const change = this.ports.appliedChange(
      proposal.sessionId,
      proposal.changeId,
    );
    return change?.after?.type === 'hash' && change.after.hash === hash
      ? { conversationId: proposal.sessionId, changeId: proposal.changeId }
      : undefined;
  }

  private overview(runId?: string): GateRuleOverview {
    const { store } = this.ports;
    return {
      enabled: store.enabled(),
      proposals: store
        .proposals(runId)
        .map(row =>
          row.changeId && !this.ports.appliedChange(row.sessionId, row.changeId)
            ? { ...row, changeId: null }
            : row,
        ),
      generation: runId ? store.generation(runId) : null,
    };
  }

  private sources(run: WorkflowRun): GateRuleSource[] {
    return gateRuleSources(this.ports.runs.stepsForRun(run.id));
  }

  private retry(runId: string, requestId: string): void {
    const { store, runs } = this.ports;
    const receipt = store.receipt(requestId);
    if (receipt) {
      if (receipt !== JSON.stringify({ runId }))
        throw invalid('This request ID is already in use.');
      return;
    }
    const run = runs.getRun(runId);
    const generation = store.generation(runId);
    if (
      !run ||
      !terminal(run) ||
      !generation ||
      generation.status === 'running' ||
      generation.retries >= 2 ||
      store.proposals(runId).length
    )
      throw invalid('This run cannot propose gate rules again.');
    const sources = this.sources(run);
    if (!sources.length) throw invalid('This run has no source comments.');
    const next = {
      ...generation,
      status: 'running' as const,
      sessionId: null,
      reason: null,
      retries: generation.retries + 1,
    };
    store.retry(next, requestId);
    this.launch(next, run, sources);
  }

  private launch(
    generation: GateRuleGeneration,
    run: WorkflowRun,
    sources: GateRuleSource[],
  ): void {
    this.ports.emit({ type: 'gate-rule-generation-changed', generation });
    const work = this.generate(generation, run, sources).catch(() => undefined);
    this.running.add(work);
    void work.then(() => this.running.delete(work));
  }

  private async roots(
    run: WorkflowRun,
    signal: AbortSignal,
  ): Promise<RuleEntryRoot[]> {
    const roots = await resolveWriteRoots(run.projectRoot, signal);
    return [
      { scope: 'global', root: roots.global },
      { scope: 'project', root: roots.project },
    ];
  }

  private async instructions(
    run: WorkflowRun,
    signal: AbortSignal,
  ): Promise<string> {
    const texts = await Promise.all(
      ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md'].map(path =>
        readDefinitionFile(join(run.projectRoot, path), signal)
          .then(file => filterResultText(file.text).slice(0, 8000))
          .catch(() => ''),
      ),
    );
    return texts.join('\n');
  }

  private patches(sources: GateRuleSource[]): string[] {
    let remaining = 32 * 1024;
    return sources.flatMap(({ step }) => {
      const review = step.reviewId ? this.ports.review(step.reviewId) : null;
      if (!review || review.version !== step.reviewVersion) return [];
      const raw = [
        review.diff.files.map(file => file.path).join('\n'),
        review.diff.patch ?? '',
      ].join('\n');
      const patch = Buffer.from(filterResultText(raw)).subarray(0, remaining);
      remaining -= patch.length;
      return [patch.toString()];
    });
  }

  private async generate(
    initial: GateRuleGeneration,
    run: WorkflowRun,
    sources: GateRuleSource[],
  ): Promise<void> {
    const { store, sessions, usage, emit } = this.ports;
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(5 * 60_000),
    ]);
    let generation = initial;
    const finish = (
      status: GateRuleGeneration['status'],
      reason: string | null = null,
    ) => {
      generation = { ...generation, status, reason };
      store.saveGeneration(generation);
      emit({ type: 'gate-rule-generation-changed', generation });
    };
    const stop = () => {
      if (generation.sessionId) sessions.stopActive(generation.sessionId);
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      if (store.pendingCount() >= gateRuleLimits.pending)
        return finish('blocked', 'Decide pending gate rule proposals first.');
      const quota = quotaReason(
        await usage.read({ provider: run.gateProvider }),
        new Date(),
      );
      if (quota) return finish('blocked', quota);
      const roots = await this.roots(run, signal);
      const instructions = await this.instructions(run, signal);
      const entries = [
        ...storedRules(roots),
        ...roots.flatMap(root => readRuleEntryFolder('lesson', root).entries),
      ];
      signal.throwIfAborted();
      const session = sessions.create(
        {
          title: `Gate rule proposals · ${run.workflow.name}`.slice(0, 100),
          directory: run.projectRoot,
          provider: run.gateProvider,
          model: run.gateModel,
          mode: 'read-only',
        },
        {
          origin: {
            kind: 'workflow-gate-rule-proposal',
            runId: run.id,
            stepId: sources[0]!.step.id,
          },
        },
      );
      generation = { ...generation, sessionId: session.id };
      store.saveGeneration(generation);
      emit({ type: 'gate-rule-generation-changed', generation });
      const prompt = gateRuleProposalPrompt(
        run,
        sources,
        entries,
        instructions,
        this.patches(sources),
      );
      let repair: string | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = await this.turn(
          session.id,
          session.directory,
          repair
            ? `${prompt}\n\nRepair the structured response. ${repair}`
            : prompt,
          signal,
        );
        signal.throwIfAborted();
        if (outcome.limit)
          return finish(
            'blocked',
            outcome.limit.resetsAt
              ? `Provider usage limit reached. Resets at ${outcome.limit.resetsAt}.`
              : 'Provider usage limit reached.',
          );
        if (outcome.state !== 'completed')
          return finish(
            'failed',
            messageOf(
              outcome.error ? new Error(outcome.error) : null,
              'The proposal turn did not complete.',
            ),
          );
        try {
          const fresh = storedRules(roots);
          const admitted = admitGateRuleProposals(
            outcome.structured,
            run,
            sources,
            [...fresh, ...entries.filter(item => item.entry.type === 'lesson')],
            instructions,
          );
          const proposals = admitted.map(({ proposal, source, existing }) => {
            if (
              !existing &&
              proposal.steps.some(
                step =>
                  mergeGateRules(fresh).filter(
                    rule =>
                      activeGateRule(rule) &&
                      gateRuleMatches(rule, step, run.workflow.name),
                  ).length >= GATE_RULES_PER_STEP,
              )
            )
              throw new Error(
                'The target step is at its gate rule limit. Propose an update.',
              );
            const target = run.workflow.steps.find(
              step => step.name === proposal.steps[0],
            )!;
            const row: GateRuleProposal = {
              id: randomUUID(),
              runId: run.id,
              revision: 1,
              sessionId: session.id,
              taskSessionId: run.sessionId,
              workflow: run.workflow.name,
              status: 'pending',
              createdAt: new Date().toISOString(),
              proposal,
              scope: existing?.root.scope ?? target.source.scope,
              decisionKind: source.kind,
              current: existing?.entry.body ?? null,
              changeId: null,
              ruleId: null,
              error: null,
            };
            return { row, sourceStep: source.step.id };
          });
          if (store.pendingCount() + proposals.length > gateRuleLimits.pending)
            return finish(
              'blocked',
              'Decide pending gate rule proposals first.',
            );
          generation = {
            ...generation,
            status: proposals.length ? 'done' : 'none',
            reason: null,
          };
          store.complete(generation, proposals);
          emit({ type: 'gate-rule-generation-changed', generation });
          for (const { row } of proposals)
            emit({ type: 'gate-rule-proposal-changed', proposal: row });
          return;
        } catch (error) {
          repair = messageOf(error, 'Return valid proposals.');
        }
      }
      finish('invalid', repair);
    } catch (error) {
      finish(
        this.controller.signal.aborted
          ? 'interrupted'
          : error instanceof BudgetRefusal
            ? 'blocked'
            : 'failed',
        signal.aborted
          ? 'The proposal session was interrupted.'
          : messageOf(error, 'Gate rule proposals could not be generated.'),
      );
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }

  private async turn(
    sessionId: string,
    directory: string,
    text: string,
    signal: AbortSignal,
  ) {
    const { sessions } = this.ports;
    const messageId = randomUUID();
    let resolveFinished!: (event: RunFinished) => void;
    const finished = new Promise<RunFinished>(resolve => {
      resolveFinished = resolve;
    });
    const release = sessions.onRunFinished(event => {
      if (event.sessionId === sessionId) resolveFinished(event);
    });
    try {
      const outputSchema = gateRuleOutputJsonSchema();
      for (;;) {
        await sessions.whenFolderFree(directory, 'read', signal);
        signal.throwIfAborted();
        if (
          sessions.sendWorkflowTurn({
            sessionId,
            messageId,
            text,
            outputSchema,
            readOnly: true,
            ephemeral: true,
            instructionsOnly: true,
          }) === 'sent'
        )
          break;
        await delay(100, undefined, { signal });
      }
      const event = await finished;
      return await sessions.finished(sessionId, event.runId);
    } finally {
      release();
    }
  }

  private async decide(input: DecideGateRuleInput): Promise<GateRuleOverview> {
    const { store, runs } = this.ports;
    const record = store.proposal(input.proposalId);
    if (!record)
      throw new SessionError('not-found', 'Gate rule proposal not found.');
    const { row, sourceStep } = record;
    const receipt = store.receipt(input.decisionId);
    if (receipt) {
      if (receipt !== JSON.stringify(input))
        throw invalid('This decision ID is already in use.');
      return this.overview(row.runId);
    }
    if (
      row.revision !== input.revision ||
      (row.status !== 'pending' && row.status !== 'stale')
    )
      throw invalid('This proposal changed. Refresh and try again.');
    if (input.action === 'accept' && row.status === 'stale')
      throw invalid(
        'Edit the proposal using the current file before saving it.',
      );
    let next = { ...row, revision: row.revision + 1 };
    if (input.action === 'dismiss')
      next = { ...next, status: 'dismissed', error: null };
    else {
      const run = runs.getRun(row.runId);
      if (!run) throw new SessionError('not-found', 'Workflow run not found.');
      const source = this.sources(run).find(
        item => item.step.id === sourceStep,
      );
      if (!source || !source.comment.includes(row.proposal.quote))
        throw invalid('The owner comment for this proposal is unavailable.');
      next = await this.save(run, next, source.step, input);
    }
    store.decide(next, input);
    this.ports.emit({ type: 'gate-rule-proposal-changed', proposal: next });
    return this.overview(row.runId);
  }

  private async save(
    run: WorkflowRun,
    row: GateRuleProposal,
    source: WorkflowStepRecord,
    input: Exclude<DecideGateRuleInput, { action: 'dismiss' }>,
  ): Promise<GateRuleProposal> {
    const { store, changes } = this.ports;
    const signal = this.controller.signal;
    const roots = await this.roots(run, signal);
    const instructions = await this.instructions(run, signal);
    const rules = storedRules(roots);
    const update = row.proposal.update;
    const scope = input.action === 'edit' ? input.edit.scope : row.scope;
    const existing = update ? ruleEntryIn(rules, update) : undefined;
    const editingFile = update && scope === update.scope ? update : null;
    const candidate = safeProposal({
      ...row.proposal,
      ...(input.action === 'edit'
        ? {
            description: input.edit.description,
            kind: input.edit.kind,
            steps: input.edit.steps,
            body: input.edit.body,
          }
        : {}),
    });
    if (
      !candidate.steps.every(name =>
        run.workflow.steps.some(
          step => step.name === name && step.type === 'agent',
        ),
      )
    )
      throw invalid('Choose agent steps from the source run.');
    if (editingFile && existing?.hash !== editingFile.hash)
      return this.stale(
        row,
        existing,
        'The file changed. Review the current version before saving.',
      );
    const root = roots.find(item => item.scope === scope)!;
    const nextNumber = () => {
      const number = store.claimNumber(
        highestRuleEntryNumber(rules.map(item => item.entry)) + 1,
      );
      if (number > RULE_ENTRY_MAX_NUMBER)
        throw invalid('No gate rule numbers remain on this computer.');
      return `rule-${String(number).padStart(4, '0')}`;
    };
    const id = editingFile?.id ?? nextNumber();
    const entry: RuleEntry = {
      id,
      type: 'gate-rule',
      description: candidate.description,
      kind: candidate.kind,
      status: 'active',
      enforcedBy: 'none',
      scope: {
        ...existing?.entry.scope,
        ...(!existing ? { workflows: [run.workflow.name] } : {}),
        steps: [...new Set(candidate.steps)],
      },
      body: candidate.body,
      provenance: {
        source: 'run',
        run: run.id,
        workflow: run.workflow.name,
        step: source.name,
        ...(run.sessionId ? { session: run.sessionId } : {}),
        decision: row.decisionKind,
        decisionId: source.decision!.decisionId,
        date: source.decision!.at.slice(0, 10),
        attempt: Math.max(1, source.attempt),
        quote: row.proposal.quote,
        proposal: row.id,
        ...(input.action === 'edit' ? { edited: true as const } : {}),
      },
    };
    const document = serializeRuleEntry(entry);
    const outcome = await changes.applyRuleEntry(
      {
        conversationId: row.sessionId,
        messageId: row.id,
        directory: run.projectRoot,
      },
      {
        type: 'gate-rule',
        name: id,
        scope,
        op: editingFile ? 'update' : 'create',
        basedOnHash: editingFile?.hash ?? null,
        document,
        summary: candidate.description,
        validate: async text => {
          const invalidDocument = validateRuleEntryDocument(
            'gate-rule',
            id,
            text,
          );
          if (invalidDocument.length) return invalidDocument;
          const parsed = parseRuleEntryText('gate-rule', text);
          if (!parsed.valid) return parsed.issues;
          const catalog = await loadCatalog(run.projectRoot, signal);
          if (
            candidate.steps.some(
              name =>
                !catalog.steps.some(
                  step => step.name === name && step.type === 'agent',
                ),
            )
          )
            return ['The target step has changed or is no longer available.'];
          const targetFolder = readRuleEntryFolder('gate-rule', root);
          if (
            !editingFile &&
            (targetFolder.fileCount ?? 0) >= ruleEntryLimits.entriesPerRoot
          )
            return [
              'The workflows folder reached its gate rule limit. Update an existing gate rule.',
            ];
          const current = storedRules(roots);
          const old = editingFile
            ? ruleEntryIn(current, editingFile)
            : undefined;
          const duplicate = duplicateGateRule(
            candidate,
            [
              ...current,
              ...roots.flatMap(
                item => readRuleEntryFolder('lesson', item).entries,
              ),
            ],
            instructions,
            old,
          );
          if (duplicate)
            return [
              `This proposal duplicates ${typeof duplicate === 'string' ? duplicate : duplicate.entry.id}. Update that entry instead.`,
            ];
          const sourcePath = join(root.root, 'gate-rules', `${id}.md`);
          const proposed = {
            entry: parsed.entry,
            text,
            hash: ruleEntryHash(text),
            path: sourcePath,
            root,
          };
          const ordered = [
            ...current.filter(item => item !== old),
            proposed,
          ].sort(
            (left, right) =>
              Number(left.root.scope === 'project') -
              Number(right.root.scope === 'project'),
          );
          const visible = mergeGateRules(ordered);
          for (const name of candidate.steps) {
            const workflows = new Set([
              run.workflow.name,
              ...catalog.workflows
                .filter(workflow =>
                  workflow.steps.some(step => step.name === name),
                )
                .map(workflow => workflow.name),
              ...visible.flatMap(rule => rule.scope.workflows ?? []),
            ]);
            for (const workflow of workflows)
              if (
                visible.filter(
                  rule =>
                    activeGateRule(rule) &&
                    gateRuleMatches(rule, name, workflow),
                ).length > GATE_RULES_PER_STEP
              )
                return [gateRuleLimitMessage(name)];
          }
          return [];
        },
      },
    );
    if (outcome.status === 'refused') {
      const reason =
        outcome.issues[0]?.message ?? 'The gate rule file could not be saved.';
      if (outcome.reason === 'conflict')
        return this.stale(
          row,
          editingFile
            ? ruleEntryIn(storedRules(roots), editingFile)
            : undefined,
          reason,
        );
      throw invalid(reason);
    }
    return {
      ...row,
      scope,
      ruleId: id,
      status: 'accepted',
      proposal: candidate,
      changeId: outcome.status === 'applied' ? outcome.change.changeId : null,
      error:
        outcome.status === 'applied'
          ? null
          : 'The rule was saved without an Undo record.',
    };
  }

  private stale(
    row: GateRuleProposal,
    current: StoredRuleEntry | undefined,
    error: string,
  ): GateRuleProposal {
    return {
      ...row,
      status: 'stale',
      error,
      current: current?.entry.body ?? null,
      proposal: {
        ...row.proposal,
        update: current
          ? {
              id: current.entry.id,
              scope: current.root.scope,
              hash: current.hash,
            }
          : null,
      },
    };
  }
}
