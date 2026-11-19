import { constants, type Dirent } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  conversationImportLimit,
  type ConversationImportCatalog,
  type Provider,
} from '@nesvo/contracts';
import { z } from 'zod';

const fileLimit = conversationImportLimit / 2;
const entryLimit = 8192;
export const fileByteLimit = 8 * 1024 * 1024;
const identityByteLimit = 512 * 1024;
const scanByteLimit = 48 * 1024 * 1024;
const snapshotLimit = 48;
const messageLimit = 6000;
const idAtEnd = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;
const timestamp = z.iso.datetime({ offset: true });
const directory = z.string().min(1).max(4096).refine(isAbsolute);

const bodySchema = z.union([z.string(), z.array(z.unknown())]);
const textBlockSchema = z.object({ type: z.string(), text: z.string() });
const claudeMessage = z.object({
  type: z.enum(['user', 'assistant']),
  sessionId: z.uuid(),
  cwd: directory,
  timestamp,
  isMeta: z.boolean().optional(),
  isSidechain: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  message: z.object({
    role: z.enum(['user', 'assistant']),
    content: bodySchema,
  }),
});
const claudeTitle = z.object({
  type: z.literal('custom-title'),
  sessionId: z.uuid(),
  customTitle: z.string(),
});
const codexMetadata = z.object({
  type: z.literal('session_meta'),
  timestamp,
  payload: z.object({ id: z.uuid(), cwd: directory }),
});
const codexMessage = z.object({
  type: z.literal('response_item'),
  timestamp,
  payload: z.object({
    type: z.literal('message'),
    role: z.enum(['user', 'assistant']),
    content: z.array(z.unknown()),
  }),
});
const recordType = z.object({ type: z.string() });

type Message = { author: 'operator' | 'agent'; body: string; at: string };
type Conversation = Omit<
  ConversationImportCatalog['conversations'][number],
  'adopted'
>;
export type Transcript = { conversation: Conversation; messages: Message[] };
export type TranscriptFile = {
  path: string;
  id: string;
  size: number;
  modifiedAt: number;
};
type File = TranscriptFile;
type Inventory = { files: File[]; skippedFiles: number; truncated: boolean };
export type TranscriptLimits = { messages: number; characters: number };
const snapshotLimits: TranscriptLimits = {
  messages: snapshotLimit,
  characters: messageLimit,
};

function redact(text: string) {
  return text
    .replace(
      /-----BEGIN [^\r\n-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^\r\n-]*PRIVATE KEY-----|$)/g,
      '[redacted]',
    )
    .replace(
      /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
      '[redacted]',
    )
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^/\s@]+:[^/\s@]+@/gi, '$1[redacted]@')
    .replace(
      /((?:api[_-]?key|secret(?:[_-]?key)?|password|passwd|token|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      '$1[redacted]',
    );
}

function excerpt(text: string, max: number) {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

function messageText(content: z.infer<typeof bodySchema>, blockType: string) {
  const blocks =
    typeof content === 'string'
      ? [content]
      : content.flatMap(value => {
          const block = textBlockSchema.safeParse(value);
          return block.success && block.data.type === blockType
            ? [block.data.text]
            : [];
        });
  return redact(
    blocks
      .map(text => text.trim())
      .filter(
        text =>
          !/^(?:<(?:environment_context|permissions instructions|collaboration_mode|skills_instructions|user_instructions|system-reminder|local-command|command-name|command-message|command-args)|# AGENTS\.md instructions\b)/i.test(
            text,
          ),
      )
      .join('\n'),
  ).trim();
}

function parseTranscript(
  text: string,
  file: File,
  provider: Provider,
  limits: TranscriptLimits,
): Transcript | undefined {
  let cwd: string | undefined;
  let title = '';
  let firstPrompt = '';
  let messageCount = 0;
  const messages: Message[] = [];
  const add = (role: 'user' | 'assistant', body: string, at: string) => {
    if (!body) return;
    if (role === 'user' && !firstPrompt) firstPrompt = body;
    messageCount++;
    if (messages.length === limits.messages) messages.shift();
    messages.push({
      author: role === 'user' ? 'operator' : 'agent',
      body: excerpt(body, limits.characters),
      at: new Date(at).toISOString(),
    });
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const record: unknown = JSON.parse(line);
    const kind = recordType.safeParse(record);
    if (!kind.success) continue;
    if (provider === 'Claude Code') {
      if (kind.data.type === 'custom-title') {
        const result = claudeTitle.safeParse(record);
        if (result.success && result.data.sessionId === file.id)
          title = redact(result.data.customTitle).trim();
      }
      if (kind.data.type !== 'user' && kind.data.type !== 'assistant') continue;
      const result = claudeMessage.safeParse(record);
      if (!result.success) continue;
      const row = result.data;
      if (
        row.sessionId !== file.id ||
        row.type !== row.message.role ||
        row.isMeta ||
        row.isSidechain ||
        row.isCompactSummary
      )
        continue;
      cwd ??= row.cwd;
      add(row.type, messageText(row.message.content, 'text'), row.timestamp);
    } else {
      if (kind.data.type === 'session_meta') {
        const result = codexMetadata.safeParse(record);
        if (!result.success || result.data.payload.id !== file.id) return;
        cwd ??= result.data.payload.cwd;
      }
      if (kind.data.type !== 'response_item' || !cwd) continue;
      const result = codexMessage.safeParse(record);
      if (!result.success) continue;
      const { role, content } = result.data.payload;
      add(
        role,
        messageText(content, role === 'user' ? 'input_text' : 'output_text'),
        result.data.timestamp,
      );
    }
  }
  if (!cwd || !messages.length) return;
  return {
    conversation: {
      provider,
      providerSessionId: file.id,
      directory: cwd,
      title: excerpt(
        (title || firstPrompt).replace(/\s+/g, ' ').trim() ||
          'Imported conversation',
        100,
      ),
      lastActivityAt: new Date(file.modifiedAt).toISOString(),
      messageCount,
      preview: excerpt(firstPrompt || messages[0]!.body, 480),
    },
    messages,
  };
}

function roots(provider: Provider, configDirectory?: string) {
  return provider === 'Claude Code'
    ? {
        root: resolve(
          configDirectory ||
            process.env.CLAUDE_CONFIG_DIR?.trim() ||
            join(homedir(), '.claude'),
          'projects',
        ),
        depth: 1,
      }
    : {
        root: resolve(
          configDirectory ||
            process.env.CODEX_HOME?.trim() ||
            join(homedir(), '.codex'),
          'sessions',
        ),
        depth: 3,
      };
}

export async function inventory(
  provider: Provider,
  signal: AbortSignal,
  targetId?: string,
  configDirectory?: string,
  matchingIds?: ReadonlySet<string>,
): Promise<Inventory> {
  const { root, depth } = roots(provider, configDirectory);
  const files: File[] = [];
  let skippedFiles = 0;
  let entries = 0;
  let truncated = false;

  const walk = async (folder: string, level: number): Promise<void> => {
    signal.throwIfAborted();
    let handle;
    try {
      if (configDirectory && !(await lstat(folder)).isDirectory()) {
        skippedFiles++;
        return;
      }
      handle = await opendir(folder);
    } catch (error) {
      if (level !== 0 || (error as NodeJS.ErrnoException).code !== 'ENOENT')
        skippedFiles++;
      return;
    }
    for await (const entry of handle) {
      signal.throwIfAborted();
      if (!matchingIds && ++entries > entryLimit) {
        truncated = true;
        return;
      }
      const path = join(folder, entry.name);
      if (entry.isDirectory() && level < depth) {
        await walk(path, level + 1);
        if (truncated) return;
      }
      const id = transcriptId(entry, provider, level, depth);
      if (
        !id ||
        (targetId && id !== targetId) ||
        (matchingIds && !matchingIds.has(id))
      )
        continue;
      try {
        const info = await lstat(path);
        if (info.isFile())
          files.push({ path, id, size: info.size, modifiedAt: info.mtimeMs });
        else skippedFiles++;
      } catch {
        skippedFiles++;
      }
    }
  };

  await walk(root, 0);
  files.sort(
    (a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path),
  );
  return { files, skippedFiles, truncated };
}

function transcriptId(
  entry: Dirent,
  provider: Provider,
  level: number,
  depth: number,
) {
  if (!entry.isFile() || level !== depth) return;
  const match = idAtEnd.exec(entry.name);
  if (
    !match ||
    (provider === 'Claude Code'
      ? match.index !== 0
      : !entry.name.startsWith('rollout-'))
  )
    return;
  return match[1];
}

export async function readTranscript(
  file: File,
  provider: Provider,
  signal: AbortSignal,
  limits = snapshotLimits,
) {
  const handle = await open(
    file.path,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > file.size) return;
    const bytes = Buffer.alloc(info.size);
    for (let offset = 0; offset < bytes.length;) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        Math.min(64 * 1024, bytes.length - offset),
        offset,
      );
      if (!bytesRead) return;
      offset += bytesRead;
    }
    return parseTranscript(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      file,
      provider,
      limits,
    );
  } finally {
    await handle.close();
  }
}

async function readRange(
  handle: FileHandle,
  start: number,
  length: number,
  signal: AbortSignal,
) {
  const bytes = Buffer.alloc(length);
  for (let offset = 0; offset < length;) {
    signal.throwIfAborted();
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      Math.min(64 * 1024, length - offset),
      start + offset,
    );
    if (!bytesRead) return;
    offset += bytesRead;
  }
  return bytes;
}

const decode = (bytes: Uint8Array) =>
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);

async function withManagerTranscript<T>(
  file: File,
  read: (handle: FileHandle) => Promise<T | undefined>,
): Promise<T | undefined> {
  const handle = await open(
    file.path,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== file.size ||
      before.mtimeMs !== file.modifiedAt
    )
      return;
    const value = await read(handle);
    const after = await handle.stat();
    if (after.size === before.size && after.mtimeMs === before.mtimeMs)
      return value;
  } finally {
    await handle.close();
  }
}

function transcriptDirectory(text: string, file: File, provider: Provider) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row: unknown = JSON.parse(line);
    if (provider === 'Codex') {
      if (recordType.safeParse(row).data?.type !== 'session_meta') continue;
      const meta = codexMetadata.safeParse(row);
      return meta.success && meta.data.payload.id === file.id
        ? meta.data.payload.cwd
        : undefined;
    }
    const message = claudeMessage.safeParse(row);
    if (
      message.success &&
      message.data.sessionId === file.id &&
      message.data.message.role === message.data.type &&
      !message.data.isMeta &&
      !message.data.isSidechain &&
      !message.data.isCompactSummary
    )
      return message.data.cwd;
  }
}

export async function probeManagerTranscript(
  file: File,
  provider: Provider,
  signal: AbortSignal,
) {
  return withManagerTranscript(file, async handle => {
    const prefix = await readRange(
      handle,
      0,
      Math.min(file.size, identityByteLimit),
      signal,
    );
    if (!prefix) return;
    const text =
      file.size > prefix.length
        ? decode(prefix.subarray(0, Math.max(0, prefix.lastIndexOf(10))))
        : decode(prefix);
    const cwd = transcriptDirectory(text, file, provider);
    if (cwd || provider === 'Codex' || file.size <= prefix.length) return cwd;
    const tail = await readRange(
      handle,
      file.size - identityByteLimit,
      identityByteLimit,
      signal,
    );
    if (tail && tail.includes(10))
      return transcriptDirectory(
        decode(tail.subarray(tail.indexOf(10) + 1)),
        file,
        provider,
      );
  });
}

export async function readManagerTranscript(
  file: File,
  provider: Provider,
  signal: AbortSignal,
) {
  return withManagerTranscript(file, async handle => {
    if (file.size <= fileByteLimit) {
      const bytes = await readRange(handle, 0, file.size, signal);
      return bytes
        ? parseTranscript(decode(bytes), file, provider, snapshotLimits)
        : undefined;
    }
    const head = await readRange(handle, 0, identityByteLimit, signal);
    const tailLength = Math.min(
      file.size - identityByteLimit,
      fileByteLimit - identityByteLimit,
    );
    const tail = await readRange(
      handle,
      file.size - tailLength,
      tailLength,
      signal,
    );
    if (!head || !tail) return;
    const headEnd = head.lastIndexOf(10);
    const tailStart = tail.indexOf(10);
    const prefix = headEnd < 0 ? '' : decode(head.subarray(0, headEnd));
    const suffix = tailStart < 0 ? '' : decode(tail.subarray(tailStart + 1));
    return parseTranscript(
      prefix + '\n' + suffix,
      file,
      provider,
      snapshotLimits,
    );
  });
}

export async function scanConversations(
  provider: Provider,
  signal: AbortSignal,
  targetId?: string,
  configDirectory?: string,
) {
  const { files, skippedFiles, truncated } = await inventory(
    provider,
    signal,
    targetId,
    configDirectory,
  );
  const transcripts: Transcript[] = [];
  let skipped = skippedFiles;
  let bytes = 0;
  let limited = truncated || files.length > fileLimit;
  for (const file of files.slice(0, fileLimit)) {
    signal.throwIfAborted();
    if (file.size > fileByteLimit) {
      skipped++;
      limited = true;
      continue;
    }
    if (bytes + file.size > scanByteLimit) {
      limited = true;
      break;
    }
    bytes += file.size;
    try {
      const transcript = await readTranscript(file, provider, signal);
      if (transcript)
        transcripts.push(
          targetId ? transcript : { ...transcript, messages: [] },
        );
      else skipped++;
    } catch {
      signal.throwIfAborted();
      skipped++;
    }
  }
  return { transcripts, skippedFiles: skipped, truncated: limited };
}
