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
const UNREADABLE_SUFFIX = '.unreadable';
const PRIVATE_FILE_MODE = 0o600;

const storedLinkSchema = sharedWorkflowLinkSchema.extend({
  revokeToken: workflowShareCreatedSchema.shape.revokeToken,
});

const storedOriginSchema = z.string().max(workflowSharingLimits.url).nullable();

const storedFileSchema = z.object({
  origin: z.unknown().optional(),
  links: z.array(z.unknown()).optional(),
});

export type StoredShareLink = z.infer<typeof storedLinkSchema>;
type StoredSharing = {
  origin: string | null;
  links: StoredShareLink[];
};

const isMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const validLinks = (links: readonly unknown[]): StoredShareLink[] =>
  links.flatMap(link => {
    const parsed = storedLinkSchema.safeParse(link);
    return parsed.success ? [parsed.data] : [];
  });

const setAside = (target: string) => {
  try {
    renameSync(target, `${target}${UNREADABLE_SUFFIX}`);
  } catch {
    throw new Error(
      'The shared links file cannot be read or moved aside. Check the Nesvo data folder.',
    );
  }
};

export const readSharing = (directory: string): StoredSharing => {
  const target = join(directory, SHARING_FILE);
  let text: string;
  try {
    text = readFileSync(target, 'utf8');
  } catch (error) {
    if (isMissing(error)) return { origin: null, links: [] };
    throw new Error('The shared links file cannot be read.');
  }
  let file: z.infer<typeof storedFileSchema>;
  try {
    file = storedFileSchema.parse(JSON.parse(text));
  } catch {
    setAside(target);
    return { origin: null, links: [] };
  }
  const origin = storedOriginSchema.safeParse(file.origin ?? null);
  return {
    origin: origin.success ? origin.data : null,
    links: validLinks(file.links ?? []).slice(-workflowSharingLimits.links),
  };
};

export const saveSharing = (directory: string, sharing: StoredSharing) => {
  const target = join(directory, SHARING_FILE);
  const temporary = `${target}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({
      origin: storedOriginSchema.parse(sharing.origin),
      links: validLinks(sharing.links).slice(-workflowSharingLimits.links),
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
