import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  sharedWorkflowLinkSchema,
  workflowShareCreatedSchema,
  workflowSharingLimits,
  type SharedWorkflowLink,
} from '@nesvo/contracts';

const SHARING_FILE = 'sharing.json';
const PRIVATE_FILE_MODE = 0o600;

const storedLinkSchema = sharedWorkflowLinkSchema.extend({
  revokeToken: workflowShareCreatedSchema.shape.revokeToken,
});

const storedSharingSchema = z.object({
  origin: z.string().max(workflowSharingLimits.url).nullable().default(null),
  links: z.array(storedLinkSchema).max(workflowSharingLimits.links).default([]),
});

export type StoredShareLink = z.infer<typeof storedLinkSchema>;
type StoredSharing = z.infer<typeof storedSharingSchema>;

export const readSharing = (directory: string): StoredSharing => {
  try {
    const parsed = storedSharingSchema.safeParse(
      JSON.parse(readFileSync(join(directory, SHARING_FILE), 'utf8')),
    );
    return parsed.success ? parsed.data : { origin: null, links: [] };
  } catch {
    return { origin: null, links: [] };
  }
};

export const saveSharing = (directory: string, sharing: StoredSharing) => {
  const target = join(directory, SHARING_FILE);
  const temporary = `${target}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({
      origin: sharing.origin,
      links: sharing.links.slice(-workflowSharingLimits.links),
    }),
    { mode: PRIVATE_FILE_MODE },
  );
  renameSync(temporary, target);
};

export const publicLink = (link: StoredShareLink): SharedWorkflowLink =>
  sharedWorkflowLinkSchema.parse(
    Object.fromEntries(
      Object.entries(link).filter(([key]) => key !== 'revokeToken'),
    ),
  );
