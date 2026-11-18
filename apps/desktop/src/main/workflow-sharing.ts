import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SHARE_ORIGIN,
  prepareWorkflowShareSchema,
  saveWorkflowImportSchema,
  workflowImportResultSchema,
  workflowShareBundleSchema,
  workflowShareDraftSchema,
  workflowShareIdSchema,
  type SharedWorkflowLink,
  type WorkflowImportOffer,
  type WorkflowImportResult,
  type WorkflowShareBundle,
  type WorkflowSharePrepared,
  type WorkflowShareSettings,
} from '@nesvo/contracts';
import { type ComputerManager } from './computer-manager';
import { log } from './logging';
import { createShare, deleteShare, fetchShare } from './share-client';
import {
  normalizeShareOrigin,
  parseImportLink,
  PUBLIC_SHARE_ORIGIN,
} from './share-link';
import {
  publicLink,
  readSharing,
  saveSharing,
  type StoredShareLink,
} from './share-store';

const MAX_PENDING_DRAFTS = 8;
const MAX_PENDING_IMPORTS = 8;
const LOCAL_HOST_ID = 'local';

type Draft = {
  bundle: WorkflowShareBundle | null;
  findingCount: number;
  origin: string;
};

type PendingImport = {
  bundle: WorkflowShareBundle;
  origin: string;
  shareId: string;
};

type WorkflowSharingOptions = {
  userData: string;
  appVersion: string;
  isPackaged: boolean;
  computers: Pick<ComputerManager, 'executeSharing'>;
  onImportAvailable: () => void;
};

const bounded = <T>(
  map: Map<string, T>,
  key: string,
  value: T,
  max: number,
) => {
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value!);
};

const environmentOrigin = (isPackaged: boolean) => {
  const value = process.env.NESVO_SHARE_ORIGIN;
  if (isPackaged || !value) return null;
  return normalizeShareOrigin(value);
};

export const createWorkflowSharing = ({
  userData,
  appVersion,
  isPackaged,
  computers,
  onImportAvailable,
}: WorkflowSharingOptions) => {
  const drafts = new Map<string, Draft>();
  const imports = new Map<string, PendingImport>();
  let offers: WorkflowImportOffer[] = [];

  const settings = (): WorkflowShareSettings => {
    const override = environmentOrigin(isPackaged);
    return {
      origin: override ?? readSharing(userData).origin ?? DEFAULT_SHARE_ORIGIN,
      defaultOrigin: DEFAULT_SHARE_ORIGIN,
      overriddenByEnvironment: !!override,
    };
  };

  const storedLinks = () => readSharing(userData).links;

  const writeLinks = (links: StoredShareLink[]) =>
    saveSharing(userData, { ...readSharing(userData), links });

  const links = (): SharedWorkflowLink[] =>
    storedLinks()
      .map(publicLink)
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));

  const setOrigin = (value: string | null): WorkflowShareSettings => {
    const origin = value === null ? null : normalizeShareOrigin(value);
    if (value !== null && !origin)
      throw new Error(
        'Enter an https:// address without a path, for example https://nesvo.dev.',
      );
    saveSharing(userData, {
      ...readSharing(userData),
      origin: origin === DEFAULT_SHARE_ORIGIN ? null : origin,
    });
    return settings();
  };

  const prepare = async (
    hostId: string,
    input: unknown,
  ): Promise<WorkflowSharePrepared> => {
    const draft = workflowShareDraftSchema.parse(
      await computers.executeSharing(
        'prepare-workflow-share',
        prepareWorkflowShareSchema.parse(input),
        hostId,
      ),
    );
    const candidate = workflowShareBundleSchema.safeParse({
      version: 1,
      name: draft.name,
      ...(draft.description ? { description: draft.description } : {}),
      workflow: draft.workflow,
      steps: draft.steps.map(({ fileName, content }) => ({
        fileName,
        content,
      })),
      createdWith: { app: 'nesvo', version: appVersion },
    });
    const origin = settings().origin;
    const draftId = randomUUID();
    bounded(
      drafts,
      draftId,
      {
        bundle: candidate.success ? candidate.data : null,
        findingCount: draft.findingCount,
        origin,
      },
      MAX_PENDING_DRAFTS,
    );
    return {
      draftId,
      origin,
      bytes: Buffer.byteLength(
        JSON.stringify(candidate.success ? candidate.data : draft),
      ),
      draft,
      sizeIssue: candidate.success
        ? null
        : (candidate.error.issues[0]?.message ??
          'The workflow is too large to share.'),
    };
  };

  const upload = async (draftId: unknown): Promise<SharedWorkflowLink> => {
    const id = typeof draftId === 'string' ? draftId : '';
    const draft = drafts.get(id);
    if (!draft)
      throw new Error('This share is no longer prepared. Start sharing again.');
    if (draft.findingCount > 0)
      throw new Error(
        'Remove the possible secrets from the files and scan again before sharing.',
      );
    if (!draft.bundle) throw new Error('The workflow is too large to share.');
    if (draft.origin !== settings().origin)
      throw new Error('The share site changed. Start sharing again.');
    const created = await createShare(draft.origin, draft.bundle);
    drafts.delete(id);
    const link: StoredShareLink = {
      id: created.id,
      name: draft.bundle.name,
      url: created.url,
      origin: draft.origin,
      createdAt: new Date().toISOString(),
      expiresAt: created.expiresAt,
      revokeToken: created.revokeToken,
    };
    writeLinks([...storedLinks().filter(item => item.id !== link.id), link]);
    log.info(`A workflow was shared through ${draft.origin}.`);
    return publicLink(link);
  };

  const revoke = async (id: unknown) => {
    const shareId = workflowShareIdSchema.parse(id);
    const link = storedLinks().find(item => item.id === shareId);
    if (!link) return links();
    await deleteShare(link.origin, link.id, link.revokeToken);
    writeLinks(storedLinks().filter(item => item.id !== shareId));
    return links();
  };

  const forget = (id: unknown) => {
    const shareId = workflowShareIdSchema.parse(id);
    writeLinks(storedLinks().filter(item => item.id !== shareId));
    return links();
  };

  const offer = (next: WorkflowImportOffer) => {
    offers = [...offers, next].slice(-MAX_PENDING_IMPORTS);
    onImportAvailable();
  };

  const deliverLink = async (raw: string) => {
    const parsed = parseImportLink(raw, [
      settings().origin,
      PUBLIC_SHARE_ORIGIN,
    ]);
    if (!parsed.ok) {
      log.warn('A Nesvo link was refused.');
      offer({ status: 'refused', message: parsed.message });
      return;
    }
    try {
      const bundle = await fetchShare(parsed.origin, parsed.shareId);
      const importId = randomUUID();
      bounded(
        imports,
        importId,
        { bundle, origin: parsed.origin, shareId: parsed.shareId },
        MAX_PENDING_IMPORTS,
      );
      offer({
        status: 'ready',
        importId,
        shareId: parsed.shareId,
        origin: parsed.origin,
        bundle,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'The shared workflow could not be opened.';
      log.warn('A shared workflow could not be opened.');
      offer({ status: 'refused', message });
    }
  };

  const takeImports = () => {
    const taken = offers;
    offers = [];
    return taken;
  };

  const importWorkflow = async (
    input: unknown,
  ): Promise<WorkflowImportResult> => {
    const request = saveWorkflowImportSchema.parse(input);
    const pending = imports.get(request.importId);
    if (!pending)
      throw new Error(
        'This import is no longer available. Open the link again.',
      );
    const result = workflowImportResultSchema.parse(
      await computers.executeSharing(
        'import-workflow-bundle',
        {
          target: request.target,
          bundle: pending.bundle,
          workflowName: request.workflowName,
          overwrite: request.overwrite,
          write: request.write,
        },
        LOCAL_HOST_ID,
      ),
    );
    if (result.status === 'saved') imports.delete(request.importId);
    return result;
  };

  const dismissImport = (importId: unknown) => {
    if (typeof importId === 'string') imports.delete(importId);
  };

  return {
    settings,
    setOrigin,
    prepare,
    upload,
    links,
    revoke,
    forget,
    deliverLink,
    takeImports,
    importWorkflow,
    dismissImport,
  };
};

export type WorkflowSharing = ReturnType<typeof createWorkflowSharing>;
