import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ProviderFailureError, sessionFailure } from './failure';

export type ProviderAttachment = {
  kind: 'image' | 'text';
  name: string;
  mediaType: string;
  path: string;
};

export type LoadedAttachment = ProviderAttachment & { content: Buffer };

export const attachmentLimits = {
  count: 10,
  imageBytes: 5 * 1024 * 1024,
  textBytes: 200 * 1024,
} as const;

const imageMediaTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

function refuse(message: string): never {
  throw new ProviderFailureError(sessionFailure('provider', message));
}

async function checkedSize(attachment: ProviderAttachment): Promise<number> {
  if (!isAbsolute(attachment.path))
    refuse(`The attachment ${attachment.name} has no readable file.`);
  if (attachment.kind === 'image' && !imageMediaTypes.has(attachment.mediaType))
    refuse(
      `The image ${attachment.name} must be PNG, JPEG, GIF or WebP. No provider turn was started.`,
    );
  let size: number;
  try {
    const file = await stat(attachment.path);
    if (!file.isFile()) throw new Error('Not a file');
    size = file.size;
  } catch {
    refuse(
      `The attachment ${attachment.name} could not be read. No provider turn was started.`,
    );
  }
  const limit =
    attachment.kind === 'image'
      ? attachmentLimits.imageBytes
      : attachmentLimits.textBytes;
  if (size > limit)
    refuse(
      attachment.kind === 'image'
        ? `The image ${attachment.name} is larger than 5 MB. No provider turn was started.`
        : `The text file ${attachment.name} is larger than 200 kB. No provider turn was started.`,
    );
  return size;
}

export async function checkAttachments(
  attachments: ReadonlyArray<ProviderAttachment>,
): Promise<void> {
  if (attachments.length > attachmentLimits.count)
    refuse(
      'Attach at most 10 files to one message. No provider turn was started.',
    );
  for (const attachment of attachments) await checkedSize(attachment);
}

export async function loadAttachments(
  attachments: ReadonlyArray<ProviderAttachment>,
): Promise<LoadedAttachment[]> {
  await checkAttachments(attachments);
  const loaded: LoadedAttachment[] = [];
  for (const attachment of attachments) {
    try {
      loaded.push({ ...attachment, content: await readFile(attachment.path) });
    } catch {
      refuse(
        `The attachment ${attachment.name} could not be read. No provider turn was started.`,
      );
    }
    const limit =
      attachment.kind === 'image'
        ? attachmentLimits.imageBytes
        : attachmentLimits.textBytes;
    if (loaded.at(-1)!.content.length > limit)
      refuse(
        `The attachment ${attachment.name} changed while it was read. No provider turn was started.`,
      );
  }
  return loaded;
}

export function attachmentText(name: string, content: string): string {
  return `Attachment ${name}:\n${content}`;
}
