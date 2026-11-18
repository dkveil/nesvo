import { z } from 'zod';
import { decisionRouteSchema } from './decision-route';
import { pullRequestReferenceSchema } from './pull-requests';
import { providerSchema, sessionModeSchema } from './sessions';
import { stageReportSchema } from './stage-report';
import { definitionHashSchema } from './workflows/definitions';

export const inboxRuleLimits = {
  name: 64,
  description: 500,
  template: 4000,
  pattern: 300,
  options: 6,
  optionLabel: 200,
  note: 2000,
  rules: 100,
  items: 200,
  fileBytes: 32 * 1024,
  describe: 2000,
  diffFiles: 200,
  issues: 100,
  issueMessage: 500,
  path: 4096,
} as const;

export const inboxRuleTriggerSchema = z.enum([
  'command',
  'pull-request',
  'mcp-tool',
  'plan-ready',
  'stage-report',
  'stage-question',
  'workflow-step',
  'session-finished',
  'ci-checks',
  'files-changed',
  'run-cost',
]);
export type InboxRuleTrigger = z.infer<typeof inboxRuleTriggerSchema>;

export const gatingInboxRuleTriggers = [
  'command',
  'pull-request',
  'mcp-tool',
  'workflow-step',
] as const satisfies readonly InboxRuleTrigger[];

export const isGatingTrigger = (trigger: InboxRuleTrigger) =>
  (gatingInboxRuleTriggers as readonly InboxRuleTrigger[]).includes(trigger);

export const inboxRuleActionSchema = z.enum(['hold', 'notify', 'ask']);
export type InboxRuleAction = z.infer<typeof inboxRuleActionSchema>;

export const inboxRulePresentationSchema = z.enum([
  'diff',
  'pull-request',
  'plan',
  'report',
  'command',
]);
export type InboxRulePresentation = z.infer<typeof inboxRulePresentationSchema>;

export const pullRequestRuleActionSchema = z.enum([
  'create',
  'merge',
  'comment',
  'review',
]);
export type PullRequestRuleAction = z.infer<typeof pullRequestRuleActionSchema>;

export const inboxRuleSessionKindSchema = z.enum([
  'manual',
  'automation',
  'workflow',
  'child',
]);
export type InboxRuleSessionKind = z.infer<typeof inboxRuleSessionKindSchema>;

export const inboxRuleScopeSchema = z.enum(['global', 'project']);
export type InboxRuleScope = z.infer<typeof inboxRuleScopeSchema>;

export const INBOX_RULE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const patternSchema = z.string().trim().min(1).max(inboxRuleLimits.pattern);
const filterSchema = z.string().trim().min(1).max(inboxRuleLimits.pattern);

export const inboxRuleFieldsSchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .max(inboxRuleLimits.name)
      .regex(
        INBOX_RULE_NAME_PATTERN,
        'Use lowercase letters, digits and inner hyphens.',
      ),
    description: z.string().max(inboxRuleLimits.description).default(''),
    enabled: z.boolean().default(true),
    trigger: inboxRuleTriggerSchema,
    pattern: patternSchema.optional(),
    actions: z.array(pullRequestRuleActionSchema).min(1).max(4).optional(),
    step: patternSchema.optional(),
    phase: z.enum(['plan', 'pre-done', 'pre-push']).optional(),
    status: z.enum(['red', 'green']).optional(),
    glob: patternSchema.optional(),
    above_usd: z.number().positive().max(100_000).optional(),
    action: inboxRuleActionSchema,
    options: z
      .array(z.string().trim().min(1).max(inboxRuleLimits.optionLabel))
      .min(2)
      .max(inboxRuleLimits.options)
      .optional(),
    show: z.array(inboxRulePresentationSchema).max(5).default([]),
    diff: z.enum(['uncommitted', 'branch']).default('uncommitted'),
    route: decisionRouteSchema.optional(),
    on_unsupported: z.enum(['refuse', 'warn']).default('refuse'),
    repository: filterSchema.optional(),
    workflow: filterSchema.optional(),
    group: filterSchema.optional(),
    computer: filterSchema.optional(),
    providers: z.array(providerSchema).min(1).max(2).optional(),
    modes: z.array(sessionModeSchema).min(1).max(4).optional(),
    kinds: z.array(inboxRuleSessionKindSchema).min(1).max(4).optional(),
    body: z.string().max(inboxRuleLimits.template).default(''),
  })
  .superRefine((rule, context) => {
    const need = (field: keyof typeof rule, message: string) => {
      if (rule[field] === undefined)
        context.addIssue({ code: 'custom', path: [field], message });
    };
    const forbid = (field: keyof typeof rule, message: string) => {
      if (rule[field] !== undefined)
        context.addIssue({ code: 'custom', path: [field], message });
    };
    if (rule.trigger === 'command' || rule.trigger === 'mcp-tool')
      need('pattern', `A ${rule.trigger} rule needs a pattern.`);
    else forbid('pattern', 'Only command and mcp-tool rules use a pattern.');
    if (rule.trigger === 'pull-request')
      need('actions', 'A pull-request rule lists its actions.');
    else forbid('actions', 'Only pull-request rules list actions.');
    if (rule.trigger !== 'workflow-step') {
      forbid('step', 'Only workflow-step rules name a step.');
      forbid('phase', 'Only workflow-step rules name a phase.');
    } else if (rule.step === undefined && rule.phase === undefined)
      context.addIssue({
        code: 'custom',
        path: ['step'],
        message: 'A workflow-step rule names a step, a phase or both.',
      });
    if (rule.trigger === 'ci-checks')
      need('status', 'A ci-checks rule needs status red or green.');
    else forbid('status', 'Only ci-checks rules use a status.');
    if (rule.trigger === 'files-changed')
      need('glob', 'A files-changed rule needs a glob.');
    else forbid('glob', 'Only files-changed rules use a glob.');
    if (rule.trigger === 'run-cost')
      need('above_usd', 'A run-cost rule needs above_usd.');
    else forbid('above_usd', 'Only run-cost rules use above_usd.');
    if (rule.action === 'ask') {
      need('options', 'An ask rule offers at least two options.');
      if (isGatingTrigger(rule.trigger))
        context.addIssue({
          code: 'custom',
          path: ['action'],
          message:
            'Use hold before an action: an ask rule cannot block a command, tool, pull request or workflow step.',
        });
    } else forbid('options', 'Only ask rules offer options.');
  });
export type InboxRuleFields = z.input<typeof inboxRuleFieldsSchema>;
export type InboxRule = z.output<typeof inboxRuleFieldsSchema>;

export const inboxRuleIssueSchema = z.strictObject({
  severity: z.enum(['error', 'warning']),
  path: z.string().max(inboxRuleLimits.path),
  line: z.number().int().positive().nullable(),
  message: z.string().min(1).max(inboxRuleLimits.issueMessage),
});
export type InboxRuleIssue = z.infer<typeof inboxRuleIssueSchema>;

export const inboxRuleEnforcementSchema = z.strictObject({
  provider: providerSchema,
  modes: z.array(sessionModeSchema).max(4),
  status: z.enum(['enforced', 'unreachable', 'unsupported']),
  detail: z.string().max(500),
});
export type InboxRuleEnforcement = z.infer<typeof inboxRuleEnforcementSchema>;

export const inboxRuleEntrySchema = z.strictObject({
  scope: inboxRuleScopeSchema,
  path: z.string().max(inboxRuleLimits.path),
  contentHash: definitionHashSchema,
  text: z.string().max(inboxRuleLimits.fileBytes),
  name: z.string().max(200),
  rule: inboxRuleFieldsSchema.nullable(),
  active: z.boolean(),
  inactiveReason: z.string().max(500).nullable(),
  issues: z.array(inboxRuleIssueSchema).max(inboxRuleLimits.issues),
  enforcement: z.array(inboxRuleEnforcementSchema).max(8),
});
export type InboxRuleEntry = z.infer<typeof inboxRuleEntrySchema>;

export const inboxRuleCatalogSchema = z.strictObject({
  roots: z.strictObject({
    global: z.string().max(inboxRuleLimits.path),
    project: z.string().max(inboxRuleLimits.path).nullable(),
  }),
  projectTrust: z.enum(['none', 'trusted', 'untrusted']),
  rules: z.array(inboxRuleEntrySchema).max(inboxRuleLimits.rules * 2),
  issues: z.array(inboxRuleIssueSchema).max(inboxRuleLimits.issues),
  defaultRoute: decisionRouteSchema,
});
export type InboxRuleCatalog = z.infer<typeof inboxRuleCatalogSchema>;

const optionalDirectory = z.string().trim().min(1).max(4096).optional();

export const listInboxRulesSchema = z.strictObject({
  directory: optionalDirectory,
});
export type ListInboxRulesInput = z.infer<typeof listInboxRulesSchema>;

export const validateInboxRuleSchema = z.strictObject({
  text: z.string().max(inboxRuleLimits.fileBytes),
});
export type ValidateInboxRuleInput = z.infer<typeof validateInboxRuleSchema>;

export const inboxRuleValidationSchema = z.strictObject({
  rule: inboxRuleFieldsSchema.nullable(),
  issues: z.array(inboxRuleIssueSchema).max(inboxRuleLimits.issues),
});
export type InboxRuleValidation = z.infer<typeof inboxRuleValidationSchema>;

export const saveInboxRuleSchema = z.strictObject({
  scope: inboxRuleScopeSchema,
  directory: optionalDirectory,
  text: z.string().min(1).max(inboxRuleLimits.fileBytes),
  previousName: z.string().max(inboxRuleLimits.name).optional(),
  expectedHash: definitionHashSchema.nullable(),
});
export type SaveInboxRuleInput = z.infer<typeof saveInboxRuleSchema>;

export const deleteInboxRuleSchema = z.strictObject({
  scope: inboxRuleScopeSchema,
  directory: optionalDirectory,
  name: z.string().min(1).max(inboxRuleLimits.name),
  expectedHash: definitionHashSchema,
});
export type DeleteInboxRuleInput = z.infer<typeof deleteInboxRuleSchema>;

export const setInboxRuleEnabledSchema = deleteInboxRuleSchema.extend({
  enabled: z.boolean(),
});
export type SetInboxRuleEnabledInput = z.infer<
  typeof setInboxRuleEnabledSchema
>;

export const inboxSettingsSchema = z.strictObject({
  defaultRoute: decisionRouteSchema,
});
export type InboxSettings = z.infer<typeof inboxSettingsSchema>;

export const proposeInboxRuleSchema = z.strictObject({
  description: z.string().trim().min(1).max(inboxRuleLimits.describe),
  provider: providerSchema,
  model: z.string().trim().min(1).max(100),
  directory: optionalDirectory,
});
export type ProposeInboxRuleInput = z.infer<typeof proposeInboxRuleSchema>;

export const inboxRuleProposalSchema = z.strictObject({
  text: z.string().max(inboxRuleLimits.fileBytes),
  rule: inboxRuleFieldsSchema.nullable(),
  issues: z.array(inboxRuleIssueSchema).max(inboxRuleLimits.issues),
});
export type InboxRuleProposal = z.infer<typeof inboxRuleProposalSchema>;

export const inboxItemDiffSchema = z.strictObject({
  scope: z.enum(['uncommitted', 'branch']),
  files: z
    .array(
      z.strictObject({
        path: z.string().max(4096),
        additions: z.number().int().nonnegative().nullable(),
        deletions: z.number().int().nonnegative().nullable(),
      }),
    )
    .max(inboxRuleLimits.diffFiles),
  truncated: z.boolean(),
  error: z.string().max(500).nullable(),
});
export type InboxItemDiff = z.infer<typeof inboxItemDiffSchema>;

export const inboxItemPresentationSchema = z.strictObject({
  text: z.string().max(inboxRuleLimits.template),
  show: z.array(inboxRulePresentationSchema).max(5),
  command: z.string().max(8000).nullable(),
  diff: inboxItemDiffSchema.nullable(),
  pullRequest: pullRequestReferenceSchema.nullable(),
  plan: z.string().max(12_000).nullable(),
  report: stageReportSchema.nullable(),
});
export type InboxItemPresentation = z.infer<typeof inboxItemPresentationSchema>;

export const inboxItemStatusSchema = z.enum([
  'pending',
  'approved',
  'declined',
  'answered',
  'dismissed',
  'interrupted',
]);
export type InboxItemStatus = z.infer<typeof inboxItemStatusSchema>;

export const inboxDecisionChannelSchema = z.enum([
  'desktop',
  'mobile',
  'parent',
]);

export const inboxItemSchema = z.strictObject({
  id: z.uuid(),
  rule: z.strictObject({
    name: z.string().max(inboxRuleLimits.name),
    scope: inboxRuleScopeSchema,
    description: z.string().max(inboxRuleLimits.description),
  }),
  action: inboxRuleActionSchema,
  trigger: inboxRuleTriggerSchema,
  subject: z.string().max(500),
  binding: z.enum(['provider', 'pull-request', 'workflow-step', 'session']),
  sessionId: z.uuid().nullable(),
  sessionTitle: z.string().max(200),
  parentId: z.uuid().nullable(),
  route: decisionRouteSchema,
  status: inboxItemStatusSchema,
  options: z.array(z.string().max(inboxRuleLimits.optionLabel)).max(6),
  presentation: inboxItemPresentationSchema,
  note: z.string().max(inboxRuleLimits.note).nullable(),
  answer: z.string().max(inboxRuleLimits.optionLabel).nullable(),
  outcome: z.string().max(1000).nullable(),
  decidedVia: inboxDecisionChannelSchema.nullable(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;

export const decideInboxItemSchema = z
  .strictObject({
    itemId: z.uuid(),
    decision: z.enum(['approve', 'decline', 'answer', 'dismiss']),
    option: z
      .string()
      .trim()
      .min(1)
      .max(inboxRuleLimits.optionLabel)
      .optional(),
    note: z.string().trim().min(1).max(inboxRuleLimits.note).optional(),
    via: inboxDecisionChannelSchema.default('desktop'),
  })
  .refine(value => value.decision !== 'answer' || !!value.option, {
    message: 'Choose an option to answer.',
    path: ['option'],
  });
export type DecideInboxItemInput = z.input<typeof decideInboxItemSchema>;

export const isPendingInboxItem = (item: Pick<InboxItem, 'status'>) =>
  item.status === 'pending';

const escapePattern = (value: string) =>
  value.replace(/[.+^${}()|[\]\\]/g, '\\$&');

const wildcardExpression = (pattern: string, segment: string) =>
  new RegExp(
    '^' +
      pattern
        .split(/(\*\*|\*|\?)/)
        .map(part =>
          part === '**'
            ? '.*'
            : part === '*'
              ? segment
              : part === '?'
                ? '.'
                : escapePattern(part),
        )
        .join('') +
      '$',
    's',
  );

const collapse = (value: string) => value.trim().replace(/\s+/g, ' ');

const stripAssignments = (command: string) =>
  command.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/,
    '',
  );

export const commandSegments = (command: string): string[] =>
  command
    .split(/&&|\|\||;|\||\r?\n/)
    .map(part => stripAssignments(collapse(part)))
    .filter(Boolean);

export const matchesCommandPattern = (pattern: string, command: string) => {
  const expression = wildcardExpression(collapse(pattern), '.*');
  const whole = collapse(command);
  return (
    expression.test(whole) ||
    commandSegments(command).some(segment => expression.test(segment))
  );
};

export const matchesToolPattern = (pattern: string, tool: string) =>
  wildcardExpression(pattern.trim(), '.*').test(tool);

export const matchesPathGlob = (glob: string, path: string) => {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const expression = wildcardExpression(
    glob.trim().replace(/\\/g, '/'),
    '[^/]*',
  );
  return (
    expression.test(normalized) ||
    (!glob.includes('/') &&
      expression.test(normalized.split('/').at(-1) ?? normalized))
  );
};

export const matchesNameFilter = (filter: string, value: string) =>
  wildcardExpression(filter.trim().toLowerCase(), '.*').test(
    value.toLowerCase(),
  );

export const pullRequestCommandPatterns: Record<PullRequestRuleAction, string> =
  {
    create: 'gh pr create*',
    merge: 'gh pr merge*',
    comment: 'gh pr comment*',
    review: 'gh pr review*',
  };

export const ruleCommandPatterns = (rule: InboxRule): string[] =>
  rule.trigger === 'command' && rule.pattern
    ? [rule.pattern]
    : rule.trigger === 'pull-request'
      ? (rule.actions ?? []).map(action => pullRequestCommandPatterns[action])
      : [];

export const inboxRulePresets = [
  {
    id: 'before-push',
    label: 'Before push: review the diff locally',
    text: `---
name: review-before-push
description: Hold every git push until I have looked at the branch diff.
trigger: command
pattern: "git push*"
action: hold
show: [diff, command]
diff: branch
on_unsupported: warn
---
{{ session.title }} wants to run \`{{ command }}\`. Review the branch diff before it leaves this computer.
`,
  },
  {
    id: 'before-merge',
    label: 'Before merge: review the pull request in Nesvo',
    text: `---
name: review-before-merge
description: Hold pull request merges until I have reviewed them in Nesvo.
trigger: pull-request
actions: [merge]
action: hold
show: [pull-request, command]
on_unsupported: warn
---
{{ session.title }} wants to merge a pull request. Open it in Nesvo and decide.
`,
  },
  {
    id: 'editing-plans',
    label: 'Plans of sessions that can edit files',
    text: `---
name: plans-of-editing-sessions
description: Show me ready plans of sessions that will edit files.
trigger: plan-ready
action: notify
show: [plan]
---
{{ session.title }} has a plan ready.
`,
  },
  {
    id: 'child-reports',
    label: 'Stage reports from child sessions',
    text: `---
name: child-stage-reports
description: Show me the stage reports of child sessions.
trigger: stage-report
action: notify
show: [report]
kinds: [child]
---
{{ session.title }} reported its stage.
`,
  },
  {
    id: 'agent-questions',
    label: 'Questions from agents',
    text: `---
name: agent-questions
description: Show me every question an agent asks.
trigger: stage-question
action: notify
---
{{ session.title }} asks a question.
`,
  },
  {
    id: 'ci-red',
    label: 'CI turned red on my pull requests',
    text: `---
name: ci-turned-red
description: Tell me when the checks of a linked pull request fail.
trigger: ci-checks
status: red
action: notify
show: [pull-request]
---
Checks failed on the pull request of {{ session.title }}: {{ checks }}.
`,
  },
] as const;
export type InboxRulePreset = (typeof inboxRulePresets)[number];
