import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  attachmentLimits,
  attachmentMediaTypes,
  type AttachmentContent,
  type AttachmentMediaType,
  type AttachmentUpload,
  type MessageAttachment,
  type StageAttachmentInput,
} from '@nesvo/contracts';

const MAX_PENDING_UPLOADS = 10;
const UPLOAD_EXPIRY_MS = 10 * 60_000;
const FILE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
} as const satisfies Record<AttachmentMediaType, string>;

type PendingUpload = {
  name: string;
  chunks: Buffer[];
  size: number;
  touchedAt: number;
};

export class AttachmentError extends Error {
  constructor(
    readonly code: 'invalid-request' | 'not-found' | 'busy',
    message: string,
  ) {
    super(message);
  }
}

const startsWith = (bytes: Buffer, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((value, index) => bytes[offset + index] === value);

const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));

export const detectImageType = (bytes: Buffer): AttachmentMediaType | null => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a')))
    return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8))
    return 'image/webp';
  return null;
};

const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

const isMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export class AttachmentStore {
  private readonly directory: string;
  private readonly uploads = new Map<string, PendingUpload>();

  constructor(dataDirectory: string) {
    this.directory = join(dataDirectory, 'attachments');
  }

  path(attachment: Pick<MessageAttachment, 'id' | 'mediaType'>): string {
    return join(
      this.directory,
      `${attachment.id}.${FILE_EXTENSIONS[attachment.mediaType]}`,
    );
  }

  async stage(
    input: StageAttachmentInput,
    now = Date.now(),
  ): Promise<AttachmentUpload> {
    this.expire(now);
    const chunk = Buffer.from(input.data, 'base64');
    const existing = this.uploads.get(input.uploadId);
    if (!existing && input.offset !== 0)
      throw new AttachmentError(
        'not-found',
        'The image upload expired. Attach the image again.',
      );
    if (!existing && this.uploads.size >= MAX_PENDING_UPLOADS)
      throw new AttachmentError(
        'busy',
        'Too many images are uploading. Wait for them to finish.',
      );
    const upload = existing ?? {
      name: input.name,
      chunks: [],
      size: 0,
      touchedAt: now,
    };
    if (upload.name !== input.name || input.offset !== upload.size) {
      this.uploads.delete(input.uploadId);
      throw new AttachmentError(
        'invalid-request',
        'The image upload was interrupted. Attach the image again.',
      );
    }
    if (upload.size + chunk.length > attachmentLimits.bytes) {
      this.uploads.delete(input.uploadId);
      throw new AttachmentError(
        'invalid-request',
        'Images must be 5 MB or smaller.',
      );
    }
    upload.chunks.push(chunk);
    upload.size += chunk.length;
    upload.touchedAt = now;
    if (!input.final) {
      this.uploads.set(input.uploadId, upload);
      return { received: upload.size, attachment: null };
    }
    this.uploads.delete(input.uploadId);
    const content = Buffer.concat(upload.chunks);
    const mediaType = detectImageType(content);
    if (!mediaType)
      throw new AttachmentError(
        'invalid-request',
        'Attach a PNG, JPEG, WebP or GIF image.',
      );
    const attachment = {
      id: digest(content),
      mediaType,
      size: content.length,
      name: input.name,
    };
    await this.write(attachment, content);
    return { received: content.length, attachment };
  }

  async read(id: string): Promise<AttachmentContent> {
    for (const mediaType of attachmentMediaTypes) {
      try {
        const content = await this.load({ id, mediaType });
        return { id, mediaType, data: content.toString('base64') };
      } catch (error) {
        if (!(error instanceof AttachmentError) || error.code !== 'not-found')
          throw error;
      }
    }
    throw new AttachmentError(
      'not-found',
      'This image is no longer stored on this computer.',
    );
  }

  async load(
    attachment: Pick<MessageAttachment, 'id' | 'mediaType'>,
  ): Promise<Buffer> {
    let content: Buffer;
    try {
      content = await readFile(this.path(attachment));
    } catch (error) {
      if (isMissing(error))
        throw new AttachmentError(
          'not-found',
          'This image is no longer stored on this computer.',
        );
      throw error;
    }
    if (
      digest(content) !== attachment.id ||
      detectImageType(content) !== attachment.mediaType
    )
      throw new AttachmentError(
        'invalid-request',
        'A stored image no longer matches its record. Attach it again.',
      );
    return content;
  }

  confirm(attachments: readonly MessageAttachment[]): void {
    for (const attachment of attachments) {
      let size: number;
      try {
        size = statSync(this.path(attachment)).size;
      } catch {
        size = -1;
      }
      if (size !== attachment.size)
        throw new AttachmentError(
          'not-found',
          `${attachment.name} is no longer available on this computer. Attach it again.`,
        );
    }
  }

  private async write(
    attachment: Pick<MessageAttachment, 'id' | 'mediaType'>,
    content: Buffer,
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path = this.path(attachment);
    const current = await stat(path).catch(() => null);
    if (current?.size === content.length) return;
    const temporary = `${path}.${randomUUID()}.partial`;
    try {
      await writeFile(temporary, content, { flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private expire(now: number): void {
    for (const [id, upload] of this.uploads)
      if (now - upload.touchedAt > UPLOAD_EXPIRY_MS) this.uploads.delete(id);
  }
}
