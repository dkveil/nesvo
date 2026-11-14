import {
  createSessionSchema,
  pipelineAssistantLimits,
  pipelineAssistantProposalEventSchema,
  pipelineAssistantProposalJsonSchema,
  pipelineAssistantProposalSchema,
  type DefinitionCatalog,
  type DefinitionIssue,
  type DesktopEvent,
  type GraphStep,
  type HostRequest,
  type PipelineAssistantChange,
  type PipelineAssistantDocument,
  type PipelineAssistantProposal,
  type PipelineAssistantProposalEvent,
  type PipelineAssistantTurn,
  type Provider,
  type Session,
} from '@nesvo/contracts';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import {
  confirmCodexEffort,
  type RunFinished,
  type SessionService,
} from '../sessions/service';
import {
  DefinitionError,
  checkDocument,
  checkGraph,
  type DocumentCheck,
  type WriteRoots,
} from './definitions';
import { filterResultText } from './evidence';
import { checkFileText } from './writer';
import { firstTurnText, laterTurnText, type AnswerPath } from './wrapper';

const ASSISTANT_TITLE_PREFIX = 'Pipeline assistant · ';
const TITLE_LIMIT = 100;
const FENCED_JSON = /^```json[ \t]*\n([\s\S]*?)^```[ \t]*$/m;

export type AssistantSendInput = Extract<
  HostRequest,
  { method: 'pipeline-assistant-send' }
>['input'];

type AssistantSessions = Pick<
  SessionService,
  | 'create'
  | 'canStartPipelineTurn'
  | 'onRunFinished'
  | 'sendPipelineTurn'
  | 'turnState'
  | 'turnReply'
  | 'finished'
  | 'draftDirectory'
>;

type AssistantDefinitions = {
  loadCatalog: (
    directory: string,
    signal: AbortSignal,
  ) => Promise<DefinitionCatalog>;
  resolveWriteRoots: (
    directory: string,
    signal: AbortSignal,
  ) => Promise<WriteRoots>;
};

type PendingTurn = { messageId: string; directory: string };

type ChangeIssues = PipelineAssistantProposalEvent['issues'][number];

export class PipelineAssistantError extends Error {
  constructor(
    readonly code:
      | 'busy'
      | 'invalid-request'
      | 'invalid-directory'
      | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

const bounded = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const extractProposal = (
  text: string,
  structured?: unknown,
): PipelineAssistantProposal | null => {
  const block = FENCED_JSON.exec(text)?.[1];
  const candidate =
    structured ?? (block === undefined ? parseJson(text) : parseJson(block));
  const parsed = pipelineAssistantProposalSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

const filterProposal = (
  proposal: PipelineAssistantProposal,
): PipelineAssistantProposal => ({
  message: bounded(
    filterResultText(proposal.message),
    pipelineAssistantLimits.message,
  ),
  changes: proposal.changes.map(change => ({
    ...change,
    summary: bounded(
      filterResultText(change.summary),
      pipelineAssistantLimits.summary,
    ),
  })),
});

const issueAt = (path: string, message: string): DefinitionIssue => ({
  severity: 'error',
  path,
  line: null,
  message,
});

const isError = (issue: DefinitionIssue) => issue.severity === 'error';

const answerPath = (provider: Provider): AnswerPath =>
  provider === 'Claude Code' ? 'structured' : 'fenced';

type ChangeCheck = {
  change: PipelineAssistantChange;
  path: string;
  checked: DocumentCheck | null;
  issues: DefinitionIssue[];
};

const pipelineIssues = (
  { change, path, checked, issues }: ChangeCheck,
  definitions: ReadonlyMap<string, GraphStep>,
): DefinitionIssue[] => {
  if (change.kind !== 'pipeline' || !checked || issues.some(isError))
    return [];
  const missing = checked.steps
    .filter(name => !definitions.has(name))
    .map(name => issueAt(path, `Step "${name}" does not exist or is invalid`));
  if (missing.length) return missing;
  return checkGraph(
    {
      name: change.name,
      steps: checked.steps,
      edges: checked.edges,
      layout: checked.layout,
    },
    path,
    checked.lines,
    definitions,
  ).issues;
};

export class PipelineAssistant {
  private readonly pending = new Map<string, PendingTurn>();
  private readonly lastHash = new Map<string, string>();
  private readonly created = new Set<string>();
  private starting = false;
  private readonly work = new Set<Promise<void>>();
  private readonly release: () => void;

  constructor(
    private readonly ports: {
      sessions: AssistantSessions;
      findSession: (sessionId: string) => Session | undefined;
      definitions: AssistantDefinitions;
      emit: (event: DesktopEvent) => void;
      signal: AbortSignal;
    },
  ) {
    this.release = ports.sessions.onRunFinished(run => this.finished(run));
  }

  async send(input: AssistantSendInput): Promise<PipelineAssistantTurn> {
    if (this.starting)
      throw new PipelineAssistantError(
        'busy',
        'The pipeline assistant is already starting a turn. Try again shortly.',
      );
    this.starting = true;
    try {
      return await this.begin(input);
    } finally {
      this.starting = false;
    }
  }

  async close(): Promise<void> {
    this.release();
    await Promise.all(this.work);
  }

  private async begin(
    input: AssistantSendInput,
  ): Promise<PipelineAssistantTurn> {
    this.ensureIdle();
    const directory = this.resolveDirectory(input.context.directory);
    const { document, selection } = input.context;
    const existing = input.sessionId
      ? this.continued(input.sessionId, directory)
      : null;
    if (existing?.providerInitialized) {
      const changed =
        document && this.lastHash.get(existing.id) !== document.contentHash
          ? document
          : null;
      const answer = answerPath(existing.provider);
      return this.deliver(
        existing.id,
        directory,
        answer,
        laterTurnText({
          answer,
          document: changed,
          selection,
          text: input.text,
        }),
        changed,
      );
    }
    const sessionInput = existing ? null : this.sessionInput(input, directory);
    if (sessionInput?.effort)
      await confirmCodexEffort(
        sessionInput.model,
        sessionInput.effort,
        this.ports.signal,
      );
    const catalog = await this.loadCatalog(directory);
    this.ensureIdle();
    const session =
      existing ??
      this.ports.sessions.create(sessionInput!, {
        origin: { kind: 'pipeline-assistant' },
      });
    this.created.add(session.id);
    const answer = answerPath(session.provider);
    return this.deliver(
      session.id,
      directory,
      answer,
      firstTurnText({ answer, catalog, document, selection, text: input.text }),
      document,
    );
  }

  private deliver(
    sessionId: string,
    directory: string,
    answer: AnswerPath,
    text: string,
    document: PipelineAssistantDocument | null,
  ): PipelineAssistantTurn {
    const messageId = randomUUID();
    const sent = this.ports.sessions.sendPipelineTurn({
      sessionId,
      messageId,
      text,
      readOnly: true,
      assistant: true,
      ...(answer === 'structured'
        ? { outputSchema: pipelineAssistantProposalJsonSchema() }
        : {}),
    });
    if (sent === 'busy') throw this.busy();
    if (document) this.lastHash.set(sessionId, document.contentHash);
    this.pending.set(sessionId, { messageId, directory });
    return { sessionId, messageId };
  }

  private sessionInput(input: AssistantSendInput, directory: string) {
    const parsed = createSessionSchema.safeParse({
      title: bounded(
        `${ASSISTANT_TITLE_PREFIX}${input.context.pipelineName ?? (basename(directory) || directory)}`,
        TITLE_LIMIT,
      ),
      provider: input.provider,
      model: input.model,
      mode: 'read-only',
      directory,
      ...(input.effort ? { effort: input.effort } : {}),
    });
    if (!parsed.success)
      throw new PipelineAssistantError(
        'invalid-request',
        parsed.error.issues[0]?.message ??
          'The provider, model or effort is not supported.',
      );
    return parsed.data;
  }

  private continued(sessionId: string, directory: string): Session {
    const session = this.ports.findSession(sessionId);
    if (!session || !this.isAssistant(session))
      throw new PipelineAssistantError(
        'invalid-request',
        'This session is not a pipeline assistant conversation on this computer.',
      );
    if (session.directory !== directory)
      throw new PipelineAssistantError(
        'invalid-request',
        'This assistant conversation belongs to another folder.',
      );
    return session;
  }

  private isAssistant(session: Session): boolean {
    return (
      session.pipelineRunId === null &&
      session.scheduledJobId === null &&
      session.parentId === null &&
      session.mode === 'read-only' &&
      !session.delegationEnabled &&
      (this.created.has(session.id) ||
        session.messages.find(message => message.author === 'operator')
          ?.origin === 'pipeline')
    );
  }

  private resolveDirectory(directory: string): string {
    if (!directory)
      throw new PipelineAssistantError(
        'invalid-directory',
        'Choose a project folder for the pipeline assistant.',
      );
    return this.ports.sessions.draftDirectory(directory);
  }

  private async loadCatalog(directory: string): Promise<DefinitionCatalog> {
    try {
      return await this.ports.definitions.loadCatalog(
        directory,
        this.ports.signal,
      );
    } catch (error) {
      throw new PipelineAssistantError(
        error instanceof DefinitionError && error.kind === 'not-found'
          ? 'invalid-directory'
          : 'unavailable',
        error instanceof DefinitionError
          ? error.message
          : 'Pipeline definitions could not be read. Verify the folder and try again.',
      );
    }
  }

  private ensureIdle(): void {
    if (!this.ports.sessions.canStartPipelineTurn()) throw this.busy();
  }

  private busy(): PipelineAssistantError {
    return new PipelineAssistantError(
      'busy',
      'Another session is working on this computer.',
    );
  }

  private finished(run: RunFinished): void {
    const turn = this.pending.get(run.sessionId);
    if (!turn) return;
    const state = this.ports.sessions.turnState(run.sessionId, turn.messageId);
    if (state === 'running') return;
    this.pending.delete(run.sessionId);
    const announce = this.announce(
      run,
      turn,
      state === 'completed',
    ).catch(() => undefined);
    this.work.add(announce);
    void announce.finally(() => this.work.delete(announce));
  }

  private async read(
    run: RunFinished,
    turn: PendingTurn,
  ): Promise<PipelineAssistantProposal | null> {
    const reply = this.ports.sessions.turnReply(run.sessionId, turn.messageId);
    const outcome = await this.ports.sessions
      .finished(run.sessionId, run.runId)
      .catch(() => null);
    return extractProposal(reply ?? '', outcome?.structured);
  }

  private async announce(
    run: RunFinished,
    turn: PendingTurn,
    completed: boolean,
  ): Promise<void> {
    const event = { sessionId: run.sessionId, messageId: turn.messageId };
    const proposal = completed ? await this.read(run, turn) : null;
    if (!proposal) {
      this.publish({ ...event, status: 'invalid', proposal: null, issues: [] });
      return;
    }
    const filtered = filterProposal(proposal);
    this.publish({
      ...event,
      status: 'ok',
      proposal: filtered,
      issues: await this.validate(filtered.changes, turn.directory),
    });
  }

  private publish(event: PipelineAssistantProposalEvent): void {
    const parsed = pipelineAssistantProposalEventSchema.safeParse(event);
    this.ports.emit({
      type: 'pipeline-assistant-proposal',
      ...(parsed.success
        ? parsed.data
        : {
            sessionId: event.sessionId,
            messageId: event.messageId,
            status: 'invalid',
            proposal: null,
            issues: [],
          }),
    });
  }

  private async validate(
    changes: readonly PipelineAssistantChange[],
    directory: string,
  ): Promise<ChangeIssues[]> {
    let roots: WriteRoots;
    let catalog: DefinitionCatalog | null = null;
    try {
      roots = await this.ports.definitions.resolveWriteRoots(
        directory,
        this.ports.signal,
      );
      if (changes.some(change => change.kind === 'pipeline'))
        catalog = await this.ports.definitions.loadCatalog(
          directory,
          this.ports.signal,
        );
    } catch {
      return changes.map((change, index) => ({
        index,
        issues: [
          issueAt(
            change.name,
            'The host could not check this change. Ask the assistant again.',
          ),
        ],
      }));
    }
    const checks = changes.map(change => {
      const root = change.scope === 'global' ? roots.global : roots.project;
      const path = join(root, `${change.kind}s`, `${change.name}.md`);
      const text = checkFileText(change.document, root);
      if (text.length) return { change, path, checked: null, issues: text };
      const checked = checkDocument(change.kind, path, change.document);
      const issues = [...checked.issues];
      if (checked.name !== null && checked.name !== change.name)
        issues.push(
          issueAt(
            path,
            `Field "name" must be "${change.name}" to match the file name`,
          ),
        );
      return { change, path, checked, issues };
    });
    const projectSteps = new Set(
      catalog?.steps
        .filter(step => step.source.scope === 'project')
        .map(step => step.name),
    );
    const proposed = (scope: PipelineAssistantChange['scope']) =>
      checks.flatMap(check =>
        check.change.scope === scope &&
        check.checked?.step &&
        !check.issues.some(isError) &&
        !(scope === 'global' && projectSteps.has(check.change.name))
          ? [[check.change.name, check.checked.step] as const]
          : [],
      );
    const definitions = new Map<string, GraphStep>([
      ...(catalog?.steps.map(step => [step.name, step] as const) ?? []),
      ...proposed('global'),
      ...proposed('project'),
    ]);
    return checks.map((check, index) => ({
      index,
      issues: [...check.issues, ...pipelineIssues(check, definitions)].slice(
        0,
        pipelineAssistantLimits.changeIssues,
      ),
    }));
  }
}
