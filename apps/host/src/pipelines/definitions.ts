import {
  definitionCatalogSchema,
  pipelineDefinitionLimits,
  pipelineDefinitionSchema,
  stepDefinitionSchema,
  taskSpecSchema,
  type DefinitionCatalog,
  type DefinitionIssue,
  type DefinitionScope,
  type DefinitionSource,
  type PipelineDefinition,
  type ResolvedPipeline,
  type ResolvedStep,
  type StepDefinition,
  type StepPhase,
  type TaskSpec,
  type TaskSpecSummary,
} from '@nesvo/contracts';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats, type Dirent } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { document, text } from '../skills/portable';
import { YamlLimitError } from '../skills/yaml-limits';

export const definitionReadLimits = {
  fileBytes: 64 * 1024,
  inventoryMilliseconds: 3_000,
  concurrentReads: 8,
  ancestorDepth: 64,
} as const;

export type DefinitionFile = {
  path: string;
  text: string;
  contentHash: string;
};

export type LoadedSpec = {
  spec: TaskSpec;
  source: DefinitionSource;
};

export type DefinitionErrorKind =
  | 'invalid'
  | 'not-found'
  | 'cancelled'
  | 'timeout'
  | 'busy'
  | 'unavailable';

export class DefinitionError extends Error {
  readonly kind: DefinitionErrorKind;
  readonly issues: DefinitionIssue[];

  constructor(
    kind: DefinitionErrorKind,
    message: string,
    issues: DefinitionIssue[] = [],
  ) {
    super(message);
    this.name = 'DefinitionError';
    this.kind = kind;
    this.issues = issues;
  }
}

class FileIssue extends Error {
  readonly line: number | null;

  constructor(message: string, line: number | null = null) {
    super(message);
    this.line = line;
  }
}

type ReadContext = {
  signal: AbortSignal;
  caller: AbortSignal;
};

type Parsed<T> = {
  name: string | null;
  value: T | null;
  file: DefinitionFile;
  yaml: string | null;
};

type Entry<T> = {
  scope: DefinitionScope;
  parsed: Parsed<T>;
};

type Kind = 'step' | 'pipeline' | 'spec';

type SchemaIssue = {
  code: string;
  path: PropertyKey[];
  message: string;
  values?: readonly unknown[];
  expected?: string;
};

type DocumentSchema<T> = {
  safeParse: (
    value: unknown,
  ) =>
    | { success: true; data: T }
    | { success: false; error: { issues: SchemaIssue[] } };
};

const subject = 'Definition';
const externalEffectPattern = /\bgit\s+push\b|\bgh\s+pr\b|\bcurl\b|\bwget\b/;
const phaseOrder: Record<StepPhase, number> = {
  plan: 0,
  'pre-done': 1,
  'pre-push': 2,
};
const knownFields: Record<Kind, readonly string[]> = {
  step: [
    'name',
    'type',
    'phase',
    'skill',
    'timeout',
    'retries',
    'on_fail',
    'effect',
    'needs',
  ],
  pipeline: ['name', 'description', 'steps'],
  spec: ['pipeline', 'title'],
};
const kindLabels: Record<Kind, string> = {
  step: 'step',
  pipeline: 'pipeline',
  spec: 'task spec',
};
const fileLimits = {
  step: pipelineDefinitionLimits.catalogSteps,
  pipeline: pipelineDefinitionLimits.catalogPipelines,
  spec: pipelineDefinitionLimits.catalogSpecs,
} as const;

export function missing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );
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

export function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep);
}

function bounded(message: string): string {
  return message.length > pipelineDefinitionLimits.issueMessage
    ? message.slice(0, pipelineDefinitionLimits.issueMessage - 1) + '…'
    : message;
}

function issue(
  path: string,
  message: string,
  line: number | null = null,
  severity: DefinitionIssue['severity'] = 'error',
): DefinitionIssue {
  return { severity, path, line, message: bounded(message) };
}

function context(caller: AbortSignal): ReadContext {
  return {
    caller,
    signal: AbortSignal.any([
      caller,
      AbortSignal.timeout(definitionReadLimits.inventoryMilliseconds),
    ]),
  };
}

function interruption(read: ReadContext): DefinitionError {
  return read.caller.aborted
    ? new DefinitionError(
        'cancelled',
        'Reading pipeline definitions was cancelled.',
      )
    : new DefinitionError(
        'timeout',
        `Reading pipeline definitions reached its ${definitionReadLimits.inventoryMilliseconds / 1000} s limit.`,
      );
}

async function io<T>(read: ReadContext, promise: Promise<T>): Promise<T> {
  if (read.signal.aborted) {
    void promise.catch(() => {});
    throw interruption(read);
  }
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(interruption(read));
        read.signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) read.signal.removeEventListener('abort', abort);
  }
}

async function mapBounded<T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index] as T);
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(definitionReadLimits.concurrentReads, items.length),
      },
      worker,
    ),
  );
  return results;
}

async function readFile(
  requested: string,
  read: ReadContext,
): Promise<DefinitionFile> {
  if (!isAbsolute(requested))
    throw new FileIssue('Use an absolute path for the definition file.');
  let path: string;
  try {
    path = join(await io(read, realpath(dirname(requested))), basename(requested));
  } catch (error) {
    if (error instanceof DefinitionError) throw error;
    throw new FileIssue(
      missing(error)
        ? 'The file does not exist.'
        : 'The file cannot be accessed.',
    );
  }
  let before: BigIntStats;
  try {
    before = await io(read, lstat(path, { bigint: true }));
  } catch (error) {
    if (error instanceof DefinitionError) throw error;
    throw new FileIssue(
      missing(error)
        ? 'The file does not exist.'
        : 'The file cannot be accessed.',
    );
  }
  if (before.isSymbolicLink())
    throw new FileIssue('Symbolic links are not read. Use a regular file.');
  if (!before.isFile()) throw new FileIssue('The path is not a regular file.');
  const limit = definitionReadLimits.fileBytes;
  const tooLarge = `The file exceeds the ${limit / 1024} KiB limit.`;
  if (before.size > BigInt(limit)) throw new FileIssue(tooLarge);
  const opening = open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  let file;
  try {
    file = await io(read, opening);
  } catch (error) {
    void opening.then(
      value => value.close().catch(() => {}),
      () => {},
    );
    if (error instanceof DefinitionError) throw error;
    throw new FileIssue('The file cannot be opened.');
  }
  try {
    const changed = new FileIssue(
      'The file changed while being read. Refresh the definitions.',
    );
    if (!sameIdentity(before, await io(read, file.stat({ bigint: true }))))
      throw changed;
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const chunk = await io(
        read,
        file.read(buffer, offset, buffer.length - offset, offset),
      );
      if (!chunk.bytesRead) break;
      offset += chunk.bytesRead;
    }
    if (offset > limit) throw new FileIssue(tooLarge);
    if (!sameIdentity(before, await io(read, file.stat({ bigint: true }))))
      throw changed;
    const after = await io(read, lstat(path, { bigint: true }));
    if (
      !after.isFile() ||
      !sameIdentity(before, after) ||
      pathKey(await io(read, realpath(path))) !== pathKey(path)
    )
      throw changed;
    const bytes = buffer.subarray(0, offset);
    let value: string;
    try {
      value = text(bytes, 'The file');
    } catch (error) {
      throw new FileIssue((error as Error).message);
    }
    return {
      path,
      text: value,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    void file.close().catch(() => {});
  }
}

export async function readDefinitionFile(
  path: string,
  signal: AbortSignal,
): Promise<DefinitionFile> {
  const read = context(signal);
  try {
    return await readFile(path, read);
  } catch (error) {
    if (error instanceof FileIssue)
      throw new DefinitionError('invalid', error.message, [
        issue(path, error.message),
      ]);
    throw error;
  }
}

async function exists(path: string, read: ReadContext): Promise<boolean> {
  try {
    await io(read, lstat(path));
    return true;
  } catch (error) {
    if (error instanceof DefinitionError) throw error;
    return false;
  }
}

async function projectRoot(
  directory: string,
  read: ReadContext,
): Promise<string> {
  let current = directory;
  for (let depth = 0; depth < definitionReadLimits.ancestorDepth; depth++) {
    if (await exists(join(current, '.git'), read)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directory;
}

function globalRoot(): string {
  const override = process.env.NESVO_PIPELINES_HOME;
  return process.env.NESVO_TEST_MODE === '1' && override && isAbsolute(override)
    ? override
    : join(homedir(), '.agents', 'pipelines');
}

async function canonicalDirectory(
  directory: string,
  read: ReadContext,
): Promise<string> {
  const unavailable = new DefinitionError(
    'not-found',
    'The directory does not exist or cannot be accessed. Enter its absolute path.',
  );
  if (!isAbsolute(directory)) throw unavailable;
  try {
    const path = await io(read, realpath(directory));
    if ((await io(read, lstat(path))).isDirectory()) return path;
  } catch (error) {
    if (error instanceof DefinitionError) throw error;
  }
  throw unavailable;
}

async function canonicalRoot(
  path: string,
  read: ReadContext,
): Promise<string | null> {
  try {
    const canonical = await io(read, realpath(path));
    return (await io(read, lstat(canonical))).isDirectory() ? canonical : null;
  } catch (error) {
    if (error instanceof DefinitionError) throw error;
    return null;
  }
}

async function listMarkdown(
  folder: string,
  kind: Kind,
  read: ReadContext,
  issues: DefinitionIssue[],
): Promise<DefinitionFile[]> {
  let entries: Dirent[];
  try {
    const status = await io(read, lstat(folder));
    if (status.isSymbolicLink()) {
      issues.push(
        issue(folder, 'Symbolic links are not read. Use a regular folder.'),
      );
      return [];
    }
    if (!status.isDirectory()) {
      issues.push(issue(folder, 'The path is not a folder.'));
      return [];
    }
    entries = await io(read, readdir(folder, { withFileTypes: true }));
  } catch (error) {
    if (error instanceof DefinitionError) throw error;
    if (!missing(error))
      issues.push(issue(folder, 'The folder cannot be read.'));
    return [];
  }
  const markdown = entries
    .filter(entry => entry.name.endsWith('.md'))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const limit = fileLimits[kind];
  if (markdown.length > limit)
    issues.push(
      issue(
        folder,
        `The folder has ${markdown.length} ${kindLabels[kind]} files; only the first ${limit} are read.`,
      ),
    );
  const results = await mapBounded(
    markdown.slice(0, limit),
    async (entry): Promise<DefinitionFile | DefinitionIssue | null> => {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink())
        return issue(path, 'Symbolic links are not read. Use a regular file.');
      if (!entry.isFile()) return null;
      try {
        return await readFile(path, read);
      } catch (error) {
        if (error instanceof FileIssue) return issue(path, error.message);
        throw error;
      }
    },
  );
  const files: DefinitionFile[] = [];
  for (const result of results) {
    if (!result) continue;
    if ('contentHash' in result) files.push(result);
    else issues.push(result);
  }
  return files;
}

function distance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = row[j] as number;
      row[j] = Math.min(
        above + 1,
        (row[j - 1] as number) + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[right.length] as number;
}

function suggestion(field: string, kind: Kind): string | null {
  const normalized = field.toLowerCase().replaceAll('-', '_');
  let best: string | null = null;
  let score = Infinity;
  for (const known of knownFields[kind]) {
    const value = distance(normalized, known);
    if (value <= Math.max(2, Math.floor(known.length / 2)) && value < score) {
      best = known;
      score = value;
    }
  }
  return best;
}

function fieldLine(yaml: string | null, field: string): number | null {
  if (yaml === null) return null;
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^(?:${escaped}|"${escaped}"|'${escaped}')\\s*:`);
  const index = yaml.split(/\r?\n/).findIndex(line => pattern.test(line));
  return index < 0 ? null : index + 2;
}

function bodyLine(source: string, body: string): number {
  const offset = source.length - body.length;
  return source.slice(0, offset).split('\n').length;
}

function fieldLabel(field: string): string {
  return /^[a-z]+$/.test(field)
    ? field[0]?.toUpperCase() + field.slice(1)
    : `Field "${field}"`;
}

function expectedLabel(expected: string): string {
  switch (expected) {
    case 'string':
      return 'text';
    case 'number':
    case 'int':
      return 'a number';
    case 'array':
      return 'a list';
    case 'boolean':
      return 'true or false';
    default:
      return expected;
  }
}

function fieldMessage(
  schemaIssue: SchemaIssue,
  fields: Record<string, unknown>,
): string {
  const field = String(schemaIssue.path[0] ?? '');
  const direct = schemaIssue.path.length === 1;
  if (schemaIssue.code === 'invalid_value' && direct && schemaIssue.values)
    return `${fieldLabel(field)} must be one of ${schemaIssue.values.map(String).join(', ')}`;
  if (schemaIssue.code === 'invalid_type' && direct && !(field in fields))
    return `Missing required field "${field}"`;
  if (schemaIssue.code === 'invalid_type' && direct && schemaIssue.expected)
    return `Field "${field}" must be ${expectedLabel(schemaIssue.expected)}`;
  if (field === 'body' || !field) return schemaIssue.message;
  return `Field "${field}": ${schemaIssue.message}`;
}

function parseError(error: unknown): FileIssue {
  if (error instanceof YamlLimitError) return new FileIssue(error.message);
  const mark = (
    (error as Error).cause as { mark?: { line?: number } } | undefined
  )?.mark;
  return new FileIssue(
    (error as Error).message,
    typeof mark?.line === 'number' ? mark.line + 2 : null,
  );
}

function parseDocument<T>(
  file: DefinitionFile,
  kind: Kind,
  schema: DocumentSchema<T>,
  issues: DefinitionIssue[],
): Parsed<T> {
  let split: ReturnType<typeof document>;
  try {
    split = document(file.text, subject);
  } catch (error) {
    const failure = parseError(error);
    issues.push(issue(file.path, failure.message, failure.line));
    return { name: null, value: null, file, yaml: null };
  }
  const { fields, body, yaml } = split;
  const name =
    kind !== 'spec' && typeof fields.name === 'string' ? fields.name : null;
  const before = issues.length;
  if (yaml === null)
    issues.push(
      issue(
        file.path,
        `The ${kindLabels[kind]} needs YAML frontmatter between --- lines.`,
        1,
      ),
    );
  for (const field of Object.keys(fields)) {
    if (knownFields[kind].includes(field)) continue;
    const hint = suggestion(field, kind);
    issues.push(
      issue(
        file.path,
        `Unknown field "${field}"${hint ? ` (did you mean "${hint}"?)` : ''}`,
        fieldLine(yaml, field),
      ),
    );
  }
  const known = Object.fromEntries(
    Object.entries(fields).filter(([field]) =>
      knownFields[kind].includes(field),
    ),
  );
  const result = schema.safeParse({ ...known, body });
  if (!result.success)
    for (const schemaIssue of result.error.issues) {
      const field = String(schemaIssue.path[0] ?? '');
      issues.push(
        issue(
          file.path,
          fieldMessage(schemaIssue, known),
          field === 'body' ? bodyLine(file.text, body) : fieldLine(yaml, field),
        ),
      );
    }
  return {
    name,
    value: result.success && issues.length === before ? result.data : null,
    file,
    yaml,
  };
}

function index<T>(
  parsed: Parsed<T>[],
  kind: Kind,
  issues: DefinitionIssue[],
): Map<string, Parsed<T>> {
  const named = new Map<string, Parsed<T>>();
  for (const item of parsed) {
    if (item.name === null) continue;
    const first = named.get(item.name);
    if (first) {
      issues.push(
        issue(
          item.file.path,
          `The ${kindLabels[kind]} name "${item.name}" is already used by ${first.file.path}`,
          fieldLine(item.yaml, 'name'),
        ),
      );
      continue;
    }
    named.set(item.name, item);
  }
  return named;
}

function merge<T>(
  global: Map<string, Parsed<T>>,
  project: Map<string, Parsed<T>>,
  kind: Kind,
): Map<string, Entry<T> & { notes: string[] }> {
  const merged = new Map<string, Entry<T> & { notes: string[] }>();
  for (const [name, parsed] of global)
    merged.set(name, { scope: 'global', parsed, notes: [] });
  for (const [name, parsed] of project) {
    const shadowed = global.get(name);
    merged.set(name, {
      scope: 'project',
      parsed,
      notes: shadowed
        ? [
            bounded(
              `Overrides the global ${kindLabels[kind]} ${shadowed.file.path}`,
            ),
          ]
        : [],
    });
  }
  return merged;
}

function source(entry: Entry<unknown>): DefinitionSource {
  return {
    scope: entry.scope,
    path: entry.parsed.file.path,
    contentHash: entry.parsed.file.contentHash,
  };
}

function executionOrder(steps: readonly ResolvedStep[]): ResolvedStep[] {
  return steps
    .map((step, position) => ({ step, position }))
    .sort(
      (left, right) =>
        phaseOrder[left.step.phase] - phaseOrder[right.step.phase] ||
        left.position - right.position,
    )
    .map(({ step }) => step);
}

function pipelineWarnings(pipeline: ResolvedPipeline): DefinitionIssue[] {
  const path = pipeline.source.path;
  const warnings: DefinitionIssue[] = [];
  if (pipeline.steps.every(step => step.type === 'action'))
    warnings.push(
      issue(
        path,
        `Pipeline "${pipeline.name}" has no gate; add a command, agent or human step`,
        null,
        'warning',
      ),
    );
  let human = false;
  for (const step of executionOrder(pipeline.steps)) {
    if (step.type === 'human') human = true;
    if (human) continue;
    if (step.effect === 'external')
      warnings.push(
        issue(
          path,
          `Step "${step.name}" in pipeline "${pipeline.name}" is declared external without a human step before it`,
          null,
          'warning',
        ),
      );
    else if (
      (step.type === 'action' || step.type === 'command') &&
      externalEffectPattern.test(step.body)
    )
      warnings.push(
        issue(
          path,
          `Step "${step.name}" in pipeline "${pipeline.name}" looks like an external action (git push, gh pr, curl or wget) without a human step before it`,
          null,
          'warning',
        ),
      );
  }
  return warnings;
}

export function capIssues(issues: DefinitionIssue[]): DefinitionIssue[] {
  const limit = pipelineDefinitionLimits.issues;
  if (issues.length <= limit) return issues;
  const hidden = issues.slice(limit - 1);
  return [
    ...issues.slice(0, limit - 1),
    issue(
      '',
      `${hidden.length} more issues are not shown.`,
      null,
      hidden.some(item => item.severity === 'error') ? 'error' : 'warning',
    ),
  ];
}

async function readRoot(
  root: string | null,
  read: ReadContext,
  issues: DefinitionIssue[],
): Promise<{
  steps: Parsed<StepDefinition>[];
  pipelines: Parsed<PipelineDefinition>[];
}> {
  if (!root) return { steps: [], pipelines: [] };
  const stepFiles = await listMarkdown(join(root, 'steps'), 'step', read, issues);
  const pipelineFiles = await listMarkdown(
    join(root, 'pipelines'),
    'pipeline',
    read,
    issues,
  );
  return {
    steps: stepFiles.map(file =>
      parseDocument(file, 'step', stepDefinitionSchema, issues),
    ),
    pipelines: pipelineFiles.map(file =>
      parseDocument(file, 'pipeline', pipelineDefinitionSchema, issues),
    ),
  };
}

function stepWarnings(steps: Map<string, ResolvedStep>): DefinitionIssue[] {
  return [...steps.values()]
    .filter(
      step => step.on_fail === 'fix' && step.retries === 0 && step.type !== 'human',
    )
    .map(step =>
      issue(
        step.source.path,
        `Step "${step.name}" uses on_fail fix with retries 0, so a failure stops without a fix attempt`,
        null,
        'warning',
      ),
    );
}

export async function loadCatalog(
  directory: string,
  signal: AbortSignal,
): Promise<DefinitionCatalog> {
  const read = context(signal);
  const root = await projectRoot(await canonicalDirectory(directory, read), read);
  const issues: DefinitionIssue[] = [];
  const global = await canonicalRoot(globalRoot(), read);
  const projectCandidate = await canonicalRoot(
    join(root, '.agents', 'pipelines'),
    read,
  );
  const project =
    projectCandidate &&
    (!global || pathKey(projectCandidate) !== pathKey(global))
      ? projectCandidate
      : null;
  const globalFiles = await readRoot(global, read, issues);
  const projectFiles = await readRoot(project, read, issues);
  const specFiles = await listMarkdown(
    join(root, '.agents', 'tasks'),
    'spec',
    read,
    issues,
  );
  const steps = merge(
    index(globalFiles.steps, 'step', issues),
    index(projectFiles.steps, 'step', issues),
    'step',
  );
  const pipelines = merge(
    index(globalFiles.pipelines, 'pipeline', issues),
    index(projectFiles.pipelines, 'pipeline', issues),
    'pipeline',
  );
  const resolvedSteps = new Map<string, ResolvedStep>();
  for (const [name, entry] of [...steps].sort(([left], [right]) =>
    left.localeCompare(right, 'en'),
  )) {
    if (!entry.parsed.value) continue;
    resolvedSteps.set(name, {
      ...entry.parsed.value,
      source: source(entry),
      notes: entry.notes,
    });
  }
  const resolvedPipelines: ResolvedPipeline[] = [];
  for (const [, entry] of [...pipelines].sort(([left], [right]) =>
    left.localeCompare(right, 'en'),
  )) {
    const definition = entry.parsed.value;
    if (!definition) continue;
    const line = fieldLine(entry.parsed.yaml, 'steps');
    const before = issues.length;
    const members: ResolvedStep[] = [];
    for (const name of definition.steps) {
      const step = resolvedSteps.get(name);
      if (step) members.push(step);
      else
        issues.push(
          issue(
            entry.parsed.file.path,
            steps.has(name)
              ? `Step "${name}" referenced by pipeline "${definition.name}" is invalid`
              : `Step "${name}" referenced by pipeline "${definition.name}" does not exist`,
            line,
          ),
        );
    }
    if (issues.length !== before) continue;
    const pipeline: ResolvedPipeline = {
      name: definition.name,
      description: definition.description,
      body: definition.body,
      source: source(entry),
      notes: entry.notes,
      steps: members,
    };
    issues.push(...pipelineWarnings(pipeline));
    resolvedPipelines.push(pipeline);
  }
  issues.push(...stepWarnings(resolvedSteps));
  const specs: TaskSpecSummary[] = [];
  for (const file of specFiles) {
    const parsed = parseDocument(file, 'spec', taskSpecSchema, issues);
    if (!parsed.value) continue;
    const name = parsed.value.pipeline;
    if (!resolvedPipelines.some(pipeline => pipeline.name === name))
      issues.push(
        issue(
          file.path,
          pipelines.has(name)
            ? `Pipeline "${name}" referenced by this task spec is invalid`
            : `Pipeline "${name}" referenced by this task spec does not exist`,
          fieldLine(parsed.yaml, 'pipeline'),
        ),
      );
    specs.push({
      pipeline: name,
      title: parsed.value.title ?? null,
      source: { scope: 'project', path: file.path, contentHash: file.contentHash },
    });
  }
  const catalogSteps = [...resolvedSteps.values()];
  const stepLimit = pipelineDefinitionLimits.catalogSteps;
  if (catalogSteps.length > stepLimit)
    issues.push(
      issue(
        project ?? global ?? root,
        `${catalogSteps.length} steps are defined; only the first ${stepLimit} are listed.`,
      ),
    );
  const pipelineLimit = pipelineDefinitionLimits.catalogPipelines;
  if (resolvedPipelines.length > pipelineLimit)
    issues.push(
      issue(
        project ?? global ?? root,
        `${resolvedPipelines.length} pipelines are defined; only the first ${pipelineLimit} are listed.`,
      ),
    );
  if (read.signal.aborted) throw interruption(read);
  return definitionCatalogSchema.parse({
    roots: { global, project },
    steps: catalogSteps.slice(0, stepLimit),
    pipelines: resolvedPipelines.slice(0, pipelineLimit),
    specs,
    issues: capIssues(issues),
  });
}

export type DocumentCheck = {
  name: string | null;
  steps: string[];
  issues: DefinitionIssue[];
};

export function checkDocument(
  kind: 'step' | 'pipeline',
  path: string,
  content: string,
): DocumentCheck {
  const issues: DefinitionIssue[] = [];
  const file: DefinitionFile = {
    path,
    text: content,
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
  if (kind === 'step') {
    const parsed = parseDocument(file, 'step', stepDefinitionSchema, issues);
    return { name: parsed.name, steps: [], issues };
  }
  const parsed = parseDocument(file, 'pipeline', pipelineDefinitionSchema, issues);
  return { name: parsed.name, steps: parsed.value?.steps ?? [], issues };
}

export type WriteRoots = {
  projectRoot: string;
  project: string;
  global: string;
};

export async function resolveWriteRoots(
  directory: string,
  signal: AbortSignal,
): Promise<WriteRoots> {
  const read = context(signal);
  const projectRootPath = await projectRoot(
    await canonicalDirectory(directory, read),
    read,
  );
  return {
    projectRoot: projectRootPath,
    project: join(projectRootPath, '.agents', 'pipelines'),
    global: globalRoot(),
  };
}

export function resolvePipeline(
  name: string,
  catalog: DefinitionCatalog,
): ResolvedPipeline {
  const pipeline = catalog.pipelines.find(item => item.name === name);
  if (pipeline) return pipeline;
  throw new DefinitionError(
    'not-found',
    `Pipeline "${name}" is not available. Validate the pipeline definitions.`,
    catalog.issues.filter(item => item.severity === 'error'),
  );
}

export async function loadSpec(
  path: string,
  directory: string,
  signal: AbortSignal,
): Promise<LoadedSpec> {
  const read = context(signal);
  const root = await projectRoot(await canonicalDirectory(directory, read), read);
  const outside = new DefinitionError(
    'invalid',
    'The task spec must be inside the project.',
    [issue(path, `The task spec must be inside the project ${root}`)],
  );
  if (isAbsolute(path)) {
    let canonical: string | null = null;
    try {
      canonical = join(
        await io(read, realpath(dirname(path))),
        basename(path),
      );
    } catch (error) {
      if (error instanceof DefinitionError) throw error;
    }
    if (canonical && !inside(root, canonical)) throw outside;
  }
  let file: DefinitionFile;
  try {
    file = await readFile(path, read);
  } catch (error) {
    if (error instanceof FileIssue)
      throw new DefinitionError('invalid', error.message, [
        issue(path, error.message),
      ]);
    throw error;
  }
  if (!inside(root, file.path)) throw outside;
  const issues: DefinitionIssue[] = [];
  const parsed = parseDocument(file, 'spec', taskSpecSchema, issues);
  if (!parsed.value)
    throw new DefinitionError('invalid', 'The task spec is invalid.', issues);
  return {
    spec: parsed.value,
    source: { scope: 'project', path: file.path, contentHash: file.contentHash },
  };
}
