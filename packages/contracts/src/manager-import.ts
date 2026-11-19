import { z } from 'zod';
import { providerSchema } from './sessions';

export const managerImportSources = ['t3-code', 'agent-deck'] as const;
const sourceSchema = z.enum(managerImportSources);
const key = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]+$/);
const root = z.string().min(1).max(4096);
const title = z.string().min(1).max(200);
const selection = z.strictObject({ key, revision: key });
const adoptionSelection = selection.extend({
  useProjectFolder: z.literal(true).optional(),
});
export const managerImportSelectionLimit = 200;

export const listManagerImportSchema = z.strictObject({
  source: sourceSchema,
  root: root.optional(),
  offset: z.number().int().nonnegative().default(0),
  scanId: z.uuid().optional(),
});

export const adoptManagerImportSchema = z.strictObject({
  source: sourceSchema,
  root: root.optional(),
  requestId: z.uuid(),
  selected: z
    .array(adoptionSelection)
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
  workspaceFallback: z.literal('project-folder').optional(),
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
  scanId: z.uuid().nullable(),
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
