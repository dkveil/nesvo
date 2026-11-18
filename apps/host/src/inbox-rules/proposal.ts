import {
  inboxRuleLimits,
  type InboxRuleProposal,
  type InboxRuleValidation,
  type ProposeInboxRuleInput,
} from '@nesvo/contracts';
import { randomUUID } from 'node:crypto';
import type { SessionService } from '../sessions/service';
import { InboxRuleError } from './service';

const PROPOSAL_TIMEOUT_MS = 3 * 60_000;

export const INBOX_RULE_PROPOSAL_PROMPT = `You turn one sentence from the owner into a Nesvo Inbox rule file. Reply with the file only: YAML frontmatter between --- lines, then an optional short Markdown template body. Do not use tools.

Fields: name (lowercase letters, digits, inner hyphens), description, enabled (true), trigger, action, and the trigger fields below. Optional: show (list of diff, pull-request, plan, report, command), diff (uncommitted or branch), route (inbox, parent or both), on_unsupported (refuse or warn), repository, workflow, group, computer, providers (Claude Code, Codex), modes, kinds (manual, automation, workflow, child).

Triggers and their fields:
- command: pattern, a shell glob such as "git push*"
- pull-request: actions, a list of create, merge, comment, review
- mcp-tool: pattern, such as "mcp__github__*"
- plan-ready, stage-report, stage-question, session-finished: no extra field
- workflow-step: step (a name glob), phase (plan, pre-done or pre-push), or both
- ci-checks: status red or green
- files-changed: glob, such as "src/**/*.sql"
- run-cost: above_usd, a number

Actions: hold blocks until the owner approves or declines and only fits command, pull-request, mcp-tool, workflow-step or a pause after an event; notify adds an Inbox item without blocking; ask offers options (a list of at least two labels) and sends the answer to the session, and never fits command, pull-request, mcp-tool or workflow-step.

The body may use {{ session.title }}, {{ command }}, {{ pr }}, {{ step }}, {{ files }}, {{ checks }}, {{ cost }}, {{ report }}, {{ rule.name }}.`;

const extractRule = (reply: string) => {
  const fenced = /```(?:markdown|md|yaml)?\r?\n(---[\s\S]*?)```/.exec(reply);
  const text = fenced?.[1] ?? reply.slice(Math.max(0, reply.indexOf('---')));
  return text.trim() + '\n';
};

export const proposeInboxRule = async (
  sessions: SessionService,
  input: ProposeInboxRuleInput,
  validate: (text: string) => InboxRuleValidation,
  signal: AbortSignal,
): Promise<InboxRuleProposal> => {
  const directory = sessions.draftDirectory(input.directory ?? '');
  const session = sessions.create(
    {
      title: 'Describe an Inbox rule',
      directory,
      provider: input.provider,
      model: input.model,
      mode: 'read-only',
    },
    { origin: { kind: 'workflow-assistant' } },
  );
  const messageId = randomUUID();
  if (
    sessions.sendWorkflowTurn({
      sessionId: session.id,
      messageId,
      text: input.description,
      readOnly: true,
      assistant: true,
      assistantPrompt: INBOX_RULE_PROPOSAL_PROMPT,
    }) === 'busy'
  )
    throw new InboxRuleError(
      'busy',
      'Another session is using this folder. Try again when it has finished.',
    );
  const runId = sessions.snapshot(session.id)?.runId;
  if (!runId)
    throw new InboxRuleError('unavailable', 'The proposal turn did not start.');
  const timeout = AbortSignal.timeout(PROPOSAL_TIMEOUT_MS);
  const outcome = await Promise.race([
    sessions.finished(session.id, runId),
    new Promise<never>((_, reject) => {
      const abort = () =>
        reject(
          new InboxRuleError('unavailable', 'The proposal took too long.'),
        );
      timeout.addEventListener('abort', abort, { once: true });
      signal.addEventListener('abort', abort, { once: true });
    }),
  ]);
  if (outcome.state !== 'completed')
    throw new InboxRuleError(
      'unavailable',
      outcome.error ?? 'The model could not propose a rule.',
    );
  const reply = sessions.turnReply(session.id, messageId) ?? '';
  const text = extractRule(reply).slice(0, inboxRuleLimits.fileBytes);
  const validation = validate(text);
  return { text, rule: validation.rule, issues: validation.issues };
};
