import { z } from 'zod';

export const ruleEntryTypeSchema = z.enum(['lesson', 'gate-rule']);
export type RuleEntryType = z.infer<typeof ruleEntryTypeSchema>;

export const RULE_ENTRY_FOLDERS = {
  lesson: 'lessons',
  'gate-rule': 'gate-rules',
} as const satisfies Record<RuleEntryType, string>;

export const RULE_ENTRY_ID_PREFIXES = {
  lesson: 'lesson',
  'gate-rule': 'rule',
} as const satisfies Record<RuleEntryType, string>;

export const ruleEntryLimits = {
  description: 200,
  body: 600,
  quote: 400,
  scopeItems: 20,
  scopeItem: 200,
  enforcedBy: 120,
  incidents: 10,
  indexLines: 20,
  indexCharacters: 2000,
  bodies: 6,
  bodyCharacters: 3000,
  entriesPerRoot: 200,
  fileBytes: 64 * 1024,
} as const;

export const ruleEntryMetricsSchema = z.strictObject({
  delivered: z.number().int().nonnegative(),
  cited: z.number().int().nonnegative(),
  lastDelivered: z.iso.datetime().nullable(),
  lastCited: z.iso.datetime().nullable(),
});
export type RuleEntryMetrics = z.infer<typeof ruleEntryMetricsSchema>;

export const ruleEntryCitationSchema = z
  .string()
  .max(40)
  .regex(/^(?:rule|lesson)-\d{4,}$/);
export const GATE_RULES_PER_STEP = 12;

export const RULE_ENTRY_TRIGGER = 'Applies when';

const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]+$/);

const scopeList = <T extends z.ZodType>(item: T) =>
  z.array(item).min(1).max(ruleEntryLimits.scopeItems).optional();

export const ruleEntryProviderSchema = z.enum(['claude', 'codex']);
export type RuleEntryProvider = z.infer<typeof ruleEntryProviderSchema>;

export const ruleEntryRoleSchema = z.enum([
  'standalone',
  'orchestrator',
  'worker',
  'workflow-agent',
  'reviewer',
]);
export type RuleEntryRole = z.infer<typeof ruleEntryRoleSchema>;

export const ruleEntryScopeSchema = z.strictObject({
  providers: scopeList(ruleEntryProviderSchema),
  workflows: scopeList(singleLine(ruleEntryLimits.scopeItem)),
  steps: scopeList(singleLine(ruleEntryLimits.scopeItem)),
  paths: scopeList(singleLine(ruleEntryLimits.scopeItem)),
  roles: scopeList(ruleEntryRoleSchema),
});
export type RuleEntryScope = z.infer<typeof ruleEntryScopeSchema>;

const dateSchema = z.iso.date();

export const ruleEntryProvenanceSchema = z.strictObject({
  source: z.enum(['incident', 'run', 'manual']),
  incidents: z.array(z.uuid()).min(1).max(ruleEntryLimits.incidents).optional(),
  run: singleLine(80).optional(),
  step: singleLine(ruleEntryLimits.scopeItem).optional(),
  session: z.uuid().optional(),
  decision: singleLine(40).optional(),
  date: dateSchema,
  decisionId: z.uuid().optional(),
  proposal: z.uuid().optional(),
  workflow: singleLine(ruleEntryLimits.scopeItem).optional(),
  attempt: z.number().int().positive().optional(),
  edited: z.literal(true).optional(),
  quote: singleLine(ruleEntryLimits.quote).optional(),
});
export type RuleEntryProvenance = z.infer<typeof ruleEntryProvenanceSchema>;

export const ruleEntryEnforcedBySchema = z
  .string()
  .trim()
  .max(ruleEntryLimits.enforcedBy)
  .regex(
    /^(?:none|(?:lint|test|ci):\S+)$/,
    'Use none, lint:<rule>, test:<file> or ci:<job>.',
  );

export const ruleEntryIdSchema = (type: RuleEntryType) =>
  z
    .string()
    .max(40)
    .regex(
      new RegExp(`^${RULE_ENTRY_ID_PREFIXES[type]}-\\d{4,}$`),
      `Use ${RULE_ENTRY_ID_PREFIXES[type]}-NNNN.`,
    );

export const ruleEntryDescriptionSchema = singleLine(
  ruleEntryLimits.description,
).refine(
  value => value.startsWith(RULE_ENTRY_TRIGGER),
  `Start the description with "${RULE_ENTRY_TRIGGER}".`,
);

const bodyLine = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/);

export const ruleEntryBodySchema = z
  .strictObject({
    rule: bodyLine('The rule'),
    why: bodyLine('Why').refine(
      value => !value.includes('\n'),
      'Write Why in one sentence.',
    ),
    check: bodyLine('Check').refine(
      value => !value.includes('\n'),
      'Write Check on one line.',
    ),
  })
  .refine(
    body => formatRuleEntryBody(body).length <= ruleEntryLimits.body,
    `Keep the rule, Why and Check within ${ruleEntryLimits.body} characters.`,
  );
export type RuleEntryBody = z.infer<typeof ruleEntryBodySchema>;

export const ruleEntryFieldsSchema = z.strictObject({
  description: ruleEntryDescriptionSchema,
  kind: z.enum(['instruction', 'check']),
  scope: ruleEntryScopeSchema.default({}),
  status: z.enum(['active', 'retired']),
  enforcedBy: ruleEntryEnforcedBySchema.default('none'),
  review: dateSchema.optional(),
  provenance: ruleEntryProvenanceSchema,
});

export const ruleEntrySchema = ruleEntryFieldsSchema.extend({
  id: z.string().min(1).max(40),
  type: ruleEntryTypeSchema,
  body: ruleEntryBodySchema,
});
export type RuleEntry = z.infer<typeof ruleEntrySchema>;

export function formatRuleEntryBody(body: {
  rule: string;
  why: string;
  check: string;
}): string {
  return `${body.rule.trim()}\nWhy: ${body.why.trim()}\nCheck: ${body.check.trim()}`;
}

export const parseRuleEntryBody = (
  text: string,
): { valid: true; body: RuleEntryBody } | { valid: false; issue: string } => {
  const lines = text.trim().split(/\r?\n/);
  const why = lines.findIndex(line => line.startsWith('Why:'));
  const check = lines.findIndex(line => line.startsWith('Check:'));
  if (why < 1 || check !== why + 1 || check !== lines.length - 1)
    return {
      valid: false,
      issue:
        'Write the rule, then a "Why:" line, then a "Check:" line as the last line.',
    };
  const parsed = ruleEntryBodySchema.safeParse({
    rule: lines.slice(0, why).join('\n'),
    why: lines[why]!.slice('Why:'.length),
    check: lines[check]!.slice('Check:'.length),
  });
  return parsed.success
    ? { valid: true, body: parsed.data }
    : {
        valid: false,
        issue: parsed.error.issues[0]?.message ?? 'Invalid body.',
      };
};

export type ParsedRuleEntry =
  { valid: true; entry: RuleEntry } | { valid: false; issues: string[] };

export const parseRuleEntry = (
  type: RuleEntryType,
  fields: unknown,
  body: string,
): ParsedRuleEntry => {
  const record =
    fields && typeof fields === 'object' && !Array.isArray(fields)
      ? (fields as Record<string, unknown>)
      : {};
  const { id, ...rest } = record;
  const issues: string[] = [];
  const parsedId = ruleEntryIdSchema(type).safeParse(id);
  if (!parsedId.success)
    issues.push(`id: ${parsedId.error.issues[0]?.message ?? 'invalid'}`);
  const parsedFields = ruleEntryFieldsSchema.safeParse(rest);
  if (!parsedFields.success)
    issues.push(
      ...parsedFields.error.issues
        .slice(0, 5)
        .map(
          issue =>
            `${issue.path.join('.') || 'front matter'}: ${issue.message}`,
        ),
    );
  const parsedBody = parseRuleEntryBody(body);
  if (!parsedBody.valid) issues.push(parsedBody.issue);
  if (type === 'gate-rule' && parsedFields.success) {
    const { scope } = parsedFields.data;
    if (!scope.steps?.length || scope.steps.length > 4)
      issues.push('Gate rules need one to four target steps.');
    if ((scope.workflows?.length ?? 0) > 8)
      issues.push('Gate rules can target up to eight workflows.');
  }
  if (
    issues.length ||
    !parsedId.success ||
    !parsedFields.success ||
    !parsedBody.valid
  )
    return { valid: false, issues };
  return {
    valid: true,
    entry: {
      id: parsedId.data,
      type,
      ...parsedFields.data,
      body: parsedBody.body,
    },
  };
};

const quoted = (value: string) => JSON.stringify(value);

const yamlList = (values: readonly string[]) =>
  `[${values.map(quoted).join(', ')}]`;

export const serializeRuleEntry = (entry: RuleEntry): string => {
  const scope = Object.entries(entry.scope).filter(
    (item): item is [string, string[]] => Array.isArray(item[1]),
  );
  const provenance = entry.provenance;
  const lines = [
    '---',
    `id: ${entry.id}`,
    `description: ${quoted(entry.description)}`,
    `kind: ${entry.kind}`,
    scope.length ? 'scope:' : 'scope: {}',
    ...scope.map(([key, values]) => `  ${key}: ${yamlList(values)}`),
    `status: ${entry.status}`,
    `enforcedBy: ${quoted(entry.enforcedBy)}`,
    ...(entry.review ? [`review: ${entry.review}`] : []),
    'provenance:',
    `  source: ${provenance.source}`,
    ...(provenance.incidents
      ? [`  incidents: ${yamlList(provenance.incidents)}`]
      : []),
    ...(provenance.run ? [`  run: ${quoted(provenance.run)}`] : []),
    ...(provenance.step ? [`  step: ${quoted(provenance.step)}`] : []),
    ...(provenance.session ? [`  session: ${provenance.session}`] : []),
    ...(provenance.decision
      ? [`  decision: ${quoted(provenance.decision)}`]
      : []),
    `  date: ${provenance.date}`,
    ...(provenance.decisionId
      ? [`  decisionId: ${provenance.decisionId}`]
      : []),
    ...(provenance.proposal ? [`  proposal: ${provenance.proposal}`] : []),
    ...(provenance.workflow
      ? [`  workflow: ${quoted(provenance.workflow)}`]
      : []),
    ...(provenance.attempt ? [`  attempt: ${provenance.attempt}`] : []),
    ...(provenance.edited ? ['  edited: true'] : []),
    ...(provenance.quote ? [`  quote: ${quoted(provenance.quote)}`] : []),
    '---',
    '',
    formatRuleEntryBody(entry.body),
    '',
  ];
  return lines.join('\n');
};

export const splitRuleEntryDocument = (
  text: string,
): { yaml: string; body: string } | null => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(
    text,
  );
  return match ? { yaml: match[1]!, body: (match[2] ?? '').trim() } : null;
};

export const ruleEntryIndexLine = (
  entry: Pick<RuleEntry, 'id' | 'description'>,
) => `${entry.id}: ${entry.description}`;

export const ruleEntryIsDue = (
  entry: Pick<RuleEntry, 'status' | 'review'>,
  today: string,
): boolean =>
  entry.status === 'active' && !!entry.review && entry.review <= today;

export const localDate = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
