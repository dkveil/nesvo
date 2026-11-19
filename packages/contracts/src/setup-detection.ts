import { z } from 'zod';
import {
  setupProfileDigestSchema,
  setupProfilePathSchema,
} from './setup-profile';

export const setupGroups = [
  'Providers',
  'Agent configuration',
  'Repositories and trust',
  'Worktrees and branches',
  'Recipes',
  'GitHub',
  'Limits',
  'Sessions to import',
] as const;

const evidenceText = z.string().min(1).max(300);
export const setupFindingSchema = z.strictObject({
  id: z.string().min(1).max(140),
  group: z.enum(setupGroups),
  label: evidenceText,
  description: evidenceText,
  source: z.enum(['Detected', 'Profile', 'Manual']),
  evidence: z.enum(['filesystem', 'cached', 'projection', 'unavailable']),
  readiness: z.enum([
    'observed',
    'partial',
    'not-checked',
    'unavailable',
    'withheld',
  ]),
  classification: z.enum(['observation', 'ordinary', 'execution', 'authority']),
  action: z.enum(['review', 'import']).optional(),
  verifiedAt: z.iso.datetime(),
  revision: setupProfileDigestSchema,
});

export const setupScanRequestSchema = z.strictObject({
  trigger: z.enum(['onboarding', 'manual', 'first-open', 'startup']),
  directory: setupProfilePathSchema.optional(),
});
export const setupDetectionInputSchema = z.discriminatedUnion('action', [
  setupScanRequestSchema.extend({ action: z.literal('scan') }),
  z.strictObject({
    action: z.literal('acknowledge'),
    instanceId: z.uuid(),
    revision: z.number().int().positive(),
    completed: z.boolean().default(false),
  }),
]);
export const setupScanSchema = z.strictObject({
  instanceId: z.uuid(),
  revision: z.number().int().positive(),
  scannedAt: z.iso.datetime(),
  directory: setupProfilePathSchema.nullable(),
  completed: z.boolean(),
  reviewedRevision: z.number().int().positive().nullable(),
  findings: z.array(setupFindingSchema).max(100),
  changes: z.array(z.string().min(1).max(140)).max(100),
});
export type SetupScan = z.output<typeof setupScanSchema>;
export type SetupFinding = z.output<typeof setupFindingSchema>;
export type SetupScanRequest = z.output<typeof setupScanRequestSchema>;
export type SetupDetectionInput = z.output<typeof setupDetectionInputSchema>;
