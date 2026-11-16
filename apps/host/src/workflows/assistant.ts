import {
  ASSISTANT_CHANGE_FENCE,
  assistantOperationSchema,
  createSessionSchema,
  workflowAssistantLimits,
  workflowAssistantProposalEventSchema,
  type DefinitionCatalog,
  type DefinitionIssue,
  type DesktopEvent,
  type HostRequest,
  type ScheduledJob,
  type WorkflowAssistantDocument,
  type WorkflowAssistantProposalEvent,
  type WorkflowAssistantTurn,
  type Session,
} from '@nesvo/contracts';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  confirmCodexEffort,
  type RunFinished,
  type SessionService,
} from '../sessions/service';
import type { AssistantChanges, ChangeContext } from './assistant-changes';
import { DefinitionError } from './definitions';
import { filterResultText } from './evidence';
import {
  ASSISTANT_OPERATIONS_PER_TURN,
  ASSISTANT_SYSTEM_PROMPT,
  REPAIR_TEXT,
  firstTurnText,
  laterTurnText,
} from './wrapper';

const ASSISTANT_TITLE_PREFIX = 'Workflow assistant · ';
const TITLE_LIMIT = 100;

export type AssistantSendInput = Extract<
  HostRequest,
  { method: 'workflow-assistant-send' }
>['input'];

type AssistantSessions = Pick<
  SessionService,
  | 'create'
  | 'canStartWorkflowTurn'
  | 'onRunFinished'
  | 'sendWorkflowTurn'
  | 'turnState'
  | 'turnReply'
  | 'draftDirectory'
>;

type AssistantDefinitions = {
  loadCatalog: (
    directory: string,
    signal: AbortSignal,
  ) => Promise<DefinitionCatalog>;
};

type PendingTurn = {
  context: ChangeContext;
  request: string;
  reply: string;
  seen: number;
  valid: number;
  repaired: boolean;
  firstReply: string | null;
  chain: Promise<void>;
};

export class WorkflowAssistantError extends Error {
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

const CHANGE_FENCE_NAME = ASSISTANT_CHANGE_FENCE.replace('-', '[-_]?');
const CHANGE_OPENING = new RegExp(
  `\`\`\`(?:json[ \\t]+)?${CHANGE_FENCE_NAME}(?:[ \\t]+json)?[ \\t]*\\r?\\n`,
  'gi',
);
const CHANGE_BLOCK = new RegExp(
  `${CHANGE_OPENING.source}([\\s\\S]*?)^\`\`\``,
  'gim',
);
const FENCED = /^```[^\n]*\n([\s\S]*?)^```/gm;
const DEFINITION_TEXT =
  /^---[ \t]*$[\s\S]*?^name:[ \t]*\S[\s\S]*?^(?:type|steps):|^steps:[ \t]*\[/m;
const CHANGE_REQUEST = [
  /\b(?:create|add|make|build|set up|change|update|edit|modify|rename|delete|remove|insert|schedule|connect|replace)\b/i,
  /(?:^|[^\p{L}])(?:dodaj|utw[oó]rz|stw[oó]rz|zr[oó]b|zmie[nń]|usu[nń]|popraw|ustaw|zaplanuj)/iu,
];

export const changeBlocks = (body: string): string[] =>
  [...body.matchAll(CHANGE_BLOCK)].map(match => match[1] ?? '');

const openings = (body: string) => [...body.matchAll(CHANGE_OPENING)].length;

const describesDefinitions = (body: string) =>
  [...body.matchAll(FENCED)].some(match => DEFINITION_TEXT.test(match[1] ?? ''));

const needsRepair = (request: string, reply: string) =>
  CHANGE_REQUEST.some(pattern => pattern.test(request)) ||
  describesDefinitions(reply);

const NOTHING_CHANGED =
  'The assistant wrote no change block, even after it was asked again, so nothing changed. Ask again and name the change you want.';

const replyText = (body: string) =>
  bounded(
    filterResultText(
      body
        .replace(CHANGE_BLOCK, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
    ),
    workflowAssistantLimits.message,
  );

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const issueAt = (path: string, message: string): DefinitionIssue => ({
  severity: 'error',
  path,
  line: null,
  message,
});

export class WorkflowAssistant {
  private readonly pending = new Map<string, PendingTurn>();
  private readonly lastHash = new Map<string, string>();
  private readonly created = new Set<string>();
  private starting = false;
  private readonly work = new Set<Promise<void>>();
  private readonly settling = new Map<string, Promise<void>>();
  private readonly release: () => void;

  constructor(
    private readonly ports: {
      sessions: AssistantSessions;
      findSession: (sessionId: string) => Session | undefined;
      definitions: AssistantDefinitions;
      changes: AssistantChanges;
      automations: (directory: string) => ScheduledJob[];
      emit: (event: DesktopEvent) => void;
      signal: AbortSignal;
    },
  ) {
    this.release = ports.sessions.onRunFinished(run => this.finished(run));
  }

  async send(input: AssistantSendInput): Promise<WorkflowAssistantTurn> {
    if (this.starting)
      throw new WorkflowAssistantError(
        'busy',
        'The workflow assistant is already starting a turn. Try again shortly.',
      );
    this.starting = true;
    try {
      return await this.begin(input);
    } finally {
      this.starting = false;
    }
  }

  observe(session: Session): void {
    const turn = this.pending.get(session.id);
    if (!turn) return;
    const runId = session.messages.find(
      message => message.id === turn.reply && message.author === 'operator',
    )?.runId;
    const reply = session.messages.find(
      message => message.runId === runId && message.author === 'agent',
    );
    if (runId && reply) this.consume(turn, reply.body);
  }

  async close(): Promise<void> {
    this.release();
    await Promise.all([
      ...this.work,
      ...[...this.pending.values()].map(turn => turn.chain),
    ]);
  }

  private async begin(
    input: AssistantSendInput,
  ): Promise<WorkflowAssistantTurn> {
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
      await this.settling.get(existing.id);
      await this.ports.changes.idle(existing.id);
      return this.deliver(
        existing.id,
        directory,
        laterTurnText({
          view: input.context.view,
          automations: this.automations(directory),
          changes: this.ports.changes.history(existing.id).changes,
          document: changed,
          selection,
          text: input.text,
        }),
        changed,
        input.text,
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
        origin: { kind: 'workflow-assistant' },
      });
    this.created.add(session.id);
    return this.deliver(
      session.id,
      directory,
      firstTurnText({
        view: input.context.view,
        catalog,
        automations: this.automations(directory),
        document,
        selection,
        text: input.text,
      }),
      document,
      input.text,
    );
  }

  private automations(directory: string): ScheduledJob[] {
    try {
      return this.ports.automations(directory);
    } catch {
      return [];
    }
  }

  private deliver(
    sessionId: string,
    directory: string,
    text: string,
    document: WorkflowAssistantDocument | null,
    request: string,
  ): WorkflowAssistantTurn {
    const messageId = randomUUID();
    if (this.sendTurn(sessionId, messageId, text) === 'busy') throw this.busy();
    if (document) this.lastHash.set(sessionId, document.contentHash);
    this.pending.set(sessionId, {
      context: { conversationId: sessionId, messageId, directory },
      request,
      reply: messageId,
      seen: 0,
      valid: 0,
      repaired: false,
      firstReply: null,
      chain: Promise.resolve(),
    });
    return { sessionId, messageId };
  }

  private sendTurn(sessionId: string, messageId: string, text: string) {
    return this.ports.sessions.sendWorkflowTurn({
      sessionId,
      messageId,
      text,
      readOnly: true,
      assistant: true,
      assistantPrompt: ASSISTANT_SYSTEM_PROMPT,
    });
  }

  private consume(turn: PendingTurn, body: string): void {
    const blocks = changeBlocks(body);
    for (; turn.seen < blocks.length; turn.seen++) {
      const block = blocks[turn.seen] ?? '';
      const index = turn.seen;
      turn.chain = turn.chain.then(() => this.applyBlock(turn, block, index));
    }
  }

  private async applyBlock(
    turn: PendingTurn,
    block: string,
    index: number,
  ): Promise<void> {
    const refuse = (message: string) =>
      this.ports.changes.refuse(turn.context, {
        kind: null,
        op: null,
        target: null,
        summary: '',
        reason: 'invalid',
        issues: [issueAt('', message)],
      });
    if (index >= ASSISTANT_OPERATIONS_PER_TURN) {
      if (index === ASSISTANT_OPERATIONS_PER_TURN)
        refuse(
          `An answer can apply at most ${ASSISTANT_OPERATIONS_PER_TURN} changes; the remaining change blocks were ignored.`,
        );
      return;
    }
    const parsed = assistantOperationSchema.safeParse(parseJson(block));
    if (parsed.success) turn.valid++;
    if (!parsed.success) {
      refuse(
        `Change block ${index + 1} is not a valid change: ${parsed.error.issues[0]?.message ?? 'invalid JSON'}.`,
      );
      return;
    }
    await this.ports.changes
      .apply(turn.context, parsed.data)
      .catch(() =>
        refuse(`Change block ${index + 1} could not be applied. Try again.`),
      );
  }
  private sessionInput(input: AssistantSendInput, directory: string) {
    const parsed = createSessionSchema.safeParse({
      title: bounded(
        `${ASSISTANT_TITLE_PREFIX}${input.context.workflowName ?? (basename(directory) || directory)}`,
        TITLE_LIMIT,
      ),
      provider: input.provider,
      model: input.model,
      mode: 'read-only',
      directory,
      ...(input.effort ? { effort: input.effort } : {}),
    });
    if (!parsed.success)
      throw new WorkflowAssistantError(
        'invalid-request',
        parsed.error.issues[0]?.message ??
          'The provider, model or effort is not supported.',
      );
    return parsed.data;
  }

  private continued(sessionId: string, directory: string): Session {
    const session = this.ports.findSession(sessionId);
    if (!session || !this.isAssistant(session))
      throw new WorkflowAssistantError(
        'invalid-request',
        'This session is not a workflow assistant conversation on this computer.',
      );
    if (session.directory !== directory)
      throw new WorkflowAssistantError(
        'invalid-request',
        'This assistant conversation belongs to another folder.',
      );
    return session;
  }

  private isAssistant(session: Session): boolean {
    return (
      session.workflowRunId === null &&
      session.scheduledJobId === null &&
      session.parentId === null &&
      session.mode === 'read-only' &&
      !session.delegationEnabled &&
      (this.created.has(session.id) ||
        session.messages.find(message => message.author === 'operator')
          ?.origin === 'workflow')
    );
  }

  private resolveDirectory(directory: string): string {
    if (!directory)
      throw new WorkflowAssistantError(
        'invalid-directory',
        'Choose a project folder for the workflow assistant.',
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
      throw new WorkflowAssistantError(
        error instanceof DefinitionError && error.kind === 'not-found'
          ? 'invalid-directory'
          : 'unavailable',
        error instanceof DefinitionError
          ? error.message
          : 'Workflow definitions could not be read. Verify the folder and try again.',
      );
    }
  }

  private ensureIdle(): void {
    if (!this.ports.sessions.canStartWorkflowTurn()) throw this.busy();
  }

  private busy(): WorkflowAssistantError {
    return new WorkflowAssistantError(
      'busy',
      'Another session is working on this computer.',
    );
  }

  private finished(run: RunFinished): void {
    const turn = this.pending.get(run.sessionId);
    if (!turn) return;
    const state = this.ports.sessions.turnState(run.sessionId, turn.reply);
    if (state === 'running') return;
    this.pending.delete(run.sessionId);
    const announce = this.announce(turn, state === 'completed').catch(
      () => undefined,
    );
    this.work.add(announce);
    this.settling.set(run.sessionId, announce);
    void announce.finally(() => {
      this.work.delete(announce);
      if (this.settling.get(run.sessionId) === announce)
        this.settling.delete(run.sessionId);
    });
  }

  private async announce(turn: PendingTurn, completed: boolean): Promise<void> {
    const { conversationId: sessionId, messageId } = turn.context;
    const reply = completed
      ? this.ports.sessions.turnReply(sessionId, turn.reply)
      : null;
    if (reply !== null) {
      this.consume(turn, reply);
      if (openings(reply) > changeBlocks(reply).length)
        this.refuseTurn(
          turn,
          'A change block was not closed, so it was not applied.',
        );
    }
    await turn.chain;
    await this.ports.changes.idle(sessionId);
    if (reply !== null && turn.valid === 0) {
      if (!turn.repaired && needsRepair(turn.request, reply)) {
        if (this.repair(turn, reply)) return;
      } else if (turn.repaired) {
        this.refuseTurn(turn, NOTHING_CHANGED);
        this.publish({
          sessionId,
          messageId,
          status: 'invalid',
          proposal: null,
          issues: [],
        });
        return;
      }
    }
    const message = [reply, turn.firstReply]
      .map(text => (text === null ? '' : replyText(text)))
      .find(text => text.length > 0);
    this.publish({
      sessionId,
      messageId,
      status: reply === null ? 'invalid' : 'ok',
      proposal: reply === null ? null : { message: message ?? '', changes: [] },
      issues: [],
    });
  }

  private repair(turn: PendingTurn, reply: string): boolean {
    const repairId = randomUUID();
    const { conversationId: sessionId } = turn.context;
    let sent: 'sent' | 'busy';
    try {
      sent = this.sendTurn(sessionId, repairId, REPAIR_TEXT);
    } catch {
      sent = 'busy';
    }
    if (sent === 'busy') {
      this.refuseTurn(
        turn,
        'The assistant wrote no change block and the repair turn could not start, so nothing changed.',
      );
      return false;
    }
    this.pending.set(sessionId, {
      ...turn,
      reply: repairId,
      seen: 0,
      repaired: true,
      firstReply: reply,
      chain: Promise.resolve(),
    });
    return true;
  }

  private refuseTurn(turn: PendingTurn, message: string): void {
    this.ports.changes.refuse(turn.context, {
      kind: null,
      op: null,
      target: null,
      summary: '',
      reason: 'invalid',
      issues: [issueAt('', message)],
    });
  }

  private publish(event: WorkflowAssistantProposalEvent): void {
    const parsed = workflowAssistantProposalEventSchema.safeParse(event);
    this.ports.emit({
      type: 'workflow-assistant-proposal',
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
}
