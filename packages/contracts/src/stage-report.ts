import { z } from 'zod';

export const stageLimits = {
  summary: 4000,
  note: 1000,
  notes: 20,
  links: 20,
  question: 4000,
  options: 6,
  optionLabel: 200,
  consequences: 2000,
  recommendation: 2000,
  answer: 4000,
  progress: 500,
  error: 2000,
} as const;

export const STAGE_REPORT_FENCE = 'nesvo-report';

const noteListSchema = z
  .array(z.string().trim().min(1).max(stageLimits.note))
  .max(stageLimits.notes)
  .default([]);

export const stageReportLinkSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }).max(2000),
  title: z.string().trim().min(1).max(200).optional(),
});

export const stageReportNotesSchema = z.strictObject({
  deadEnds: noteListSchema,
  assumptions: noteListSchema,
  later: noteListSchema,
  systemRemarks: noteListSchema,
});

export const stageReportSchema = z.strictObject({
  status: z.enum(['ok', 'fail']),
  summary: z.string().trim().min(1).max(stageLimits.summary),
  links: z.array(stageReportLinkSchema).max(stageLimits.links).default([]),
  notes: stageReportNotesSchema.default({
    deadEnds: [],
    assumptions: [],
    later: [],
    systemRemarks: [],
  }),
});
export type StageReport = z.infer<typeof stageReportSchema>;
export type StageReportLink = z.infer<typeof stageReportLinkSchema>;

export const stageQuestionOptionSchema = z.strictObject({
  label: z.string().trim().min(1).max(stageLimits.optionLabel),
  consequences: z.string().trim().min(1).max(stageLimits.consequences),
});

export const stageQuestionSchema = z.strictObject({
  question: z.string().trim().min(1).max(stageLimits.question),
  options: z
    .array(stageQuestionOptionSchema)
    .min(1)
    .max(stageLimits.options)
    .refine(
      options =>
        new Set(options.map(option => option.label.toLowerCase())).size ===
        options.length,
      'Give every option a different label.',
    ),
  recommendation: z
    .string()
    .trim()
    .min(1)
    .max(stageLimits.recommendation)
    .optional(),
  kind: z.enum(['technical', 'product']),
});
export type StageQuestion = z.infer<typeof stageQuestionSchema>;
export type StageQuestionOption = z.infer<typeof stageQuestionOptionSchema>;

export const stageProgressSchema = z.strictObject({
  text: z.string().trim().min(1).max(stageLimits.progress),
});

export type FencedStageReport =
  | { status: 'none' }
  | { status: 'valid'; report: StageReport }
  | { status: 'invalid'; error: string };

const fencePattern = new RegExp(
  `^[ \\t]*\`\`\`${STAGE_REPORT_FENCE}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*\`\`\`[ \\t]*$`,
  'gm',
);

const describeIssues = (error: z.ZodError) =>
  error.issues
    .slice(0, 5)
    .map(issue => `${issue.path.join('.') || 'report'}: ${issue.message}`)
    .join('; ');

export const parseFencedStageReport = (text: string): FencedStageReport => {
  const blocks = [...text.matchAll(fencePattern)];
  const body = blocks.at(-1)?.[1];
  if (body == null) return { status: 'none' };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return {
      status: 'invalid',
      error: `The ${STAGE_REPORT_FENCE} block is not valid JSON.`,
    };
  }
  const parsed = stageReportSchema.safeParse(value);
  return parsed.success
    ? { status: 'valid', report: parsed.data }
    : {
        status: 'invalid',
        error: describeIssues(parsed.error).slice(0, stageLimits.error),
      };
};
