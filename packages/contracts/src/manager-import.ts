import { z } from 'zod';
import { providerSchema } from './sessions';

const sourceSchema = z.enum(['t3-code', 'agent-deck']);
const key = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]+$/);
const root = z.string().min(1).max(4096);
const title = z.string().min(1).max(200);
const selection = z.strictObject({ key, revision: key });
export const managerImportSelectionLimit = 200;

export const listManagerImportSchema = z.strictObject({
  source: sourceSchema,
  root: root.optional(),
  offset: z.number().int().min(0).max(500).default(0),
});

export const adoptManagerImportSchema = z.strictObject({
  source: sourceSchema,
  root: root.optional(),
  requestId: z.uuid(),
  selected: z
    .array(selection)
    .min(1)
    .max(managerImportSelectionLimit)
    .refine(rows => new Set(rows.map(row => row.key)).size === rows.length),
});

const group = selection.extend({
  kind: z.literal('group'),
  title,
  parent: key.nullable(),
  archivedAt: z.iso.datetime().nullable(),
  profile: title.nullable(),
});

const session = selection.extend({
  kind: z.literal('session'),
  title,
  parent: key.nullable(),
  provider: providerSchema.nullable(),
  archivedAt: z.iso.datetime().nullable(),
  profile: title.nullable(),
  disposition: z.enum(['ready', 'existing', 'blocked']),
  reason: z.string().max(250).nullable(),
});

export const managerImportCatalogSchema = z.strictObject({
  status: z.enum([
    'ready',
    'partial',
    'not-found',
    'unsupported',
    'unavailable',
    'retry',
    'choose-root',
  ]),
  message: z.string().max(300).nullable(),
  roots: z.array(root).max(2),
  groupCount: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  profileCount: z.number().int().nonnegative(),
  rows: z.array(z.discriminatedUnion('kind', [group, session])).max(100),
  nextOffset: z.number().int().nullable(),
});

export const managerImportResultSchema = z.strictObject({
  requestId: z.uuid(),
  outcomes: z
    .array(
      z.strictObject({
        key,
        status: z.enum(['created', 'existing', 'skipped']),
        reason: z.string().max(250).nullable(),
      }),
    )
    .max(managerImportSelectionLimit),
});

export type ManagerImportSource = z.infer<typeof sourceSchema>;
export type ListManagerImportInput = z.infer<typeof listManagerImportSchema>;
export type AdoptManagerImportInput = z.infer<typeof adoptManagerImportSchema>;
export type ManagerImportCatalog = z.infer<typeof managerImportCatalogSchema>;
export type ManagerImportRow = ManagerImportCatalog['rows'][number];
export type ManagerImportResult = z.infer<typeof managerImportResultSchema>;
