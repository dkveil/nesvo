import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';

export type SkillSnapshot = {
  path: string;
  baseDirectory: string;
  body: string;
  contentHash: string;
  fields: Record<string, unknown>;
  codexMetadata?: Record<string, unknown>;
};

type FileSnapshot = {
  path: string;
  bytes: Buffer;
  verify: () => Promise<void>;
};

const maxSkillBytes = 64 * 1024;
const maxFrontmatterBytes = 32 * 1024;
const maxCodexMetadataBytes = 16 * 1024;
const readMilliseconds = 3_000;
const staticFields = new Set([
  'name',
  'description',
  'license',
  'metadata',
  'compatibility',
  'argument-hint',
  'version',
  'when_to_use',
  'author',
  'tags',
  'category',
  'homepage',
  'repository',
  'user-invocable',
  'disable-model-invocation',
  'allowed-tools',
]);
const executionFields = new Set([
  'hooks',
  'context',
  'agent',
  'model',
  'background',
  'permission-mode',
  'permissionMode',
  'permissions',
  'tools',
  'disallowed-tools',
  'disallowedTools',
  'allowedTools',
  'arguments',
  'shell',
  'effort',
  'effortLevel',
  'max-turns',
  'maxTurns',
  'mcpServers',
  'mcp-servers',
  'sandbox',
  'skills',
]);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function absent(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function text(bytes: Buffer): string {
  let value: string;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('The selected skill must be valid UTF-8 text.');
  }
  if (value.includes('\0'))
    throw new Error('The selected skill contains binary or NUL data.');
  return value;
}

function yamlMapping(yaml: string): Record<string, unknown> {
  if (/(?:^|[\s,[{])(?:[&*][\w-]+|!!?[^\s]+)/m.test(yaml)) {
    throw new Error(
      'Skill YAML anchors, aliases and explicit tags are not supported.',
    );
  }
  let depth = 0;
  let nodes = 0;
  let parsed: unknown;
  try {
    parsed = load(yaml, {
      schema: JSON_SCHEMA,
      listener: event => {
        if (event === 'open' && (++depth > 12 || ++nodes > 512))
          throw new Error('YAML limit.');
        if (event === 'close') depth--;
      },
    });
  } catch {
    throw new Error(
      'Skill YAML could not be parsed within the supported limits.',
    );
  }
  if (parsed === null || parsed === undefined) return {};
  const fields = object(parsed);
  if (!fields) throw new Error('Skill YAML metadata must be a mapping.');
  return fields;
}

function document(value: string): {
  fields: Record<string, unknown>;
  body: string;
} {
  if (!/^---(?:\r?\n|$)/.test(value)) return { fields: {}, body: value };
  const firstNewline = value.indexOf('\n');
  if (firstNewline < 0)
    throw new Error('Skill frontmatter has no closing delimiter.');
  const header = value.slice(firstNewline + 1);
  const closing = /(?:^|\r?\n)---(?:\r?\n|$)/.exec(header);
  if (!closing) throw new Error('Skill frontmatter has no closing delimiter.');
  const yaml = header.slice(0, closing.index);
  if (Buffer.byteLength(yaml) > maxFrontmatterBytes)
    throw new Error('Skill frontmatter exceeds the 32 KiB limit.');
  return {
    fields: yamlMapping(yaml),
    body: header.slice(closing.index + closing[0].length),
  };
}

export async function readSkillSnapshot(
  path: string,
  signal: AbortSignal,
): Promise<SkillSnapshot> {
  if (!isAbsolute(path))
    throw new Error('The selected skill must have an absolute path.');
  const deadline = Date.now() + readMilliseconds;
  const check = () => {
    if (signal.aborted) throw new Error('Skill reading was cancelled.');
    if (Date.now() >= deadline)
      throw new Error('Skill reading reached its time limit.');
  };
  const io = async <T>(promise: Promise<T>): Promise<T> => {
    try {
      check();
    } catch (error) {
      void promise.catch(() => {});
      throw error;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Skill reading reached its time limit.')),
            Math.max(1, deadline - Date.now()),
          );
          abort = () => reject(new Error('Skill reading was cancelled.'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
    }
  };
  const read = async (
    requested: string,
    limit: number,
  ): Promise<FileSnapshot> => {
    const canonical = await io(realpath(requested));
    const before = await io(lstat(canonical, { bigint: true }));
    if (!before.isFile())
      throw new Error('The selected skill or metadata must be a regular file.');
    if (before.size > BigInt(limit))
      throw new Error(`Skill file exceeds its ${limit / 1024} KiB limit.`);
    const opening = open(
      canonical,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    let file;
    try {
      file = await io(opening);
    } catch (error) {
      void opening
        .then(
          value => value.close(),
          () => {},
        )
        .catch(() => {});
      throw error;
    }
    const verify = async () => {
      if (
        pathKey(await io(realpath(requested))) !== pathKey(canonical) ||
        pathKey(await io(realpath(canonical))) !== pathKey(canonical)
      ) {
        throw new Error(
          'The selected skill path changed while being read. Refresh the skill list.',
        );
      }
      const current = await io(lstat(canonical, { bigint: true }));
      if (!current.isFile() || !sameIdentity(before, current))
        throw new Error(
          'The selected skill file changed while being read. Refresh the skill list.',
        );
    };
    try {
      if (!sameIdentity(before, await io(file.stat({ bigint: true }))))
        throw new Error(
          'The selected skill file changed before it could be read.',
        );
      const buffer = Buffer.alloc(limit + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const read = await io(
          file.read(buffer, offset, buffer.length - offset, offset),
        );
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      if (offset > limit)
        throw new Error(`Skill file exceeds its ${limit / 1024} KiB limit.`);
      if (!sameIdentity(before, await io(file.stat({ bigint: true }))))
        throw new Error('The selected skill file changed while being read.');
      await verify();
      return { path: canonical, bytes: buffer.subarray(0, offset), verify };
    } finally {
      void file.close().catch(() => {});
    }
  };
  check();
  const skill = await read(path, maxSkillBytes);
  const parsed = document(text(skill.bytes));
  const metadataPath = join(dirname(skill.path), 'agents', 'openai.yaml');
  let codexMetadata: Record<string, unknown> | undefined;
  let metadata: FileSnapshot | undefined;
  let metadataMissing = false;
  try {
    await io(lstat(metadataPath));
  } catch (error) {
    if (absent(error)) metadataMissing = true;
    else throw error;
  }
  if (!metadataMissing) {
    metadata = await read(metadataPath, maxCodexMetadataBytes);
    codexMetadata = yamlMapping(text(metadata.bytes));
  }
  await skill.verify();
  if (metadata) await metadata.verify();
  else {
    let stillMissing = false;
    try {
      await io(lstat(metadataPath));
    } catch (error) {
      if (absent(error)) stillMissing = true;
      else throw error;
    }
    if (!stillMissing)
      throw new Error(
        'Skill metadata appeared while the skill was being read. Refresh the skill list.',
      );
  }
  check();
  return {
    path: skill.path,
    baseDirectory: dirname(skill.path),
    body: parsed.body,
    contentHash: createHash('sha256').update(skill.bytes).digest('hex'),
    fields: parsed.fields,
    ...(codexMetadata ? { codexMetadata } : {}),
  };
}

function boolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true;
  if (['false', 'no', 'off', '0'].includes(normalized)) return false;
  return null;
}

export function skillCompatibility(
  snapshot: SkillSnapshot,
  provider: 'Codex' | 'Claude Code',
): string | null {
  for (const name of Object.keys(snapshot.fields)) {
    if (executionFields.has(name))
      return `The ${name} directive requires native skill behavior and is not supported by shared instructions.`;
    if (!staticFields.has(name))
      return `The ${name} frontmatter field is not supported by shared instructions.`;
  }
  for (const name of ['user-invocable', 'disable-model-invocation']) {
    if (
      Object.hasOwn(snapshot.fields, name) &&
      boolean(snapshot.fields[name]) === null
    )
      return `The ${name} declaration is not a supported Boolean.`;
  }
  if (boolean(snapshot.fields['user-invocable']) === false)
    return 'This skill declares user-invocable: false and cannot be selected explicitly.';
  if (Object.hasOwn(snapshot.fields, 'allowed-tools')) {
    if (provider === 'Codex')
      return 'Claude allowed-tools declarations are not portable to Codex shared instructions.';
    const value = snapshot.fields['allowed-tools'];
    const tools =
      typeof value === 'string'
        ? value.split(/[\s,]+/).filter(Boolean)
        : Array.isArray(value) && value.every(tool => typeof tool === 'string')
          ? value
          : null;
    if (!tools || tools.some(tool => !['Read', 'Glob', 'Grep'].includes(tool)))
      return 'This skill declares tools outside the Claude Read, Glob and Grep allowlist.';
  }
  if (/(?:^|\s)!`/m.test(snapshot.body))
    return 'Dynamic shell command injection is not supported by shared instructions.';
  if (
    /\$ARGUMENTS(?:\b|\[)|\$\d+\b|\$\{(?:CLAUDE|CODEX)[A-Z0-9_]*\}|\$(?:CLAUDE|CODEX)[A-Z0-9_]*\b/.test(
      snapshot.body,
    )
  )
    return 'Provider argument or directory substitutions are not supported by shared instructions.';
  if (!snapshot.body.trim())
    return 'The selected skill has no instruction body.';
  const metadata = snapshot.codexMetadata;
  if (metadata) {
    if (
      Object.keys(metadata).some(
        name => !['interface', 'policy', 'dependencies'].includes(name),
      )
    )
      return 'The skill has unsupported agents/openai.yaml metadata.';
    if (metadata.policy !== undefined) {
      const policy = object(metadata.policy);
      if (
        !policy ||
        Object.keys(policy).some(
          name => name !== 'allow_implicit_invocation',
        ) ||
        (policy.allow_implicit_invocation !== undefined &&
          boolean(policy.allow_implicit_invocation) === null)
      )
        return 'The skill has unsupported Codex invocation policy metadata.';
    }
    if (metadata.dependencies !== undefined) {
      const dependencies = object(metadata.dependencies);
      if (
        !dependencies ||
        Object.keys(dependencies).some(name => name !== 'tools') ||
        (dependencies.tools !== undefined &&
          (!Array.isArray(dependencies.tools) || dependencies.tools.length > 0))
      )
        return 'This skill declares tool dependencies that shared instructions cannot provide.';
    }
  }
  return null;
}

export function sharedSkillPrompt(
  snapshot: SkillSnapshot,
  prompt: string,
): string {
  return [
    'The user explicitly selected the following file as shared instructions for this request. This is instruction text, not a native skill invocation. Existing provider tools and permissions remain unchanged.',
    `Source file: ${JSON.stringify(snapshot.path)}`,
    `Base directory for relative resource references: ${JSON.stringify(snapshot.baseDirectory)}`,
    `Source file SHA-256: ${snapshot.contentHash}`,
    'Supporting files remain subject to existing provider permissions. Apply the selected instructions to the user request below.',
    '',
    '<shared-skill-instructions>',
    snapshot.body,
    '</shared-skill-instructions>',
    '',
    'User request:',
    prompt,
  ].join('\n');
}
