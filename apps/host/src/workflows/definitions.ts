import {
  checkGraphList,
  GATE_RULES_PER_STEP,
  definitionCatalogSchema,
  graphListRules,
  workflowDefinitionLimits,
  workflowDefinitionSchema,
  resolveGraph,
  stepDefinitionSchema,
  stepNameSchema,
  taskSpecSchema,
  type DefinitionCatalog,
  type DefinitionIssue,
  type DefinitionScope,
  type DefinitionSource,
  type GraphInput,
  type GraphIssue,
  type GraphStep,
  type WorkflowDefinition,
  type WorkflowGraph,
  type WorkflowLayout,
  type ResolvedWorkflow,
  type ResolvedStep,
  type StepDefinition,
  type TaskSpec,
  type TaskSpecSummary,
} from '@nesvo/contracts';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats, type Dirent } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { workflowStepGuards } from '../inbox-rules/files';
import { document, text } from '../skills/portable';
import { YamlLimitError } from '../skills/yaml-limits';

import {
  activeGateRule,
  gateRuleLimitMessage,
  gateRuleMatches,
  readGateRules,
} from './gate-rule-catalog';

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

type Kind = 'step' | 'workflow' | 'spec';

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
const graphFields = ['edges', 'layout'] as const;
const knownFields: Record<Kind, readonly string[]> = {
  step: [
    'name',
    'type',
    'phase',
    'skill',
    'prompt_skill',
    'timeout',
    'retries',
    'retry_backoff',
    'idempotent',
    'pr',
    'poll_interval',
    'repeat',
    'condition',
    'max_iterations',
    'probe',
    'on_fail',
    'effect',
    'needs',
    'session',
    'items',
    'policy',
    'max_depth',
  ],
  workflow: ['name', 'description', 'decisions', 'steps', ...graphFields],
  spec: ['workflow', 'pipeline', 'title'],
};
const legacyFields: Partial<Record<Kind, Record<string, string>>> = {
  spec: { pipeline: 'workflow' },
};
const definitionsFolder = ['.agents', 'workflows'] as const;
const legacyDefinitionsFolder = ['.agents', 'pipelines'] as const;
const kindLabels: Record<Kind, string> = {
  step: 'step',
  workflow: 'workflow',
  spec: 'task spec',
};
const fileLimits = {
  step: workflowDefinitionLimits.catalogSteps,
  workflow: workflowDefinitionLimits.catalogWorkflows,
  spec: workflowDefinitionLimits.catalogSpecs,
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
  return message.length > workflowDefinitionLimits.issueMessage
    ? message.slice(0, workflowDefinitionLimits.issueMessage - 1) + '…'
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
        'Reading workflow definitions was cancelled.',
      )
    : new DefinitionError(
        'timeout',
        `Reading workflow definitions reached its ${definitionReadLimits.inventoryMilliseconds / 1000} s limit.`,
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

export function globalRoot(): string {
  const override = process.env.NESVO_WORKFLOWS_HOME;
  return process.env.NESVO_TEST_MODE === '1' && override && isAbsolute(override)
    ? override
    : join(homedir(), ...definitionsFolder);
}

function legacyRootBeside(root: string): string {
  return join(dirname(root), legacyDefinitionsFolder[1]);
}

async function legacyRoot(
  path: string,
  excluded: (string | null)[],
  currentRoot: string,
  read: ReadContext,
  issues: DefinitionIssue[],
): Promise<string | null> {
  const canonical = await canonicalRoot(path, read);
  if (
    !canonical ||
    excluded.some(other => other && pathKey(other) === pathKey(canonical))
  )
    return null;
  issues.push(
    issue(
      canonical,
      `Legacy location: definitions are still read from ${canonical}; new files are saved to ${currentRoot}. Move the folder.`,
      null,
      'warning',
    ),
  );
  return canonical;
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
    if (legacyFields[kind]?.[known]) continue;
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

function graphFieldMessage(schemaIssue: SchemaIssue): string | null {
  const [field] = schemaIssue.path;
  if (field === 'layout')
    return 'Field "layout" must be a mapping of step name to [x, y]';
  if (field === 'edges') return 'Field "edges" must be a list of text entries';
  return null;
}

function graphShapeIssue(
  schemaIssues: SchemaIssue[],
  field: (typeof graphFields)[number],
): SchemaIssue | undefined {
  return schemaIssues.find(
    item =>
      item.path[0] === field &&
      (field === 'layout' || item.code === 'invalid_type'),
  );
}

function graphSchemaIssues(schemaIssues: SchemaIssue[]): SchemaIssue[] {
  const kept = graphFields.map(field => graphShapeIssue(schemaIssues, field));
  return schemaIssues.filter(
    item =>
      !graphFields.some(field => field === item.path[0]) ||
      kept.includes(item),
  );
}

function fieldMessage(
  schemaIssue: SchemaIssue,
  fields: Record<string, unknown>,
): string {
  const graph = graphFieldMessage(schemaIssue);
  if (graph) return graph;
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

function aliasLegacyFields(
  kind: Kind,
  fields: Record<string, unknown>,
  file: DefinitionFile,
  yaml: string | null,
  issues: DefinitionIssue[],
): Record<string, unknown> {
  for (const [legacy, current] of Object.entries(legacyFields[kind] ?? {})) {
    if (!(legacy in fields)) continue;
    issues.push(
      issue(
        file.path,
        `Field "${legacy}" is the legacy name of "${current}"; rename it`,
        fieldLine(yaml, legacy),
        'warning',
      ),
    );
    if (!(current in fields)) fields[current] = fields[legacy];
    delete fields[legacy];
  }
  return fields;
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
  const known = aliasLegacyFields(
    kind,
    Object.fromEntries(
      Object.entries(fields).filter(([field]) =>
        knownFields[kind].includes(field),
      ),
    ),
    file,
    yaml,
    issues,
  );
  const result = schema.safeParse({ ...known, body });
  const schemaIssues = result.success ? [] : result.error.issues;
  for (const schemaIssue of graphSchemaIssues(schemaIssues)) {
    const field = String(schemaIssue.path[0] ?? '');
    issues.push(
      issue(
        file.path,
        fieldMessage(schemaIssue, known),
        field === 'body' ? bodyLine(file.text, body) : fieldLine(yaml, field),
      ),
    );
  }
  if (kind === 'workflow')
    issues.push(...graphListIssues(known, yaml, file.path, schemaIssues));
  return {
    name,
    value:
      result.success &&
      !issues.slice(before).some(item => item.severity === 'error')
        ? result.data
        : null,
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

type Indexed<T> = { parsed: Parsed<T>; notes: string[] };

function withLegacy<T>(
  current: Map<string, Parsed<T>>,
  legacy: Map<string, Parsed<T>>,
  currentRoot: string,
): Map<string, Indexed<T>> {
  const combined = new Map<string, Indexed<T>>();
  for (const [name, parsed] of legacy)
    combined.set(name, {
      parsed,
      notes: [
        bounded(`Legacy location: move ${parsed.file.path} to ${currentRoot}`),
      ],
    });
  for (const [name, parsed] of current)
    combined.set(name, { parsed, notes: [] });
  return combined;
}

function merge<T>(
  global: Map<string, Indexed<T>>,
  project: Map<string, Indexed<T>>,
  kind: Kind,
): Map<string, Entry<T> & { notes: string[] }> {
  const merged = new Map<string, Entry<T> & { notes: string[] }>();
  for (const [name, { parsed, notes }] of global)
    merged.set(name, { scope: 'global', parsed, notes });
  for (const [name, { parsed, notes }] of project) {
    const shadowed = global.get(name);
    merged.set(name, {
      scope: 'project',
      parsed,
      notes: shadowed
        ? [
            ...notes,
            bounded(
              `Overrides the global ${kindLabels[kind]} ${shadowed.parsed.file.path}`,
            ),
          ]
        : notes,
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

export type GraphLines = Record<(typeof graphFields)[number], number | null>;

function graphLines(yaml: string | null): GraphLines {
  return {
    edges: fieldLine(yaml, 'edges'),
    layout: fieldLine(yaml, 'layout'),
  };
}

function graphIssues(
  issues: GraphIssue[],
  path: string,
  lines: GraphLines,
): DefinitionIssue[] {
  return issues.map(item =>
    issue(
      path,
      item.message,
      item.field ? lines[item.field] : null,
      item.severity,
    ),
  );
}

function listedStepNames(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= workflowDefinitionLimits.workflowSteps &&
    value.every(name => stepNameSchema.safeParse(name).success)
    ? (value as string[])
    : null;
}

function graphListIssues(
  fields: Record<string, unknown>,
  yaml: string | null,
  path: string,
  schemaIssues: SchemaIssue[],
): DefinitionIssue[] {
  const steps = listedStepNames(fields.steps);
  if (!steps) return [];
  const edges =
    Array.isArray(fields.edges) && !graphShapeIssue(schemaIssues, 'edges')
      ? (fields.edges as string[])
      : null;
  const layout =
    fields.layout && !graphShapeIssue(schemaIssues, 'layout')
      ? (fields.layout as WorkflowLayout)
      : null;
  return graphIssues(
    checkGraphList({ steps, edges, layout }),
    path,
    graphLines(yaml),
  );
}

export type StepGuard = (
  workflow: string,
  step: string,
  phase: GraphStep['phase'],
) => boolean;

export function checkGraph(
  workflow: GraphInput,
  path: string,
  lines: GraphLines,
  steps: ReadonlyMap<string, GraphStep>,
  guarded: StepGuard = () => false,
): { graph: WorkflowGraph; issues: DefinitionIssue[] } {
  const resolution = resolveGraph(workflow, steps);
  return {
    graph: resolution.graph,
    issues: graphIssues(
      resolution.issues.filter(
        item =>
          !graphListRules.includes(item.rule) &&
          !(
            item.rule === 'W2' &&
            item.steps.length > 0 &&
            item.steps.every(name => {
              const step = steps.get(name);
              return !!step && guarded(workflow.name, name, step.phase);
            })
          ),
      ),
      path,
      lines,
    ),
  };
}

export const EXTERNAL_GUARD_NOTE =
  'The assistant cannot save an external action without a preceding human step';

function withPlaceholders(
  workflow: GraphInput,
  steps: ReadonlyMap<string, GraphStep>,
  involving: string | null,
): ReadonlyMap<string, GraphStep> | null {
  if (workflow.steps.every(name => steps.has(name))) return steps;
  const written = involving === null ? undefined : steps.get(involving);
  if (!written) return null;
  const filled = new Map(steps);
  for (const name of workflow.steps)
    if (!filled.has(name))
      filled.set(name, {
        type: 'command',
        phase: written.phase,
        effect: 'local',
        body: '',
      });
  return filled;
}

export function unguardedExternalIssues(
  workflow: GraphInput,
  path: string,
  steps: ReadonlyMap<string, GraphStep>,
  involving: string | null = null,
): DefinitionIssue[] {
  const known = withPlaceholders(workflow, steps, involving);
  if (!known) return [];
  return resolveGraph(workflow, known)
    .issues.filter(
      item =>
        item.rule === 'W2' &&
        (involving === null || item.steps.includes(involving)),
    )
    .map(item =>
      issue(
        path,
        `${item.message}. ${EXTERNAL_GUARD_NOTE}`,
        null,
        'error',
      ),
    );
}

export function capIssues(issues: DefinitionIssue[]): DefinitionIssue[] {
  const limit = workflowDefinitionLimits.issues;
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
  workflowsFolder: 'workflows' | 'pipelines' = 'workflows',
): Promise<{
  steps: Parsed<StepDefinition>[];
  workflows: Parsed<WorkflowDefinition>[];
}> {
  if (!root) return { steps: [], workflows: [] };
  const stepFiles = await listMarkdown(join(root, 'steps'), 'step', read, issues);
  const workflowFiles = await listMarkdown(
    join(root, workflowsFolder),
    'workflow',
    read,
    issues,
  );
  return {
    steps: stepFiles.map(file =>
      parseDocument(file, 'step', stepDefinitionSchema, issues),
    ),
    workflows: workflowFiles.map(file =>
      parseDocument(file, 'workflow', workflowDefinitionSchema, issues),
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

export async function findProjectRoot(
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  const read = context(signal);
  return projectRoot(await canonicalDirectory(directory, read), read);
}

export async function loadCatalog(
  directory: string,
  signal: AbortSignal,
): Promise<DefinitionCatalog> {
  const read = context(signal);
  const root = await projectRoot(await canonicalDirectory(directory, read), read);
  const issues: DefinitionIssue[] = [];
  const globalPath = globalRoot();
  const projectPath = join(root, ...definitionsFolder);
  const global = await canonicalRoot(globalPath, read);
  const projectCandidate = await canonicalRoot(projectPath, read);
  const project =
    projectCandidate &&
    (!global || pathKey(projectCandidate) !== pathKey(global))
      ? projectCandidate
      : null;
  const legacyGlobal = await legacyRoot(
    legacyRootBeside(globalPath),
    [global, project],
    globalPath,
    read,
    issues,
  );
  const legacyProject = await legacyRoot(
    join(root, ...legacyDefinitionsFolder),
    [global, project, legacyGlobal],
    projectPath,
    read,
    issues,
  );
  const globalFiles = await readRoot(global, read, issues);
  const legacyGlobalFiles = await readRoot(
    legacyGlobal,
    read,
    issues,
    'pipelines',
  );
  const projectFiles = await readRoot(project, read, issues);
  const legacyProjectFiles = await readRoot(
    legacyProject,
    read,
    issues,
    'pipelines',
  );
  const specFiles = await listMarkdown(
    join(root, '.agents', 'tasks'),
    'spec',
    read,
    issues,
  );
  const scoped = <T>(
    kind: Kind,
    current: Parsed<T>[],
    legacy: Parsed<T>[],
    currentRoot: string,
  ) =>
    withLegacy(
      index(current, kind, issues),
      index(legacy, kind, issues),
      currentRoot,
    );
  const steps = merge(
    scoped('step', globalFiles.steps, legacyGlobalFiles.steps, globalPath),
    scoped('step', projectFiles.steps, legacyProjectFiles.steps, projectPath),
    'step',
  );
  const workflows = merge(
    scoped(
      'workflow',
      globalFiles.workflows,
      legacyGlobalFiles.workflows,
      globalPath,
    ),
    scoped(
      'workflow',
      projectFiles.workflows,
      legacyProjectFiles.workflows,
      projectPath,
    ),
    'workflow',
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
  const guarded = await workflowStepGuards(root, signal);
  const gateRules = readGateRules(
    [
      ...(global ? [{ root: global, scope: 'global' as const }] : []),
      ...(project ? [{ root: project, scope: 'project' as const }] : []),
    ],
    resolvedSteps,
    issues,
  );
  const resolvedWorkflows: ResolvedWorkflow[] = [];
  for (const [, entry] of [...workflows].sort(([left], [right]) =>
    left.localeCompare(right, 'en'),
  )) {
    const definition = entry.parsed.value;
    if (!definition) continue;
    const line = fieldLine(entry.parsed.yaml, 'steps');
    const before = issues.length;
    const members: ResolvedStep[] = [];
    for (const name of definition.steps) {
      const step = resolvedSteps.get(name);
      if (step) {
        const rules = gateRules.rules.filter(
          rule => activeGateRule(rule) && gateRuleMatches(rule, name, definition.name),
        );
        if (gateRules.invalidSteps.has(name) && rules.length)
          issues.push(
            issue(step.source.path, `Step "${name}" cannot receive gate rules.`, null),
          );
        if (rules.length > GATE_RULES_PER_STEP)
          issues.push(issue(step.source.path, gateRuleLimitMessage(name), null));
        members.push(
          step.type === 'agent' && rules.length ? { ...step, gateRules: rules } : step,
        );
      } else
        issues.push(
          issue(
            entry.parsed.file.path,
            steps.has(name)
              ? `Step "${name}" referenced by workflow "${definition.name}" is invalid`
              : `Step "${name}" referenced by workflow "${definition.name}" does not exist`,
            line,
          ),
        );
    }
    if (issues.length !== before) continue;
    const checked = checkGraph(
      definition,
      entry.parsed.file.path,
      graphLines(entry.parsed.yaml),
      resolvedSteps,
      guarded,
    );
    issues.push(...checked.issues);
    if (checked.issues.some(item => item.severity === 'error')) continue;
    resolvedWorkflows.push({
      name: definition.name,
      description: definition.description,
      body: definition.body,
      source: source(entry),
      notes: entry.notes,
      steps: members,
      ...(definition.edges ? { edges: definition.edges } : {}),
      ...(definition.layout ? { layout: definition.layout } : {}),
      graph: checked.graph,
    });
  }
  issues.push(...stepWarnings(resolvedSteps));
  const specs: TaskSpecSummary[] = [];
  for (const file of specFiles) {
    const parsed = parseDocument(file, 'spec', taskSpecSchema, issues);
    if (!parsed.value) continue;
    const name = parsed.value.workflow;
    if (!resolvedWorkflows.some(workflow => workflow.name === name))
      issues.push(
        issue(
          file.path,
          workflows.has(name)
            ? `Workflow "${name}" referenced by this task spec is invalid`
            : `Workflow "${name}" referenced by this task spec does not exist`,
          fieldLine(parsed.yaml, 'workflow') ??
            fieldLine(parsed.yaml, 'pipeline'),
        ),
      );
    specs.push({
      workflow: name,
      title: parsed.value.title ?? null,
      source: { scope: 'project', path: file.path, contentHash: file.contentHash },
    });
  }
  const catalogSteps = [...resolvedSteps.values()];
  const stepLimit = workflowDefinitionLimits.catalogSteps;
  if (catalogSteps.length > stepLimit)
    issues.push(
      issue(
        project ?? global ?? root,
        `${catalogSteps.length} steps are defined; only the first ${stepLimit} are listed.`,
      ),
    );
  const workflowLimit = workflowDefinitionLimits.catalogWorkflows;
  if (resolvedWorkflows.length > workflowLimit)
    issues.push(
      issue(
        project ?? global ?? root,
        `${resolvedWorkflows.length} workflows are defined; only the first ${workflowLimit} are listed.`,
      ),
    );
  if (read.signal.aborted) throw interruption(read);
  return definitionCatalogSchema.parse({
    roots: { global, project },
    steps: catalogSteps.slice(0, stepLimit),
    workflows: resolvedWorkflows.slice(0, workflowLimit),
    specs,
    gateRules: gateRules.rules,
    issues: capIssues(issues),
  });
}

export type DocumentCheck = {
  name: string | null;
  step: StepDefinition | null;
  steps: string[];
  edges: string[] | null;
  layout: WorkflowLayout | null;
  lines: GraphLines;
  issues: DefinitionIssue[];
};

export function checkDocument(
  kind: 'step' | 'workflow',
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
    return {
      name: parsed.name,
      step: parsed.value ?? null,
      steps: [],
      edges: null,
      layout: null,
      lines: graphLines(null),
      issues,
    };
  }
  const parsed = parseDocument(file, 'workflow', workflowDefinitionSchema, issues);
  return {
    name: parsed.name,
    step: null,
    steps: parsed.value?.steps ?? [],
    edges: parsed.value?.edges ?? null,
    layout: parsed.value?.layout ?? null,
    lines: graphLines(parsed.yaml),
    issues,
  };
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
    project: join(projectRootPath, ...definitionsFolder),
    global: globalRoot(),
  };
}

export function resolveWorkflow(
  name: string,
  catalog: DefinitionCatalog,
): ResolvedWorkflow {
  const workflow = catalog.workflows.find(item => item.name === name);
  if (workflow) return workflow;
  throw new DefinitionError(
    'not-found',
    `Workflow "${name}" is not available. Validate the workflow definitions.`,
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
