import {
  inboxRuleFieldsSchema,
  matchesNameFilter,
  inboxRuleLimits,
  type InboxRule,
  type InboxRuleIssue,
  type InboxRuleScope,
} from '@nesvo/contracts';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { ZodIssue } from 'zod';
import { document } from '../skills/portable';
import {
  DefinitionError,
  globalRoot,
  missing,
  readDefinitionFile,
  type DefinitionFile,
} from '../workflows/definitions';
import { ConfigurationRefusal } from '../workflows/configuration-changes';

const subject = 'Inbox rule';
const knownFields = Object.keys(inboxRuleFieldsSchema.shape).filter(
  field => field !== 'body',
);

export class InboxRuleFileError extends Error {
  readonly code: 'invalid-request' | 'busy' | 'not-found' | 'unavailable';
  readonly issues: InboxRuleIssue[];

  constructor(
    code: InboxRuleFileError['code'],
    message: string,
    issues: InboxRuleIssue[] = [],
  ) {
    super(message);
    this.name = 'InboxRuleFileError';
    this.code = code;
    this.issues = issues;
  }
}

export type RuleFile = {
  scope: InboxRuleScope;
  path: string;
  text: string;
  contentHash: string;
  name: string;
  rule: InboxRule | null;
  issues: InboxRuleIssue[];
  fromProfile?: boolean;
};

export const globalRulesRoot = () => join(dirname(globalRoot()), 'inbox-rules');

export const projectRulesRoot = (projectRoot: string) =>
  join(projectRoot, '.agents', 'inbox-rules');

const issue = (
  path: string,
  message: string,
  line: number | null = null,
  severity: InboxRuleIssue['severity'] = 'error',
): InboxRuleIssue => ({
  severity,
  path: path.slice(0, inboxRuleLimits.path),
  line,
  message:
    message.length > inboxRuleLimits.issueMessage
      ? message.slice(0, inboxRuleLimits.issueMessage - 1) + '…'
      : message,
});

const fieldLine = (yaml: string | null, field: string): number | null => {
  if (yaml === null) return null;
  const index = yaml
    .split(/\r?\n/)
    .findIndex(line => line.trimStart().startsWith(`${field}:`));
  return index < 0 ? null : index + 2;
};

function fieldIssue(
  problem: ZodIssue,
  field: string,
  raw: unknown,
): Pick<InboxRuleIssue, 'message' | 'choices'> {
  if (problem.code === 'custom') return { message: problem.message };
  const index = problem.path[1];
  const value =
    Array.isArray(raw) && typeof index === 'number' ? raw[index] : raw;
  if (value === undefined) return { message: `Enter a value for “${field}”.` };
  switch (problem.code) {
    case 'invalid_value':
      return {
        message:
          typeof value === 'string' && value
            ? `Unknown ${field} “${value.slice(0, 48)}”.`
            : `Choose a valid value for “${field}”.`,
        choices: problem.values.map(String),
      };
    case 'invalid_format':
      return { message: 'Use lowercase letters, digits and inner hyphens.' };
    case 'invalid_type': {
      const expected = {
        boolean: 'Use true or false.',
        array: 'Enter a list of values.',
        number: 'Enter a number.',
      };
      return {
        message:
          expected[problem.expected as keyof typeof expected] ?? 'Enter text.',
      };
    }
    case 'too_small':
      if (problem.origin === 'array')
        return { message: `Enter at least ${problem.minimum} items.` };
      return {
        message:
          problem.origin === 'string'
            ? 'Enter a value.'
            : 'Enter an amount greater than zero.',
      };
    case 'too_big': {
      const unit =
        problem.origin === 'array'
          ? ' items'
          : problem.origin === 'string'
            ? ' characters'
            : '';
      return { message: `Use at most ${problem.maximum}${unit}.` };
    }
    default:
      return { message: 'Check this field’s value.' };
  }
}

export const hashText = (text: string) =>
  createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

export const parseRuleText = (
  text: string,
  path: string,
  expectedName?: string,
): { rule: InboxRule | null; name: string; issues: InboxRuleIssue[] } => {
  const issues: InboxRuleIssue[] = [];
  if (Buffer.byteLength(text, 'utf8') > inboxRuleLimits.fileBytes)
    return {
      rule: null,
      name: expectedName ?? '',
      issues: [
        issue(
          path,
          `An Inbox rule file is at most ${inboxRuleLimits.fileBytes / 1024} KiB.`,
        ),
      ],
    };
  let split: ReturnType<typeof document>;
  try {
    split = document(text, subject);
  } catch {
    return {
      rule: null,
      name: expectedName ?? '',
      issues: [
        issue(
          path,
          'Check YAML indentation and punctuation between the --- lines.',
          1,
        ),
      ],
    };
  }
  const { fields, body, yaml } = split;
  const name = typeof fields.name === 'string' ? fields.name : '';
  if (yaml === null)
    return {
      rule: null,
      name: name || expectedName || '',
      issues: [issue(path, 'Put your rule settings between two --- lines.', 1)],
    };
  for (const field of Object.keys(fields))
    if (!knownFields.includes(field))
      issues.push({
        ...issue(
          path,
          `Remove the unknown field “${field.slice(0, 64)}”.`,
          fieldLine(yaml, field),
        ),
        field: field.slice(0, 64),
      });
  const parsed = inboxRuleFieldsSchema.safeParse({
    ...Object.fromEntries(
      Object.entries(fields).filter(([field]) => knownFields.includes(field)),
    ),
    body: body.trim(),
  });
  const reported = new Set<string>();
  if (!parsed.success)
    for (const problem of parsed.error.issues) {
      const field = String(problem.path[0] ?? 'rule');
      if (reported.has(field) || reported.size >= 20) continue;
      reported.add(field);
      const { message, choices } = fieldIssue(
        problem,
        field,
        field === 'body' ? body.trim() : fields[field],
      );
      issues.push({
        ...issue(
          path,
          message,
          field === 'body' ? null : fieldLine(yaml, field),
        ),
        field,
        ...(choices?.length ? { choices } : {}),
      });
    }
  if (expectedName && name && name !== expectedName && !reported.has('name'))
    issues.push({
      ...issue(
        path,
        `Use “${expectedName}” to match the file name.`,
        fieldLine(yaml, 'name'),
      ),
      field: 'name',
    });
  const failed = issues.some(item => item.severity === 'error');
  return {
    rule: failed || !parsed.success ? null : parsed.data,
    name: name || expectedName || '',
    issues,
  };
};

export const readRuleRoot = async (
  root: string,
  scope: InboxRuleScope,
  signal: AbortSignal,
  issues: InboxRuleIssue[],
): Promise<RuleFile[]> => {
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'));
  } catch (error) {
    if (missing(error)) return [];
    issues.push(issue(root, 'The Inbox rules folder cannot be read.'));
    return [];
  }
  if (entries.length > inboxRuleLimits.rules) {
    issues.push(
      issue(
        root,
        `Only the first ${inboxRuleLimits.rules} Inbox rules of this folder are read.`,
        null,
        'warning',
      ),
    );
    entries = entries.slice(0, inboxRuleLimits.rules);
  }
  const files: RuleFile[] = [];
  for (const entry of entries) {
    const path = join(root, entry);
    const expected = entry.slice(0, -'.md'.length);
    try {
      const file = await readDefinitionFile(path, signal);
      const parsed = parseRuleText(file.text, file.path, expected);
      files.push({
        scope,
        path: file.path,
        text: file.text,
        contentHash: file.contentHash,
        ...parsed,
      });
    } catch (error) {
      issues.push(
        issue(
          path,
          error instanceof DefinitionError || error instanceof Error
            ? error.message
            : 'The Inbox rule cannot be read.',
        ),
      );
    }
  }
  return files;
};

const ruleFileName = (name: string) => `${name}.md`;

const currentHash = async (path: string, signal: AbortSignal) => {
  try {
    return (await readDefinitionFile(path, signal)).contentHash;
  } catch (error) {
    if (
      error instanceof DefinitionError &&
      /does not exist/.test(error.message)
    )
      return null;
    try {
      await lstat(path);
    } catch (statError) {
      if (missing(statError)) return null;
    }
    throw error;
  }
};

const locks = new Map<string, Promise<unknown>>();

const exclusive = async <T>(key: string, work: () => Promise<T>) => {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
};

const conflict = () =>
  new InboxRuleFileError(
    'busy',
    'The rule file changed on disk. Reload the rules and try again.',
  );

async function replaceRule(
  root: string,
  name: string,
  path: string,
  text: string,
  beforeReplace?: () => Promise<void>,
): Promise<void> {
  const temporary = join(root, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
      flush: true,
    });
    await beforeReplace?.();
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function withConfigRuleFile<T>(
  anchor: string,
  root: string,
  name: string,
  signal: AbortSignal,
  access: () => Promise<void>,
  use: (
    file: DefinitionFile | null,
    identity: string,
    write: (text: string | null, authorize: () => void) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const confined = relative(anchor, root);
  if (!confined || isAbsolute(confined) || confined.split(sep).includes('..'))
    throw new ConfigurationRefusal(
      'invalid-request',
      'Choose an Inbox rule inside the verified root.',
    );
  const path = join(root, ruleFileName(name));
  const identity = async () => {
    const canonical = await realpath(anchor);
    const stat = await lstat(anchor, { bigint: true });
    if (canonical !== anchor || !stat.isDirectory() || stat.isSymbolicLink())
      throw new ConfigurationRefusal('conflict', 'The Inbox rule root moved.');
    let directory = anchor;
    for (const component of confined.split(sep)) {
      directory = join(directory, component);
      const info = await lstat(directory).catch(error => {
        if (!missing(error)) throw error;
        return null;
      });
      if (info && (!info.isDirectory() || info.isSymbolicLink()))
        throw new ConfigurationRefusal(
          'conflict',
          'The Inbox rules folder is no longer confined to its root.',
        );
    }
    return JSON.stringify([anchor, String(stat.dev), String(stat.ino), root]);
  };
  const read = async () => {
    const stat = await lstat(path).catch(error => {
      if (!missing(error)) throw error;
      return null;
    });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new ConfigurationRefusal(
        'conflict',
        'The Inbox rule is no longer a regular file.',
      );
    return readDefinitionFile(path, signal);
  };
  return exclusive(root, async () => {
    await access();
    const rootIdentity = await identity();
    const file = await read();
    const check = async () => {
      if (
        (await identity()) !== rootIdentity ||
        (await read())?.contentHash !== file?.contentHash
      )
        throw new ConfigurationRefusal(
          'conflict',
          'The Inbox rule or its root changed on disk.',
        );
    };
    return use(file, rootIdentity, async (text, authorize) => {
      await access();
      await check();
      if (text === null) {
        authorize();
        await rm(path);
        return;
      }
      await mkdir(root, { recursive: true, mode: 0o700 });
      await check();
      await replaceRule(root, name, path, text, async () => {
        await check();
        authorize();
      });
    });
  });
}

export const writeRuleFile = (
  root: string,
  text: string,
  expectedHash: string | null,
  previousName: string | undefined,
  signal: AbortSignal,
) =>
  exclusive(root, async () => {
    const parsed = parseRuleText(text, join(root, 'new.md'));
    if (!parsed.rule)
      throw new InboxRuleFileError(
        'invalid-request',
        'The rule is not valid.',
        parsed.issues,
      );
    const name = parsed.rule.name;
    const path = join(root, ruleFileName(name));
    const renamedFrom =
      previousName && previousName !== name
        ? join(root, ruleFileName(previousName))
        : null;
    const existing = await currentHash(path, signal);
    if (renamedFrom) {
      if (existing !== null)
        throw new InboxRuleFileError(
          'invalid-request',
          `A rule named "${name}" already exists.`,
        );
      if ((await currentHash(renamedFrom, signal)) !== expectedHash)
        throw conflict();
    } else if (existing !== expectedHash) throw conflict();
    await mkdir(root, { recursive: true });
    try {
      await replaceRule(root, name, path, text);
    } catch (error) {
      throw new InboxRuleFileError(
        'unavailable',
        `The rule could not be written. ${error instanceof Error ? error.message : ''}`.trim(),
      );
    }
    if (renamedFrom) await rm(renamedFrom, { force: true });
    return path;
  });

export const deleteRuleFile = (
  root: string,
  name: string,
  expectedHash: string,
  signal: AbortSignal,
) =>
  exclusive(root, async () => {
    const path = join(root, ruleFileName(name));
    const existing = await currentHash(path, signal);
    if (existing === null)
      throw new InboxRuleFileError('not-found', 'The rule no longer exists.');
    if (existing !== expectedHash) throw conflict();
    await rm(path);
  });

export const withEnabled = (text: string, enabled: boolean) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match)
    throw new InboxRuleFileError(
      'invalid-request',
      'The rule needs YAML frontmatter between --- lines.',
    );
  const yaml = match[1]!;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = yaml.split(/\r?\n/);
  const index = lines.findIndex(line => /^enabled\s*:/.test(line));
  const line = `enabled: ${enabled}`;
  if (index >= 0) lines[index] = line;
  else {
    const nameIndex = lines.findIndex(entry => /^name\s*:/.test(entry));
    lines.splice(nameIndex >= 0 ? nameIndex + 1 : 0, 0, line);
  }
  return `---${newline}${lines.join(newline)}${newline}---${text.slice(match[0].length)}`;
};

export const ruleFileFingerprints = async (
  projectRoot: string,
  signal: AbortSignal,
) => {
  const issues: InboxRuleIssue[] = [];
  const files = await readRuleRoot(
    projectRulesRoot(projectRoot),
    'project',
    signal,
    issues,
  );
  return {
    files: files.map(file => ({
      name: file.name || file.path,
      path: file.path,
      bytes: Buffer.byteLength(file.text, 'utf8'),
      hash: hashText(file.text),
    })),
    unreadable: issues.some(item => item.severity === 'error'),
  };
};

export const workflowStepGuards = async (
  projectRoot: string,
  signal: AbortSignal,
): Promise<
  (workflow: string, step: string, phase: InboxRule['phase']) => boolean
> => {
  const issues: InboxRuleIssue[] = [];
  const files = [
    ...(await readRuleRoot(globalRulesRoot(), 'global', signal, issues).catch(
      () => [],
    )),
    ...(await readRuleRoot(
      projectRulesRoot(projectRoot),
      'project',
      signal,
      issues,
    ).catch(() => [])),
  ];
  const guards = files.flatMap(file =>
    file.rule?.enabled &&
    file.rule.action === 'hold' &&
    file.rule.trigger === 'workflow-step' &&
    !file.rule.group &&
    !file.rule.computer &&
    (!file.rule.repository ||
      matchesNameFilter(file.rule.repository, basename(projectRoot)))
      ? [file.rule]
      : [],
  );
  return (workflow, step, phase) =>
    guards.some(
      rule =>
        (!rule.workflow || matchesNameFilter(rule.workflow, workflow)) &&
        (!rule.step || matchesNameFilter(rule.step, step)) &&
        (!rule.phase || rule.phase === phase),
    );
};
