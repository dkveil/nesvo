import {
  attachmentByteLimit,
  attachmentLimits,
  attachmentMediaTypes,
  isAttachmentMediaType,
  type AttachmentKind,
  type MessageAttachment,
} from '@nesvo/contracts';

export type PendingAttachment = {
  attachment: MessageAttachment;
  data: string | null;
  preview: string | null;
};

export type AttachmentIntake = {
  added: PendingAttachment[];
  refusals: string[];
};

const TEXT_EXTENSIONS: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
};

const SOURCE_EXTENSIONS = new Set([
  'c',
  'cpp',
  'cs',
  'css',
  'diff',
  'go',
  'h',
  'html',
  'java',
  'js',
  'jsx',
  'kt',
  'mjs',
  'patch',
  'php',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'swift',
  'toml',
  'ts',
  'tsx',
  'xml',
  'yaml',
  'yml',
]);

const IMAGE_TYPES: readonly string[] = attachmentMediaTypes.image;

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const classify = (
  file: File,
): { kind: AttachmentKind; mediaType: string } | null => {
  const extension = extensionOf(file.name);
  if (IMAGE_TYPES.includes(file.type))
    return { kind: 'image', mediaType: file.type };
  const known = TEXT_EXTENSIONS[extension];
  if (known) return { kind: 'text', mediaType: known };
  if (SOURCE_EXTENSIONS.has(extension))
    return { kind: 'text', mediaType: `text/x-${extension}` };
  if (isAttachmentMediaType('text', file.type))
    return { kind: 'text', mediaType: file.type };
  return null;
};

const safeName = (name: string, fallback: string) => {
  const cleaned = name
    .replace(/[\\/\u0000-\u001f\u007f]/g, '-')
    .trim()
    .slice(-255);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
};

export const formatBytes = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 102.4) / 10} KB`
      : `${Math.round(bytes / 104857.6) / 10} MB`;

export const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

export const decodeText = (data: string): string =>
  new TextDecoder().decode(
    Uint8Array.from(atob(data), character => character.charCodeAt(0)),
  );

export const previewUrl = (attachment: MessageAttachment, data: string) =>
  `data:${attachment.mediaType};base64,${data}`;

const readFile = async (
  file: File,
): Promise<PendingAttachment | { refusal: string }> => {
  const type = classify(file);
  const name = safeName(
    file.name,
    type?.kind === 'image' ? 'pasted-image' : 'attachment.txt',
  );
  if (!type)
    return {
      refusal: `${name} can't be attached. Use PNG, JPEG, GIF or WebP images, or text files.`,
    };
  const limit = attachmentByteLimit(type.kind);
  if (file.size === 0) return { refusal: `${name} is empty.` };
  if (file.size > limit)
    return {
      refusal: `${name} is larger than ${formatBytes(limit)}, the limit for ${type.kind === 'image' ? 'images' : 'text files'}.`,
    };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (type.kind === 'text') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { refusal: `${name} is not a UTF-8 text file.` };
    }
  }
  const attachment: MessageAttachment = {
    id: crypto.randomUUID(),
    kind: type.kind,
    name,
    mediaType: type.mediaType,
    bytes: bytes.length,
  };
  const data = encodeBase64(bytes);
  return {
    attachment,
    data,
    preview: type.kind === 'image' ? previewUrl(attachment, data) : null,
  };
};

export const filesFrom = (transfer: DataTransfer | null): File[] => {
  if (!transfer) return [];
  const files = Array.from(transfer.files);
  if (files.length > 0) return files;
  return Array.from(transfer.items)
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => !!file);
};

export const hasFiles = (transfer: DataTransfer | null): boolean =>
  !!transfer && Array.from(transfer.types).includes('Files');

export const isLongPaste = (text: string): boolean =>
  text.length > attachmentLimits.pastedTextCharacters;

export const textAttachment = (
  text: string,
  index: number,
): PendingAttachment | { refusal: string } => {
  const bytes = new TextEncoder().encode(text);
  const name = `pasted-text-${index}.txt`;
  if (bytes.length > attachmentLimits.textBytes)
    return {
      refusal: `The pasted text is larger than ${formatBytes(attachmentLimits.textBytes)}, the limit for a text attachment.`,
    };
  return {
    attachment: {
      id: crypto.randomUUID(),
      kind: 'text',
      name,
      mediaType: 'text/plain',
      bytes: bytes.length,
    },
    data: encodeBase64(bytes),
    preview: null,
  };
};

export const takeAttachments = async (
  files: File[],
  current: number,
): Promise<AttachmentIntake> => {
  const intake: AttachmentIntake = { added: [], refusals: [] };
  for (const file of files) {
    if (current + intake.added.length >= attachmentLimits.perMessage) {
      intake.refusals.push(
        `A message can carry up to ${attachmentLimits.perMessage} attachments.`,
      );
      break;
    }
    const result = await readFile(file);
    if ('refusal' in result) intake.refusals.push(result.refusal);
    else intake.added.push(result);
  }
  return intake;
};
