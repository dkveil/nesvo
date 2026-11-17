import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  attachmentByteLimit,
  messageAttachmentSchema,
  type MessageAttachment,
  type StagedAttachment,
} from '@nesvo/contracts';

export type ProviderAttachment = {
  kind: MessageAttachment['kind'];
  name: string;
  mediaType: string;
  path: string;
};

export type StagedLookup = {
  attachments: ProviderAttachment[];
  missing: MessageAttachment[];
};

export class AttachmentError extends Error {
  constructor(
    readonly code: 'invalid-request' | 'not-found' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

const UUID_PATTERN =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

const IMAGE_SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  'image/png': bytes =>
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': bytes =>
    bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  'image/gif': bytes =>
    ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1')),
  'image/webp': bytes =>
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP',
};

const isReadableText = (bytes: Buffer): boolean => {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

const matchesContent = (attachment: MessageAttachment, bytes: Buffer) =>
  attachment.kind === 'image'
    ? (IMAGE_SIGNATURES[attachment.mediaType]?.(bytes) ?? false)
    : isReadableText(bytes);

const sameMetadata = (left: MessageAttachment, right: MessageAttachment) =>
  left.id === right.id &&
  left.kind === right.kind &&
  left.name === right.name &&
  left.mediaType === right.mediaType &&
  left.bytes === right.bytes;

const assertIdentifier = (value: string) => {
  if (!UUID_PATTERN.test(value))
    throw new AttachmentError('invalid-request', 'Invalid attachment.');
};

const writeAtomically = async (path: string, data: Buffer | string) => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

export class SessionAttachments {
  readonly root: string;

  constructor(dataDirectory: string) {
    this.root = join(dataDirectory, 'attachments');
  }

  sessionDirectory(sessionId: string): string {
    assertIdentifier(sessionId);
    return join(this.root, sessionId);
  }

  attachmentPath(sessionId: string, id: string): string {
    assertIdentifier(id);
    return join(this.sessionDirectory(sessionId), id);
  }

  private indexPath(sessionId: string, id: string): string {
    return `${this.attachmentPath(sessionId, id)}.json`;
  }

  private readIndex(sessionId: string, id: string): MessageAttachment | null {
    try {
      const parsed = messageAttachmentSchema.safeParse(
        JSON.parse(readFileSync(this.indexPath(sessionId, id), 'utf8')),
      );
      return parsed.success && parsed.data.id === id ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async stage(
    sessionId: string,
    attachment: MessageAttachment,
    data: string,
  ): Promise<string> {
    const bytes = Buffer.from(data, 'base64');
    if (
      bytes.length !== attachment.bytes ||
      bytes.length > attachmentByteLimit(attachment.kind)
    )
      throw new AttachmentError(
        'invalid-request',
        'The attachment size does not match its content.',
      );
    if (!matchesContent(attachment, bytes))
      throw new AttachmentError(
        'invalid-request',
        attachment.kind === 'image'
          ? 'The image content does not match its file type.'
          : 'Only UTF-8 text files can be attached.',
      );
    const existing = this.readIndex(sessionId, attachment.id);
    if (existing) {
      if (!sameMetadata(existing, attachment))
        throw new AttachmentError(
          'invalid-request',
          'This attachment ID is already in use.',
        );
      if (this.present(sessionId, existing)) return attachment.id;
    }
    try {
      await mkdir(this.sessionDirectory(sessionId), {
        recursive: true,
        mode: 0o700,
      });
      await writeAtomically(
        this.attachmentPath(sessionId, attachment.id),
        bytes,
      );
      await writeAtomically(
        this.indexPath(sessionId, attachment.id),
        JSON.stringify(attachment),
      );
    } catch {
      throw new AttachmentError(
        'unavailable',
        'The attachment could not be saved on this computer.',
      );
    }
    return attachment.id;
  }

  async read(sessionId: string, id: string): Promise<StagedAttachment> {
    const attachment = this.readIndex(sessionId, id);
    if (!attachment)
      throw new AttachmentError(
        'not-found',
        'The attachment is not available.',
      );
    let bytes: Buffer;
    try {
      bytes = await readFile(this.attachmentPath(sessionId, id));
    } catch {
      throw new AttachmentError(
        'not-found',
        'The attachment is not available.',
      );
    }
    if (bytes.length !== attachment.bytes)
      throw new AttachmentError('unavailable', 'The attachment is damaged.');
    return { attachment, data: bytes.toString('base64') };
  }

  attachmentsFor(
    sessionId: string,
    attachments: readonly MessageAttachment[],
  ): StagedLookup {
    const lookup: StagedLookup = { attachments: [], missing: [] };
    for (const attachment of attachments) {
      const indexed = this.readIndex(sessionId, attachment.id);
      if (
        !indexed ||
        !sameMetadata(indexed, attachment) ||
        !this.present(sessionId, indexed)
      ) {
        lookup.missing.push(attachment);
        continue;
      }
      lookup.attachments.push({
        kind: indexed.kind,
        name: indexed.name,
        mediaType: indexed.mediaType,
        path: this.attachmentPath(sessionId, indexed.id),
      });
    }
    return lookup;
  }

  async remove(sessionId: string): Promise<void> {
    await rm(this.sessionDirectory(sessionId), {
      recursive: true,
      force: true,
    });
  }

  private present(sessionId: string, attachment: MessageAttachment): boolean {
    try {
      const metadata = statSync(this.attachmentPath(sessionId, attachment.id));
      return metadata.isFile() && metadata.size === attachment.bytes;
    } catch {
      return false;
    }
  }
}
