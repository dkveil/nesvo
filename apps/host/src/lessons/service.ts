import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  LESSON_PROPOSAL_INTERVAL_MS,
  codeReviewLimits,
  formatRuleEntryBody,
  lessonLimits,
  lessonProposalOutputJsonSchema,
  lessonSchema,
  localDate,
  ruleEntryIndexLine,
  serializeRuleEntry,
  type DecideLessonInput,
  type Delegation,
  type Lesson,
  type LessonEvidence,
  type LessonIncident,
  type LessonOverview,
  type LessonProposalState,
  type LessonSettings,
  type ProposeLessonsInput,
  type ReviewConvention,
  type ReviewDraft,
  type RuleEntry,
  type RuleEntryProvenance,
  type Session,
  type SessionStageRecord,
  type WorkflowRun,
  type WorkflowStepRecord,
} from '@nesvo/contracts';
import { derivedId } from '../code-review/service';
import { SessionError } from '../sessions/session-error';
import type { RunFinished, SessionService } from '../sessions/service';
import type {
  AssistantChanges,
  RuleEntryChangeOutcome,
} from '../workflows/assistant-changes';
import { pathKey } from '../workflows/definitions';
import {
  RULE_ENTRY_MAX_NUMBER,
  globalWorkflowsRoot,
  highestRuleEntryNumber,
  projectRootOfWorkflowsRoot,
  projectRootSync,
  projectWorkflowsRoot,
  readRuleEntryFolder,
  ruleEntryMetricKey,
  validateRuleEntryDocument,
  type RuleEntryFolderRead,
  type RuleEntryRoot,
  type StoredRuleEntry,
} from '../workflows/rule-entry-files';
import {
  finishedRunIncidents,
  stageRecordIncidents,
  workerPlanIncident,
  workflowStepIncidents,
  type IncidentDraft,
} from './incidents';
import {
  lessonProposalPrompt,
  parseLessonProposal,
  type AdmittedLesson,
  type ExistingEntry,
} from './proposal';
import {
  ownerLessonsBlock,
  selectEntries,
  type LessonContext,
  type SelectableEntry,
} from './scope';
import { idleProposal, type LessonStore } from './store';

const CHECK_INTERVAL_MS = 10 * 60_000;
const FOLDER_WAIT_MS = 10 * 60_000;
const FOLDER_CACHE_MS = 3_000;
const DAY_MS = 24 * 60 * 60_000;

type LessonSessions = Pick<
  SessionService,
  'createWithEffort' | 'send' | 'finished' | 'whenFolderFree' | 'snapshot'
>;

type LessonChanges = Pick<
  AssistantChanges,
  'applyRuleEntry' | 'undo' | 'latest'
>;

type LessonPorts = {
  store: LessonStore;
  sessions: LessonSessions;
  changes: LessonChanges;
  dataDirectory: string;
  directories?: () => readonly string[];
  workflowOf?: (
    runId: string,
    stepId: string | null,
  ) => { workflow: string; step: string | null } | null;
  archive?: (sessionId: string) => void;
  now?: () => Date;
  timers?: boolean;
};

export class LessonError extends Error {
  constructor(
    readonly code: 'busy' | 'not-found' | 'invalid-request' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'LessonError';
  }
}

const OUTCOME_MESSAGES = {
  failed: 'The lesson proposal session failed.',
  stopped: 'The lesson proposal session was stopped.',
  interrupted: 'The lesson proposal session was interrupted.',
} as const;

const hash = (text: string) =>
  createHash('sha256').update(text).digest('hex');

const evidenceOf = (incident: LessonIncident): LessonEvidence => ({
  incidentId: incident.id,
  kind: incident.kind,
  summary: incident.summary,
  at: incident.at,
  sessionId: incident.sessionId,
  runId: incident.runId,
  workflowRunId: incident.workflowRunId,
});

const entryKey = (stored: StoredRuleEntry) =>
  `${stored.entry.id}:${hash(pathKey(stored.root.root)).slice(0, 8)}`;

const metricKey = (stored: StoredRuleEntry) =>
  ruleEntryMetricKey(stored.root.root, stored.entry.id);

const conversationOf = (stored: Pick<StoredRuleEntry, 'root' | 'entry'>) =>
  derivedId('rule-entry', `${pathKey(stored.root.root)}#${stored.entry.id}`);

const providerOf = (provider: Session['provider']) =>
  provider === 'Codex' ? ('codex' as const) : ('claude' as const);

export class LessonService {
  private readonly controller = new AbortController();
  private readonly now: () => Date;
  private readonly injected = new Map<string, string>();
  private readonly folders = new Map<
    string,
    { at: number; read: RuleEntryFolderRead }
  >();
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly ports: LessonPorts) {
    this.now = ports.now ?? (() => new Date());
    this.recover();
    if (ports.timers !== false) {
      this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  overview(): LessonOverview {
    const { store } = this.ports;
    const settings = store.settings();
    const proposal = store.proposalState();
    const files = this.allEntries();
    const metrics = store.metrics(files.entries.map(metricKey));
    const lessons = files.entries.map(stored =>
      this.toLesson(stored, metrics.get(metricKey(stored)) ?? null),
    );
    return {
      settings,
      proposal,
      nextProposalAt: settings.dailyProposals
        ? new Date(
            Math.max(
              this.now().getTime(),
              proposal.startedAt
                ? Date.parse(proposal.startedAt) + LESSON_PROPOSAL_INTERVAL_MS
                : 0,
            ),
          ).toISOString()
        : null,
      lessons: [...this.proposals(), ...lessons],
      issues: [
        ...lessons
          .filter(lesson => lesson.location && !lesson.location.trusted)
          .map(
            lesson =>
              `${lesson.location!.path}: this project lesson was not written by your decision in Nesvo, so it is not added to prompts. Keep it to approve the current text.`,
          ),
        ...files.issues,
      ]
        .map(issue => issue.slice(0, lessonLimits.error))
        .slice(0, 50),
      incidents: store.incidents(),
      pendingIncidents: store.pendingCount(),
    };
  }

  saveSettings(settings: LessonSettings): LessonOverview {
    this.ports.store.saveSettings(settings);
    return this.overview();
  }

  record(drafts: readonly IncidentDraft[]): number {
    if (this.closed) return 0;
    let recorded = 0;
    for (const { incident, fingerprint } of drafts)
      try {
        if (this.ports.store.recordIncident(incident, fingerprint)) recorded++;
      } catch {
        continue;
      }
    return recorded;
  }

  runFinished(finished: RunFinished): void {
    const session = this.ports.sessions.snapshot(finished.sessionId);
    if (!session) return;
    this.record(
      finishedRunIncidents(
        session,
        finished.runId,
        this.ports.store.settings().costNormUsd,
        this.now(),
      ),
    );
  }

  stageRecorded(session: Session, records: readonly SessionStageRecord[]) {
    this.record(stageRecordIncidents(session, records));
  }

  workerPlanDecided(
    parent: Session,
    delegationId: string,
    decision: 'accept' | 'correct' | 'decline',
    text: string | null,
  ) {
    const delegation = parent.delegations.find(
      (item: Delegation) => item.id === delegationId,
    );
    if (!delegation) return;
    const draft = workerPlanIncident(
      parent,
      delegation,
      decision,
      text,
      this.now(),
    );
    if (draft) this.record([draft]);
  }

  workflowStepChanged(run: WorkflowRun | undefined, step: WorkflowStepRecord) {
    if (!run) return;
    this.record(workflowStepIncidents(run, step, this.now()));
  }

  propose(input: ProposeLessonsInput): LessonOverview {
    const proposalId = derivedId('lesson-proposal', input.requestId);
    const current = this.ports.store.proposalState();
    if (current.proposalId === proposalId) return this.overview();
    if (current.status === 'running' || this.running)
      throw new LessonError(
        'busy',
        'Lessons are already being proposed. Wait for the result.',
      );
    if (!this.ports.store.pendingCount())
      throw new LessonError(
        'invalid-request',
        'There are no new incidents to learn from yet.',
      );
    this.start(proposalId);
    return this.overview();
  }

  async decide(input: DecideLessonInput): Promise<LessonOverview> {
    const proposal = this.proposal(input.key);
    if (proposal) {
      if (proposal.version !== input.expectedVersion) throw this.changed();
      await this.decideProposal(proposal, input);
    } else {
      const stored = this.allEntries().entries.find(
        item => entryKey(item) === input.key,
      );
      if (!stored) throw new LessonError('not-found', 'Lesson not found.');
      if (stored.hash !== input.expectedVersion) throw this.changed();
      await this.decideEntry(stored, input);
    }
    this.folders.clear();
    return this.overview();
  }

  instructions(session: Session): string | null {
    const { selection, keys } = this.select(this.contextOf(session));
    const block = ownerLessonsBlock(selection);
    if (!block) {
      this.injected.delete(session.id);
      return null;
    }
    const digest = hash(block);
    if (
      session.providerInitialized &&
      this.injected.get(session.id) === digest
    )
      return null;
    this.injected.set(session.id, digest);
    this.delivered(keys);
    return block;
  }

  verifierLessons(context: LessonContext, bodyBudget: number) {
    try {
      const { selection, entries } = this.select(context, bodyBudget);
      const block = ownerLessonsBlock(selection);
      return block && block.length <= bodyBudget ? { block, entries } : null;
    } catch {
      return null;
    }
  }

  reviewConventions(
    draft: Pick<ReviewDraft, 'directory' | 'profile'>,
  ): ReviewConvention[] {
    try {
      const { selection, keys } = this.select({
        directories: [draft.directory],
        provider: providerOf(draft.profile.provider),
        role: 'reviewer',
        workflow: null,
        step: null,
        paths: [],
      });
      this.delivered(keys);
      const at = this.now().toISOString();
      return selection.index.map(item => ({
        id: randomUUID(),
        layer: 'global',
        scope: '',
        text: `Owner lesson ${ruleEntryIndexLine(item.entry)} ${formatRuleEntryBody(item.entry.body).replaceAll('\n', ' ')}`.slice(
          0,
          codeReviewLimits.conventionText,
        ),
        createdAt: at,
        updatedAt: at,
      }));
    } catch {
      return [];
    }
  }

  tick(): void {
    if (this.closed || this.running) return;
    const settings = this.ports.store.settings();
    if (!settings.dailyProposals) return;
    const state = this.ports.store.proposalState();
    if (
      state.startedAt &&
      this.now().getTime() - Date.parse(state.startedAt) <
        LESSON_PROPOSAL_INTERVAL_MS
    )
      return;
    if (!this.ports.store.pendingCount()) return;
    this.start(
      derivedId('lesson-proposal', `daily:${this.now().toISOString()}`),
    );
  }

  whenIdle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.running?.catch(() => undefined);
  }

  private today(): string {
    return localDate(this.now());
  }

  private inDays(days: number): string {
    return localDate(new Date(this.now().getTime() + days * DAY_MS));
  }

  private changed(): LessonError {
    return new LessonError(
      'invalid-request',
      'This lesson changed. Refresh and try again.',
    );
  }

  private contextOf(session: Session): LessonContext {
    const workflow = session.workflowRunId
      ? (this.ports.workflowOf?.(
          session.workflowRunId,
          session.workflowStepId,
        ) ?? null)
      : null;
    return {
      directories: [
        session.directory,
        ...(session.worktree ? [session.worktree.projectDirectory] : []),
      ],
      provider: providerOf(session.provider),
      role: session.role,
      workflow: workflow?.workflow ?? null,
      step: workflow?.step ?? null,
      paths: [],
    };
  }

  private delivered(keys: readonly string[]): void {
    if (!keys.length) return;
    try {
      this.ports.store.recordDelivery(keys, this.now().toISOString());
    } catch {
      return;
    }
  }

  private select(context: LessonContext, bodyBudget?: number) {
    const trusted = this.entriesIn(
      this.projectRoots(context.directories),
    ).entries.filter(stored => this.isTrusted(stored));
    const entries = bodyBudget === undefined
      ? trusted
      : [...new Map(trusted.reverse().map(stored => [stored.entry.id, stored])).values()];
    const metrics = this.ports.store.metrics(entries.map(metricKey));
    const byKey = new Map(entries.map(stored => [entryKey(stored), stored]));
    const selection = selectEntries(
      entries.map(
        (stored): SelectableEntry => ({
          key: entryKey(stored),
          entry: stored.entry,
          lastCited: metrics.get(metricKey(stored))?.lastCited ?? null,
        }),
      ),
      context,
      this.today(),
      bodyBudget,
    );
    const selected = selection.index.map(item => byKey.get(item.key)!);
    return {
      selection,
      keys: selected.map(metricKey),
      entries: selected.map(stored => ({
        id: stored.entry.id,
        key: metricKey(stored),
        contentHash: stored.hash,
      })),
    };
  }

  private isTrusted(stored: StoredRuleEntry): boolean {
    if (stored.root.scope === 'global') return true;
    const latest = this.ports.changes.latest(conversationOf(stored));
    const configured = this.ports.changes.configuration.latestEntry(
      'lessons', projectRootOfWorkflowsRoot(stored.root.root), stored.entry.id,
    );
    if (configured && (!latest || configured.updatedAt >= latest.at))
      return configured.resultingVersion?.type === 'hash' && configured.resultingVersion.hash === stored.hash;
    return (
      latest?.createdBy === 'owner' &&
      latest.after?.type === 'hash' &&
      latest.after.hash === stored.hash
    );
  }

  private globalRoot(): RuleEntryRoot {
    return { scope: 'global', root: globalWorkflowsRoot() };
  }

  private projectRoots(directories: readonly string[]) {
    const roots = new Map<string, string>();
    for (const directory of directories) {
      if (roots.size >= lessonLimits.lessonRoots) break;
      const root = projectRootSync(directory);
      if (root) roots.set(pathKey(root), root);
    }
    return [...roots.values()];
  }

  private readFolder(root: RuleEntryRoot) {
    const key = `${root.scope}:${pathKey(root.root)}`;
    const cached = this.folders.get(key);
    const now = Date.now();
    if (cached && now - cached.at < FOLDER_CACHE_MS) return cached.read;
    const read = readRuleEntryFolder('lesson', root);
    this.folders.set(key, { at: now, read });
    return read;
  }

  private entriesIn(projectRoots: readonly string[]): RuleEntryFolderRead {
    const global = this.globalRoot();
    const reads = [
      ...projectRoots
        .map(projectRoot => projectWorkflowsRoot(projectRoot))
        .filter(root => pathKey(root) !== pathKey(global.root))
        .map(root => this.readFolder({ scope: 'project', root })),
      this.readFolder(global),
    ];
    return {
      entries: reads.flatMap(read => read.entries),
      issues: reads.flatMap(read => read.issues),
    };
  }

  private allEntries(): RuleEntryFolderRead {
    const directories = [
      ...(this.ports.directories?.() ?? []),
      ...this.ports.store
        .incidents()
        .map(incident => incident.directory)
        .filter(directory => directory !== null),
    ];
    return this.entriesIn(this.projectRoots(directories));
  }

  private toLesson(
    stored: StoredRuleEntry,
    metrics: Lesson['metrics'],
  ): Lesson {
    const { entry } = stored;
    const latest = this.ports.changes.latest(conversationOf(stored));
    return {
      key: entryKey(stored),
      id: entry.id,
      state: entry.status,
      description: entry.description,
      kind: entry.kind,
      scope: entry.scope,
      enforcedBy: entry.enforcedBy,
      review: entry.review ?? null,
      provenance: entry.provenance,
      body: entry.body,
      project:
        stored.root.scope === 'project'
          ? projectRootOfWorkflowsRoot(stored.root.root)
          : null,
      version: stored.hash,
      location: {
        scope: stored.root.scope,
        root: stored.root.root,
        path: stored.path,
        changeId: latest?.changeId ?? null,
        trusted: this.isTrusted(stored),
      },
      evidence: this.ports.store
        .incidentsById(entry.provenance.incidents ?? [])
        .map(evidenceOf),
      metrics,
      createdAt: `${entry.provenance.date}T00:00:00.000Z`,
    };
  }

  private proposalFolder(): string {
    const folder = join(this.ports.dataDirectory, 'lessons', 'proposals');
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  private proposals(): Lesson[] {
    const folder = this.proposalFolder();
    return readdirSync(folder)
      .filter(name => name.endsWith('.json'))
      .slice(0, lessonLimits.proposals)
      .map(name => this.readProposal(join(folder, name)))
      .filter(lesson => lesson !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private readProposal(path: string): Lesson | null {
    try {
      const text = readFileSync(path, 'utf8');
      const parsed = lessonSchema.safeParse(JSON.parse(text));
      return parsed.success ? { ...parsed.data, version: hash(text) } : null;
    } catch {
      return null;
    }
  }

  private proposal(key: string): Lesson | null {
    if (!/^[0-9a-f-]{36}$/.test(key)) return null;
    return this.readProposal(join(this.proposalFolder(), `${key}.json`));
  }

  private writeProposal(lesson: Lesson): void {
    const path = join(this.proposalFolder(), `${lesson.key}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify(lessonSchema.parse({ ...lesson, version: 'stored' })),
      { mode: 0o600 },
    );
    renameSync(temporary, path);
  }

  private removeProposal(key: string): void {
    rmSync(join(this.proposalFolder(), `${key}.json`), { force: true });
  }

  private requireFutureReview(review: string | undefined): void {
    if (review && review <= this.today())
      throw new LessonError(
        'invalid-request',
        'Choose a review date in the future.',
      );
  }

  private async decideProposal(
    proposal: Lesson,
    input: DecideLessonInput,
  ): Promise<void> {
    if (input.decision === 'reject') {
      this.removeProposal(proposal.key);
      return;
    }
    if (input.decision === 'retire' || input.decision === 'undo')
      throw new LessonError(
        'invalid-request',
        'Approve or reject a proposed lesson first.',
      );
    const changes = input.changes ?? {};
    this.requireFutureReview(changes.review);
    const edited: Lesson = {
      ...proposal,
      description: changes.description ?? proposal.description,
      kind: changes.kind ?? proposal.kind,
      body: changes.body ?? proposal.body,
      scope: changes.scope ?? proposal.scope,
      enforcedBy: changes.enforcedBy ?? proposal.enforcedBy,
      review: changes.review ?? proposal.review,
      project:
        changes.project === undefined ? proposal.project : changes.project,
    };
    if (input.decision === 'edit') {
      this.writeProposal(edited);
      return;
    }
    const target = this.targetFor(edited.project);
    const known = this.allEntries()
      .entries.filter(stored => this.isTrusted(stored))
      .map(stored => stored.entry);
    const number = this.ports.store.claimNumber(
      highestRuleEntryNumber(known) + 1,
      RULE_ENTRY_MAX_NUMBER,
    );
    const id = `lesson-${String(number).padStart(4, '0')}`;
    const entry: RuleEntry = {
      id,
      type: 'lesson',
      description: edited.description,
      kind: edited.kind,
      scope: edited.scope,
      status: 'active',
      enforcedBy: edited.enforcedBy,
      review:
        edited.review && edited.review > this.today()
          ? edited.review
          : this.inDays(lessonLimits.defaultReviewDays),
      provenance: { ...edited.provenance, date: this.today() },
      body: edited.body,
    };
    const root: RuleEntryRoot = {
      scope: target.scope,
      root:
        target.scope === 'project'
          ? projectWorkflowsRoot(target.directory)
          : globalWorkflowsRoot(),
    };
    const outcome = await this.ports.changes.applyRuleEntry(
      {
        conversationId: conversationOf({ root, entry }),
        messageId: randomUUID(),
        directory: target.directory,
      },
      {
        type: 'lesson',
        op: 'create',
        scope: target.scope,
        name: id,
        basedOnHash: null,
        document: serializeRuleEntry(entry),
        summary: `Approve ${id}`,
        validate: text => validateRuleEntryDocument('lesson', id, text),
      },
    );
    this.requireApplied(outcome);
    this.removeProposal(proposal.key);
  }

  private async decideEntry(
    stored: StoredRuleEntry,
    input: DecideLessonInput,
  ): Promise<void> {
    const conversationId = conversationOf(stored);
    if (input.decision === 'undo') {
      const latest = this.ports.changes.latest(conversationId);
      if (!latest)
        throw new LessonError(
          'invalid-request',
          'This lesson has no change from Nesvo to undo.',
        );
      const result = await this.ports.changes.undo({
        conversationId,
        changeId: latest.changeId,
      });
      if (result.status === 'conflict')
        throw new LessonError('invalid-request', result.message);
      if (result.status === 'refused')
        throw new LessonError(
          'invalid-request',
          result.issues[0]?.message ?? 'The change could not be undone.',
        );
      return;
    }
    if (input.decision === 'reject')
      throw new LessonError(
        'invalid-request',
        'An approved lesson cannot be rejected. Retire it instead.',
      );
    const changes = input.changes ?? {};
    if (changes.project !== undefined)
      throw new LessonError(
        'invalid-request',
        'An approved lesson stays in its workflows folder. Retire it and approve a new one instead.',
      );
    this.requireFutureReview(changes.review);
    if (input.decision !== 'edit' && stored.entry.status !== 'active')
      throw new LessonError(
        'invalid-request',
        'A retired lesson stays retired. Approve a new proposal instead.',
      );
    const entry: RuleEntry = {
      ...stored.entry,
      description: changes.description ?? stored.entry.description,
      kind: changes.kind ?? stored.entry.kind,
      body: changes.body ?? stored.entry.body,
      scope: changes.scope ?? stored.entry.scope,
      enforcedBy: changes.enforcedBy ?? stored.entry.enforcedBy,
      status: input.decision === 'retire' ? 'retired' : stored.entry.status,
      review:
        input.decision === 'approve'
          ? (changes.review ?? this.inDays(lessonLimits.defaultReviewDays))
          : (changes.review ?? stored.entry.review),
    };
    const verb =
      input.decision === 'retire'
        ? 'Retire'
        : input.decision === 'approve'
          ? 'Keep'
          : 'Edit';
    const outcome = await this.ports.changes.applyRuleEntry(
      {
        conversationId,
        messageId: randomUUID(),
        directory:
          stored.root.scope === 'project'
            ? projectRootOfWorkflowsRoot(stored.root.root)
            : this.workspace(),
      },
      {
        type: 'lesson',
        op: 'update',
        scope: stored.root.scope,
        name: stored.entry.id,
        basedOnHash: stored.hash,
        document: serializeRuleEntry(entry),
        summary: `${verb} ${stored.entry.id}`,
        validate: text =>
          validateRuleEntryDocument('lesson', stored.entry.id, text),
      },
    );
    this.requireApplied(outcome);
  }

  private targetFor(project: string | null): {
    scope: RuleEntryRoot['scope'];
    directory: string;
  } {
    if (!project) return { scope: 'global', directory: this.workspace() };
    const projectRoot = projectRootSync(project);
    if (!projectRoot)
      throw new LessonError(
        'invalid-request',
        'The project folder of this lesson does not exist on this computer.',
      );
    return { scope: 'project', directory: projectRoot };
  }

  private workspace(): string {
    const directory = join(this.ports.dataDirectory, 'lessons', 'workspace');
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  private requireApplied(outcome: RuleEntryChangeOutcome): void {
    if (outcome.status === 'applied') return;
    if (outcome.status === 'saved-without-history')
      throw new LessonError('unavailable', 'The lesson was saved without an Undo record.');
    throw new LessonError(
      'invalid-request',
      outcome.issues[0]?.message ??
        (outcome.reason === 'conflict'
          ? 'The lesson file changed. Refresh and try again.'
          : 'The lesson file could not be written.'),
    );
  }

  private recover(): void {
    const state = this.ports.store.proposalState();
    if (state.status === 'running')
      this.ports.store.saveProposalState({
        ...state,
        status: 'failed',
        finishedAt: this.now().toISOString(),
        error:
          'The host stopped before the lesson proposal finished. Propose lessons again.',
      });
  }

  private start(proposalId: string): void {
    const startedAt = this.now().toISOString();
    this.ports.store.saveProposalState({
      ...idleProposal,
      status: 'running',
      proposalId,
      startedAt,
    });
    this.running = this.run(proposalId, startedAt).finally(() => {
      this.running = null;
    });
  }

  private finish(changes: Partial<LessonProposalState>): void {
    this.ports.store.saveProposalState({
      ...this.ports.store.proposalState(),
      ...changes,
      finishedAt: this.now().toISOString(),
    });
  }

  private provenanceOf(
    lesson: AdmittedLesson,
    byId: Map<string, LessonIncident>,
  ): RuleEntryProvenance {
    const sources = lesson.evidence
      .map(id => byId.get(id))
      .filter(incident => incident !== undefined);
    const first = sources[0];
    const quote = sources.find(incident => incident.quote)?.quote;
    return {
      source: 'incident',
      incidents: lesson.evidence,
      ...(first?.workflowRunId ? { run: first.workflowRunId } : {}),
      ...(first?.step ? { step: first.step } : {}),
      ...(first?.sessionId ? { session: first.sessionId } : {}),
      date: this.today(),
      ...(quote ? { quote } : {}),
    };
  }

  private existingEntries(): ExistingEntry[] {
    return [
      ...this.proposals().map(lesson => ({
        id: 'proposed',
        description: lesson.description,
        rule: lesson.body.rule,
      })),
      ...this.allEntries()
        .entries.filter(
          stored => stored.entry.status === 'active' && this.isTrusted(stored),
        )
        .map(stored => ({
          id: stored.entry.id,
          description: stored.entry.description,
          rule: stored.entry.body.rule,
        })),
    ];
  }

  private storeProposals(
    proposalId: string,
    lessons: readonly AdmittedLesson[],
    incidents: readonly LessonIncident[],
  ): number {
    const byId = new Map(incidents.map(incident => [incident.id, incident]));
    const room = Math.max(0, lessonLimits.proposals - this.proposals().length);
    const accepted = lessons.slice(0, room);
    const at = this.now().toISOString();
    for (const lesson of accepted)
      this.writeProposal({
        key: derivedId(`lesson:${proposalId}`, lesson.description),
        id: null,
        state: 'proposed',
        description: lesson.description,
        kind: lesson.kind,
        scope: lesson.scope,
        enforcedBy: lesson.enforcedBy,
        review: this.inDays(lesson.reviewInDays),
        provenance: this.provenanceOf(lesson, byId),
        body: lesson.body,
        project: lesson.project,
        version: 'stored',
        location: null,
        evidence: lesson.evidence
          .map(id => byId.get(id))
          .filter(incident => incident !== undefined)
          .map(evidenceOf),
        metrics: null,
        createdAt: at,
      });
    this.ports.store.markProposed(
      incidents.map(incident => incident.id),
      at,
    );
    return accepted.length;
  }

  private async run(proposalId: string, startedAt: string): Promise<void> {
    const { store, sessions } = this.ports;
    const settings = store.settings();
    const incidents = store.pendingIncidents(lessonLimits.proposalIncidents);
    const existing = this.existingEntries();
    let sessionId: string | null = null;
    try {
      const session = await sessions.createWithEffort(
        {
          requestId: derivedId('lesson-session', proposalId),
          title: `Lesson proposals · ${startedAt.slice(0, 10)}`,
          provider: settings.provider,
          model: settings.model,
          mode: 'read-only',
          directory: this.workspace(),
        },
        this.controller.signal,
      );
      sessionId = session.id;
      store.saveProposalState({ ...store.proposalState(), sessionId });
      await this.whenFolderFree(session.directory);
      const started = sessions.send(
        {
          sessionId,
          messageId: derivedId('lesson-message', proposalId),
          text: lessonProposalPrompt(incidents, existing),
        },
        {
          outputSchema: lessonProposalOutputJsonSchema(),
          instructionsOnly: true,
          withoutResult: true,
        },
      );
      if (!started.runId)
        throw new LessonError(
          'unavailable',
          'The lesson proposal session did not start a turn.',
        );
      const outcome = await sessions.finished(sessionId, started.runId);
      if (outcome.state !== 'completed') {
        this.finish({
          status: 'failed',
          error: (
            outcome.error ??
            (outcome.state in OUTCOME_MESSAGES
              ? OUTCOME_MESSAGES[outcome.state as keyof typeof OUTCOME_MESSAGES]
              : 'The lesson proposal session did not complete.')
          ).slice(0, lessonLimits.error),
        });
        return;
      }
      const parsed = parseLessonProposal(
        outcome.structured,
        incidents,
        existing,
      );
      if (!parsed.valid) {
        this.finish({ status: 'invalid', error: parsed.error });
        return;
      }
      const proposed = this.storeProposals(
        proposalId,
        parsed.lessons,
        incidents,
      );
      this.finish({
        status: 'idle',
        error: null,
        proposed,
        dropped: parsed.dropped + parsed.lessons.length - proposed,
      });
    } catch (error) {
      this.finish({
        status: 'failed',
        error: (this.closed
          ? 'The host stopped before the lesson proposal finished. Propose lessons again.'
          : error instanceof LessonError || error instanceof SessionError
            ? error.message
            : 'The lesson proposal could not be prepared.'
        ).slice(0, lessonLimits.error),
      });
    } finally {
      if (sessionId && !this.closed) this.archiveQuietly(sessionId);
    }
  }

  private archiveQuietly(sessionId: string): void {
    try {
      this.ports.archive?.(sessionId);
    } catch {
      return;
    }
  }

  private async whenFolderFree(directory: string): Promise<void> {
    const timeout = AbortSignal.timeout(FOLDER_WAIT_MS);
    try {
      await this.ports.sessions.whenFolderFree(
        directory,
        'read',
        AbortSignal.any([this.controller.signal, timeout]),
      );
    } catch (error) {
      if (timeout.aborted)
        throw new LessonError(
          'busy',
          'The lesson folder stayed in use. Propose lessons again later.',
        );
      throw error;
    }
  }
}
