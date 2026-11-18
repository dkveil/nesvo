import { createHash, randomUUID, type Hash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
  attachmentByteLimit,
  attachmentKind,
  attachmentLimitMessage,
  attachmentLimits,
  fileMediaType,
  imageMediaTypes,
  pdfMediaType,
  type AttachmentContent,
  type AttachmentLocation,
  type AttachmentMediaType,
  type AttachmentUpload,
  type MessageAttachment,
  type StageAttachmentInput,
} from '@nesvo/contracts';

const MAX_PENDING_UPLOADS = 10;
const UPLOAD_EXPIRY_MS = 10 * 60_000;
const SIGNATURE_BYTES = 16;
const MAX_STORED_NAME_LENGTH = 120;
const FILE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'application/octet-stream': 'bin',
} as const satisfies Record<AttachmentMediaType, string>;
const RESERVED_WINDOWS_NAMES =
  /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

type PendingUpload = {
  name: string;
  path: string;
  hash: Hash;
  head: Buffer;
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

export const detectAttachmentType = (bytes: Buffer): AttachmentMediaType => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a')))
    return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8))
    return 'image/webp';
  if (startsWith(bytes, ascii('%PDF-'))) return pdfMediaType;
  return fileMediaType;
};

export const storedFileName = (name: string) => {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  const safe = RESERVED_WINDOWS_NAMES.test(cleaned) ? `_${cleaned}` : cleaned;
  if (!safe || /^\.+$/.test(safe)) return 'attachment';
  if (safe.length <= MAX_STORED_NAME_LENGTH) return safe;
  const extension = extname(safe).slice(0, 16);
  return safe.slice(0, MAX_STORED_NAME_LENGTH - extension.length) + extension;
};

const digest = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

const fileDigest = async (path: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};

const isMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const missing = (name?: string) =>
  new AttachmentError(
    'not-found',
    name
      ? `${name} is no longer available on this computer. Attach it again.`
      : 'This attachment is no longer stored on this computer.',
  );

export class AttachmentStore {
  private readonly directory: string;
  private readonly uploadDirectory: string;
  private readonly sessionsDirectory: string;
  private readonly uploads = new Map<string, PendingUpload>();

  constructor(dataDirectory: string) {
    this.directory = join(dataDirectory, 'attachments');
    this.uploadDirectory = join(this.directory, 'uploads');
    this.sessionsDirectory = join(this.directory, 'sessions');
  }

  path(attachment: Pick<MessageAttachment, 'id' | 'mediaType'>): string {
    return join(
      this.directory,
      `${attachment.id}.${FILE_EXTENSIONS[attachment.mediaType]}`,
    );
  }

  sessionDirectory(sessionId: string): string {
    return join(this.sessionsDirectory, sessionId);
  }

  async stage(
    input: StageAttachmentInput,
    now = Date.now(),
  ): Promise<AttachmentUpload> {
    await this.expire(now);
    const chunk = Buffer.from(input.data, 'base64');
    const existing = this.uploads.get(input.uploadId);
    if (!existing && input.offset !== 0)
      throw new AttachmentError(
        'not-found',
        'The upload expired. Attach the file again.',
      );
    if (!existing && this.uploads.size >= MAX_PENDING_UPLOADS)
      throw new AttachmentError(
        'busy',
        'Too many files are uploading. Wait for them to finish.',
      );
    const upload = existing ?? {
      name: input.name,
      path: join(this.uploadDirectory, `${input.uploadId}.partial`),
      hash: createHash('sha256'),
      head: Buffer.alloc(0),
      size: 0,
      touchedAt: now,
    };
    if (upload.name !== input.name || input.offset !== upload.size) {
      await this.discard(input.uploadId, upload);
      throw new AttachmentError(
        'invalid-request',
        'The upload was interrupted. Attach the file again.',
      );
    }
    if (upload.size + chunk.length > attachmentLimits.maxBytes) {
      await this.discard(input.uploadId, upload);
      throw new AttachmentError(
        'invalid-request',
        attachmentLimitMessage('file'),
      );
    }
    this.uploads.set(input.uploadId, upload);
    try {
      await mkdir(this.uploadDirectory, { recursive: true });
      await appendFile(upload.path, chunk);
    } catch (error) {
      await this.discard(input.uploadId, upload);
      throw error;
    }
    upload.hash.update(chunk);
    if (upload.head.length < SIGNATURE_BYTES)
      upload.head = Buffer.concat([upload.head, chunk]).subarray(
        0,
        SIGNATURE_BYTES,
      );
    upload.size += chunk.length;
    upload.touchedAt = now;
    if (!input.final) return { received: upload.size, attachment: null };
    this.uploads.delete(input.uploadId);
    try {
      return await this.finish(upload);
    } finally {
      await rm(upload.path, { force: true });
    }
  }

  async read(id: string): Promise<AttachmentContent> {
    for (const mediaType of imageMediaTypes) {
      try {
        const content = await this.load({ id, mediaType });
        return { id, mediaType, data: content.toString('base64') };
      } catch (error) {
        if (!(error instanceof AttachmentError) || error.code !== 'not-found')
          throw error;
      }
    }
    throw missing();
  }

  async load(
    attachment: Pick<MessageAttachment, 'id' | 'mediaType'>,
  ): Promise<Buffer> {
    let content: Buffer;
    try {
      content = await readFile(this.path(attachment));
    } catch (error) {
      if (isMissing(error)) throw missing();
      throw error;
    }
    if (
      digest(content) !== attachment.id ||
      detectAttachmentType(content) !== attachment.mediaType
    )
      throw new AttachmentError(
        'invalid-request',
        'A stored attachment no longer matches its record. Attach it again.',
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
      if (size !== attachment.size) throw missing(attachment.name);
    }
  }

  async sessionFile(
    sessionId: string,
    attachment: MessageAttachment,
  ): Promise<AttachmentLocation> {
    const directory = join(
      this.sessionDirectory(sessionId),
      attachment.id.slice(0, 16),
    );
    const path = join(directory, storedFileName(attachment.name));
    const location = { id: attachment.id, name: attachment.name, path };
    const current = await stat(path).catch(() => null);
    if (current?.size === attachment.size) return location;
    const source = this.path(attachment);
    const sourceDigest = await fileDigest(source).catch(error => {
      if (isMissing(error)) throw missing(attachment.name);
      throw error;
    });
    if (sourceDigest !== attachment.id)
      throw new AttachmentError(
        'invalid-request',
        `${attachment.name} no longer matches its record. Attach it again.`,
      );
    await mkdir(directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.partial`;
    try {
      await copyFile(source, temporary);
      await chmod(temporary, 0o444);
      await rm(path, { force: true });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return location;
  }

  async removeSession(sessionId: string): Promise<void> {
    await rm(this.sessionDirectory(sessionId), {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  }

  async removeContent(ids: Iterable<string>): Promise<void> {
    for (const id of ids)
      for (const extension of Object.values(FILE_EXTENSIONS))
        await rm(join(this.directory, `${id}.${extension}`), { force: true });
  }

  private async finish(upload: PendingUpload): Promise<AttachmentUpload> {
    const mediaType = detectAttachmentType(upload.head);
    const kind = attachmentKind(mediaType);
    if (upload.size > attachmentByteLimit(kind))
      throw new AttachmentError(
        'invalid-request',
        attachmentLimitMessage(kind),
      );
    if (upload.size === 0)
      throw new AttachmentError('invalid-request', 'The file is empty.');
    const attachment = {
      id: upload.hash.digest('hex'),
      mediaType,
      size: upload.size,
      name: upload.name,
    };
    await mkdir(this.directory, { recursive: true });
    const path = this.path(attachment);
    const current = await stat(path).catch(() => null);
    if (current?.size !== upload.size) await rename(upload.path, path);
    return { received: upload.size, attachment };
  }

  private async discard(id: string, upload: PendingUpload): Promise<void> {
    this.uploads.delete(id);
    await rm(upload.path, { force: true });
  }

  private async expire(now: number): Promise<void> {
    for (const [id, upload] of this.uploads)
      if (now - upload.touchedAt > UPLOAD_EXPIRY_MS)
        await this.discard(id, upload);
  }
}
