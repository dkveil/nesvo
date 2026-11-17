import { z } from 'zod';
import { scheduledJobTimeZoneSchema } from './scheduled-jobs';

export const costPeriodSchema = z.enum(['day', 'week', 'month']);
export const costGroupSchema = z.enum(['session', 'provider', 'directory']);

export const readCostsSchema = z.strictObject({
  range: costPeriodSchema,
  timeZone: scheduledJobTimeZoneSchema,
  groupBy: costGroupSchema,
});

const costTotalsSchema = z.strictObject({
  reportedCostUsd: z.number().nonnegative().nullable(),
  turnCount: z.number().int().nonnegative(),
  unknownCostTurns: z.number().int().nonnegative(),
});

export const costReportSchema = z.strictObject({
  totals: costTotalsSchema,
  buckets: z.array(costTotalsSchema.extend({ date: z.iso.date() })).max(31),
  groups: z.array(costTotalsSchema.extend({ key: z.string() })),
  topSessions: z
    .array(costTotalsSchema.extend({ sessionId: z.uuid(), title: z.string() }))
    .max(10),
});

const costBudgetTerms = {
  period: costPeriodSchema,
  limitUsd: z.number().positive(),
  action: z.enum(['warn', 'refuse-new-turns']),
};

const computerBudget = z.strictObject({
  ...costBudgetTerms,
  scope: z.literal('computer'),
});
const directoryBudget = z.strictObject({
  ...costBudgetTerms,
  scope: z.literal('directory'),
  target: z.string().min(1).max(4096),
});
const sessionBudget = z.strictObject({
  ...costBudgetTerms,
  scope: z.literal('session'),
  target: z.uuid(),
});

export const createCostBudgetSchema = z.discriminatedUnion('scope', [
  computerBudget,
  directoryBudget,
  sessionBudget,
]);

export const costBudgetSchema = z.discriminatedUnion('scope', [
  computerBudget.extend({ id: z.uuid() }),
  directoryBudget.extend({ id: z.uuid() }),
  sessionBudget.extend({ id: z.uuid() }),
]);

export const deleteCostBudgetSchema = z.strictObject({ id: z.uuid() });

export const costBudgetListSchema = z.strictObject({
  timeZone: scheduledJobTimeZoneSchema,
  budgets: z
    .array(
      z.strictObject({ budget: costBudgetSchema, totals: costTotalsSchema }),
    )
    .max(100),
});

export type CostPeriod = z.infer<typeof costPeriodSchema>;
export type ReadCostsInput = z.infer<typeof readCostsSchema>;
export type CostReport = z.infer<typeof costReportSchema>;
export type CostTotals = z.infer<typeof costTotalsSchema>;
export type CreateCostBudgetInput = z.infer<typeof createCostBudgetSchema>;
export type CostBudget = z.infer<typeof costBudgetSchema>;
export type CostBudgetList = z.infer<typeof costBudgetListSchema>;
