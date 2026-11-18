import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  GITHUB_REPOSITORY_PATTERN,
  LESSON_PROPOSAL_INTERVAL_MS,
  codeReviewLimits,
  lessonLimits,
  lessonProposalOutputJsonSchema,
  type DecideLessonInput,
  type Delegation,
  type Lesson,
  type LessonEvidence,
  type LessonIncident,
  type LessonOverview,
  type LessonProposalState,
  type LessonScope,
  type LessonSettings,
  type ProposeLessonsInput,
  type ReviewConvention,
  type ReviewDraft,
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
  LessonChangeOutcome,
} from '../workflows/assistant-changes';
import { pathKey } from '../workflows/definitions';
import {
  globalLessonRoot,
  lessonFileName,
  parseLessonDocument,
  projectLessonRoot,
  projectRootSync,
  readLessonFolder,
  serializeLesson,
  type LessonFileDocument,
  type LessonFolderRead,
  type LessonRoot,
  type StoredLessonFile,
} from './files';
import {
  finishedRunIncidents,
  stageRecordIncidents,
  workerPlanIncident,
  workflowStepIncidents,
  type IncidentDraft,
} from './incidents';
import { lessonProposalPrompt, parseLessonProposal } from './proposal';
import {
  applicableLessons,
  lessonLine,
  ownerLessonsBlock,
  type LessonContext,
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

type LessonChanges = Pick<AssistantChanges, 'applyLesson' | 'undo' | 'latest'>;

type LessonPorts = {
  store: LessonStore;
  sessions: LessonSessions;
  changes: LessonChanges;
  dataDirectory: string;
  directories?: () => readonly string[];
  workflowName?: (runId: string) => string | null;
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

const proposalVersion = (revision: number) => `proposal-${revision}`;

const nextProposalVersion = (version: string) =>
  proposalVersion(Number(version.replace(/^proposal-/, '')) + 1);

const evidenceOf = (incident: LessonIncident): LessonEvidence => ({
  incidentId: incident.id,
  kind: incident.kind,
  summary: incident.summary,
  at: incident.at,
  sessionId: incident.sessionId,
  runId: incident.runId,
  workflowRunId: incident.workflowRunId,
});

const isProjectScope = (scope: LessonScope) =>
  scope.kind === 'repository' && !GITHUB_REPOSITORY_PATTERN.test(scope.value);

export class LessonService {
  private readonly controller = new AbortController();
  private readonly now: () => Date;
  private readonly injected = new Map<string, string>();
  private readonly folders = new Map<
    string,
    { at: number; read: LessonFolderRead }
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
    const files = this.allFiles();
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
      lessons: [
        ...store.proposals(),
        ...files.lessons.map(file => this.withChange(file.lesson)),
      ],
      issues: [
        ...files.lessons
          .filter(file => !this.isOwnerApproved(file.lesson))
          .map(
            file =>
              `${file.lesson.location?.path ?? file.lesson.title}: this project lesson was not written by your decision in Nesvo, so it is not added to prompts. Keep it to approve the current text.`,
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
    const proposal = this.ports.store.proposalRecord(input.lessonId);
    if (proposal) {
      if (proposal.version !== input.expectedVersion)
        throw this.changed();
      await this.decideProposal(proposal, input);
    } else {
      const file = this.allFiles().lessons.find(
        item => item.lesson.id === input.lessonId,
      );
      if (!file) throw new LessonError('not-found', 'Lesson not found.');
      if (file.lesson.version !== input.expectedVersion) throw this.changed();
      await this.decideFile(file, input);
    }
    this.folders.clear();
    return this.overview();
  }

  instructions(session: Session): string | null {
    const block = this.blockFor(this.contextOf(session));
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
    return block;
  }

  blockFor(context: LessonContext): string | null {
    try {
      return ownerLessonsBlock(
        applicableLessons(this.lessonsFor(context), context, this.now()),
      );
    } catch {
      return null;
    }
  }

  reviewConventions(
    draft: Pick<ReviewDraft, 'directory' | 'reference'>,
  ): ReviewConvention[] {
    const context: LessonContext = {
      directories: [draft.directory],
      repository: draft.reference.repository,
      role: 'reviewer',
      workflow: null,
    };
    try {
      return applicableLessons(
        this.lessonsFor(context),
        context,
        this.now(),
      ).map(lesson => ({
        id: lesson.id,
        layer: 'global',
        scope: '',
        text: `Owner lesson: ${lessonLine(lesson).slice(2)}`.slice(
          0,
          codeReviewLimits.conventionText,
        ),
        createdAt: lesson.createdAt,
        updatedAt: lesson.updatedAt,
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

  private changed(): LessonError {
    return new LessonError(
      'invalid-request',
      'This lesson changed. Refresh and try again.',
    );
  }

  private contextOf(session: Session): LessonContext {
    return {
      directories: [
        session.directory,
        ...(session.worktree ? [session.worktree.projectDirectory] : []),
      ],
      repository: session.pullRequest?.repository ?? null,
      role: session.role,
      workflow: session.workflowRunId
        ? (this.ports.workflowName?.(session.workflowRunId) ?? null)
        : null,
    };
  }

  private globalRoot(): LessonRoot {
    return { scope: 'global', root: globalLessonRoot() };
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

  private readFolder(root: LessonRoot, projectRoot: string | null) {
    const key = `${root.scope}:${pathKey(root.root)}`;
    const cached = this.folders.get(key);
    const now = Date.now();
    if (cached && now - cached.at < FOLDER_CACHE_MS) return cached.read;
    const read = readLessonFolder(root, projectRoot);
    this.folders.set(key, { at: now, read });
    return read;
  }

  private filesIn(projectRoots: readonly string[]): LessonFolderRead {
    const global = this.globalRoot();
    const reads = [
      ...projectRoots
        .filter(
          projectRoot =>
            pathKey(projectLessonRoot(projectRoot)) !== pathKey(global.root),
        )
        .map(projectRoot =>
          this.readFolder(
            { scope: 'project', root: projectLessonRoot(projectRoot) },
            projectRoot,
          ),
        ),
      this.readFolder(global, null),
    ];
    const seen = new Set<string>();
    const lessons: StoredLessonFile[] = [];
    for (const read of reads)
      for (const file of read.lessons) {
        if (seen.has(file.lesson.id)) continue;
        seen.add(file.lesson.id);
        lessons.push(file);
      }
    return { lessons, issues: reads.flatMap(read => read.issues) };
  }

  private allFiles(): LessonFolderRead {
    const directories = [
      ...(this.ports.directories?.() ?? []),
      ...this.ports.store
        .incidents()
        .map(incident => incident.directory)
        .filter(directory => directory !== null),
    ];
    return this.filesIn(this.projectRoots(directories));
  }

  private lessonsFor(context: LessonContext): Lesson[] {
    return this.filesIn(this.projectRoots(context.directories))
      .lessons.filter(file => this.isOwnerApproved(file.lesson))
      .map(file => file.lesson);
  }

  private isOwnerApproved(lesson: Lesson): boolean {
    if (lesson.location?.scope !== 'project') return true;
    const latest = this.ports.changes.latest(lesson.id);
    return (
      latest?.createdBy === 'owner' &&
      latest.after?.type === 'hash' &&
      latest.after.hash === lesson.version
    );
  }

  private withChange(lesson: Lesson): Lesson {
    if (!lesson.location) return lesson;
    const latest = this.ports.changes.latest(lesson.id);
    return {
      ...lesson,
      location: { ...lesson.location, changeId: latest?.changeId ?? null },
    };
  }

  private async decideProposal(
    proposal: Lesson,
    input: DecideLessonInput,
  ): Promise<void> {
    const { store } = this.ports;
    const at = this.now().toISOString();
    const edited: Lesson = {
      ...proposal,
      title: input.title ?? proposal.title,
      rule: input.rule ?? proposal.rule,
      scope: input.scope ?? proposal.scope,
      reviewAt: input.reviewAt ?? proposal.reviewAt,
      version: nextProposalVersion(proposal.version),
      updatedAt: at,
    };
    if (input.reviewAt) this.requireFuture(input.reviewAt);
    if (input.decision === 'edit' || input.decision === 'reject') {
      if (proposal.status === 'rejected')
        throw new LessonError(
          'invalid-request',
          'A rejected proposal cannot be changed.',
        );
      const next: Lesson =
        input.decision === 'reject'
          ? { ...edited, status: 'rejected', decidedAt: at }
          : edited;
      if (!store.replaceProposal(next, proposal.version)) throw this.changed();
      return;
    }
    if (input.decision !== 'approve')
      throw new LessonError(
        'invalid-request',
        input.decision === 'undo'
          ? 'Only an approved lesson file has changes to undo.'
          : 'Only an approved lesson can be retired. Reject the proposal instead.',
      );
    if (proposal.status === 'rejected')
      throw new LessonError(
        'invalid-request',
        'A rejected proposal cannot be approved.',
      );
    const document: LessonFileDocument = {
      id: proposal.id,
      title: edited.title,
      rule: edited.rule,
      scope: edited.scope,
      status: 'approved',
      reviewAt: this.reviewDate(edited.reviewAt),
      approvedAt: at,
      proposalId: proposal.proposalId,
      evidence: proposal.evidence,
    };
    const target = this.targetFor(document.scope);
    const outcome = await this.ports.changes.applyLesson(
      {
        conversationId: proposal.id,
        messageId: randomUUID(),
        directory: target.directory,
      },
      {
        op: 'create',
        scope: target.scope,
        name: lessonFileName(document.title, document.id),
        basedOnHash: null,
        document: serializeLesson(
          document,
          target.scope === 'project' ? target.directory : null,
        ),
        summary: `Approve lesson: ${document.title}`,
        validate: this.validator(target),
      },
    );
    this.requireApplied(outcome);
    store.deleteProposal(proposal.id, proposal.version);
  }

  private async decideFile(
    file: StoredLessonFile,
    input: DecideLessonInput,
  ): Promise<void> {
    const location = file.lesson.location!;
    if (input.decision === 'undo') {
      const latest = this.ports.changes.latest(file.lesson.id);
      if (!latest)
        throw new LessonError(
          'invalid-request',
          'This lesson has no change from Nesvo to undo.',
        );
      const result = await this.ports.changes.undo({
        conversationId: file.lesson.id,
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
    if (input.reviewAt) this.requireFuture(input.reviewAt);
    const scope = input.scope ?? file.document.scope;
    if (isProjectScope(scope) !== (location.scope === 'project'))
      throw new LessonError(
        'invalid-request',
        'This scope belongs in another workflows folder. Retire the lesson and approve a new one instead.',
      );
    if (input.decision === 'retire' && file.document.status !== 'approved')
      throw new LessonError(
        'invalid-request',
        'Only an approved lesson can be retired.',
      );
    if (input.decision === 'approve' && file.document.status !== 'approved')
      throw new LessonError(
        'invalid-request',
        'A retired lesson stays retired. Approve a new proposal instead.',
      );
    const document: LessonFileDocument = {
      ...file.document,
      title: input.title ?? file.document.title,
      rule: input.rule ?? file.document.rule,
      scope,
      status: input.decision === 'retire' ? 'retired' : file.document.status,
      reviewAt:
        input.decision === 'approve'
          ? this.reviewDate(input.reviewAt ?? null)
          : (input.reviewAt ?? file.document.reviewAt),
      approvedAt:
        input.decision === 'approve'
          ? this.now().toISOString()
          : file.document.approvedAt,
    };
    const target = {
      scope: location.scope,
      directory:
        location.scope === 'project'
          ? dirname(dirname(location.root))
          : this.globalDirectory(),
    };
    const outcome = await this.ports.changes.applyLesson(
      {
        conversationId: file.lesson.id,
        messageId: randomUUID(),
        directory: target.directory,
      },
      {
        op: 'update',
        scope: location.scope,
        name: location.name,
        basedOnHash: file.lesson.version,
        document: serializeLesson(
          document,
          location.scope === 'project' ? target.directory : null,
        ),
        summary: `${input.decision === 'retire' ? 'Retire' : input.decision === 'approve' ? 'Keep' : 'Edit'} lesson: ${document.title}`,
        validate: this.validator(target),
      },
    );
    this.requireApplied(outcome);
  }

  private validator(target: {
    scope: LessonRoot['scope'];
    directory: string;
  }) {
    const root: LessonRoot =
      target.scope === 'project'
        ? { scope: 'project', root: target.directory }
        : this.globalRoot();
    return (document: string) => {
      const parsed = parseLessonDocument(document, root);
      return parsed.valid ? [] : parsed.issues;
    };
  }

  private targetFor(scope: LessonScope): {
    scope: LessonRoot['scope'];
    directory: string;
  } {
    if (isProjectScope(scope) && scope.kind === 'repository') {
      const projectRoot = projectRootSync(scope.value);
      if (!projectRoot)
        throw new LessonError(
          'invalid-request',
          'The project folder of this lesson does not exist on this computer.',
        );
      return { scope: 'project', directory: projectRoot };
    }
    return { scope: 'global', directory: this.globalDirectory() };
  }

  private globalDirectory(): string {
    const directory = join(this.ports.dataDirectory, 'lessons');
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  private requireApplied(outcome: LessonChangeOutcome): void {
    if (outcome.status === 'applied') return;
    throw new LessonError(
      'invalid-request',
      outcome.issues[0]?.message ??
        (outcome.reason === 'conflict'
          ? 'The lesson file changed. Refresh and try again.'
          : 'The lesson file could not be written.'),
    );
  }

  private requireFuture(reviewAt: string): void {
    if (Date.parse(reviewAt) <= this.now().getTime())
      throw new LessonError(
        'invalid-request',
        'Choose a review date in the future.',
      );
  }

  private reviewDate(requested: string | null): string {
    const now = this.now().getTime();
    return requested && Date.parse(requested) > now
      ? requested
      : new Date(now + lessonLimits.defaultReviewDays * DAY_MS).toISOString();
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

  private async run(proposalId: string, startedAt: string): Promise<void> {
    const { store, sessions } = this.ports;
    const settings = store.settings();
    const incidents = store.pendingIncidents(lessonLimits.proposalIncidents);
    const existing = [
      ...store.proposals().filter(lesson => lesson.status === 'proposed'),
      ...this.allFiles()
        .lessons.map(file => file.lesson)
        .filter(lesson => lesson.status === 'approved'),
    ];
    let sessionId: string | null = null;
    try {
      const directory = this.globalDirectory();
      const session = await sessions.createWithEffort(
        {
          requestId: derivedId('lesson-session', proposalId),
          title: `Lesson proposals · ${startedAt.slice(0, 10)}`,
          provider: settings.provider,
          model: settings.model,
          mode: 'read-only',
          directory,
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
      const now = this.now();
      const parsed = parseLessonProposal(
        outcome.structured,
        incidents,
        existing,
        now,
      );
      if (!parsed.valid) {
        this.finish({ status: 'invalid', error: parsed.error });
        return;
      }
      const byId = new Map(incidents.map(incident => [incident.id, incident]));
      const room = Math.max(0, lessonLimits.proposals - store.proposalCount());
      const accepted = parsed.lessons.slice(0, room);
      const at = now.toISOString();
      store.transact(() => {
        for (const lesson of accepted)
          store.insertProposal({
            id: derivedId(`lesson:${proposalId}`, lesson.rule),
            version: proposalVersion(1),
            status: 'proposed',
            location: null,
            title: lesson.title,
            rule: lesson.rule,
            scope: lesson.scope,
            evidence: lesson.evidence
              .map(id => byId.get(id))
              .filter(incident => incident !== undefined)
              .map(evidenceOf),
            reviewAt: lesson.reviewAt,
            proposalId,
            createdAt: at,
            updatedAt: at,
            decidedAt: null,
          });
        store.markProposed(
          incidents.map(incident => incident.id),
          at,
        );
      });
      this.finish({ status: 'idle', error: null, proposed: accepted.length });
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
