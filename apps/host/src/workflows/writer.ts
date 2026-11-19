import {
  RULE_ENTRY_FOLDERS,
  stepNameSchema,
  type RuleEntryType,
  type DefinitionCatalog,
  type DefinitionIssue,
  type DefinitionKind,
  type DefinitionScope,
  type DefinitionWriteResult,
  type GraphInput,
  type GraphStep,
  type StepDefinition,
  type WorkflowDefinitionConflict,
  type WorkflowDefinitionRefused,
} from '@nesvo/contracts';
import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { text } from '../skills/portable';
import { parseProjectOverride, projectProfilePath } from './project-checks';
import {
  capIssues,
  checkDocument,
  checkGraph,
  DefinitionError,
  definitionReadLimits,
  inside,
  loadCatalog,
  missing,
  pathKey,
  readDefinitionFile,
  resolveWriteRoots,
  unguardedExternalIssues,
  EXTERNAL_GUARD_NOTE,
  type DefinitionFile,
  type WriteRoots,
} from './definitions';

export type DefinitionTarget = {
  directory: string;
  scope: DefinitionScope;
  kind: DefinitionKind;
  name: string;
};

type FolderTarget = Omit<DefinitionTarget, 'kind'> & {
  kind: DefinitionKind | RuleEntryType;
};

export type RuleEntryFileTarget = Omit<DefinitionTarget, 'kind'> & {
  type: RuleEntryType;
};

export type SaveRuleEntryFileInput = RuleEntryFileTarget & {
  document: string;
  expectedHash: string | null;
  validate: (document: string) => string[] | Promise<string[]>;
};

export type DeleteRuleEntryFileInput = RuleEntryFileTarget & {
  expectedHash: string;
};

export type RuleEntryFileWriteResult =
  | { type: 'written'; path: string; root: string }
  | { type: 'conflict'; path: string; currentHash: string | null }
  | { type: 'refused'; issues: DefinitionIssue[] };

export type SaveDefinitionInput = DefinitionTarget & {
  document: string;
  expectedHash: string | null;
};

export type DeleteDefinitionInput = DefinitionTarget & {
  expectedHash: string;
};

export type ActiveRunLookup = (target: {
  scope: DefinitionScope;
  kind: DefinitionKind;
  name: string;
  projectRoot: string;
}) => string[];

export type WriteOptions = {
  guardExternal?: boolean;
  onPrevious?: (file: DefinitionFile | null, root: string) => void;
  expectedRoot?: string;
  configuration?: { root: string; preview: boolean; authorize: () => void };
};

type Location = {
  root: string;
  folder: string;
  path: string;
  projectRoot: string;
};

type Current = { file: DefinitionFile | null };

const lockTails = new Map<string, Promise<void>>();
const privateFolderMode = 0o700;
const fileMode = 0o600;

async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = lockTails.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const tail = new Promise<void>(resolve => {
    release = resolve;
  });
  const queued = previous.then(() => tail);
  lockTails.set(key, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (lockTails.get(key) === queued) lockTails.delete(key);
  }
}

function withWriteLock<T>(root: string, options: WriteOptions, work: () => Promise<T>) {
  return options.configuration?.root === root ? work() : exclusive(pathKey(root), work);
}

export function withDefinitionInspection<T>(
  target: FolderTarget,
  roots: WriteRoots,
  signal: AbortSignal,
  inspect: (file: DefinitionFile | null, root: string) => Promise<T>,
): Promise<T> {
  const root = target.scope === 'global' ? roots.global : roots.project;
  return exclusive(pathKey(root), async () => {
    requireName(target.name);
    const location = await prepareFolder(target, roots, false);
    if (location && 'type' in location) throw new DefinitionError('invalid', 'The target is not a confined definition file.');
    const current = location ? await readCurrent(location.path, signal) : { file: null };
    if (isRefusal(current)) throw new DefinitionError('invalid', 'The target is not a regular definition file.');
    return inspect(current.file, root);
  });
}

function refusal(path: string, message: string): WorkflowDefinitionRefused {
  return {
    type: 'workflow-definition-refused',
    issues: [{ severity: 'error', path, line: null, message }],
  };
}

function refusedIssues(issues: DefinitionIssue[]): WorkflowDefinitionRefused {
  return { type: 'workflow-definition-refused', issues: capIssues(issues) };
}

function conflict(
  target: DefinitionTarget,
  path: string,
  current: DefinitionFile | null,
): WorkflowDefinitionConflict {
  return {
    type: 'workflow-definition-conflict',
    scope: target.scope,
    kind: target.kind,
    name: target.name,
    path,
    currentHash: current?.contentHash ?? null,
    document: current?.text ?? null,
  };
}

async function movedRoot(
  requested: string,
  expected: string | undefined,
): Promise<WorkflowDefinitionRefused | null> {
  if (!expected) return null;
  let resolved: string;
  try {
    resolved = await realpath(requested);
  } catch (error) {
    if (!missing(error)) return unavailable(error);
    return refusal(
      expected,
      `The definitions folder ${expected} where this change was made no longer exists.`,
    );
  }
  return pathKey(resolved) === pathKey(expected)
    ? null
    : refusal(
        expected,
        `The definitions folder now resolves to ${resolved}, not ${expected} where this change was made.`,
      );
}

function requireName(name: string) {
  if (!stepNameSchema.safeParse(name).success)
    throw new DefinitionError(
      'invalid',
      'Use lowercase letters, digits and single hyphens for the name.',
    );
}

function unavailable(error: unknown): never {
  if (error instanceof DefinitionError) throw error;
  throw new DefinitionError(
    'unavailable',
    'The definition could not be written. Check the folder permissions and free space, then try again.',
  );
}

async function deepestExisting(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      const parent = dirname(current);
      if (!missing(error) || parent === current) throw error;
      current = parent;
    }
  }
}

async function prepareFolder(
  target: FolderTarget,
  roots: Awaited<ReturnType<typeof resolveWriteRoots>>,
  create: boolean,
): Promise<Location | WorkflowDefinitionRefused | null> {
  const requested = target.scope === 'global' ? roots.global : roots.project;
  const folderMode = target.scope === 'global' ? privateFolderMode : undefined;
  let root: string;
  try {
    if (create && target.scope === 'project') {
      const ancestor = await deepestExisting(requested);
      if (!inside(await realpath(roots.projectRoot), ancestor))
        return refusal(
          requested,
          'The project workflows folder resolves outside the project.',
        );
    }
    if (create) await mkdir(requested, { recursive: true, mode: folderMode });
    root = await realpath(requested);
  } catch (error) {
    if (!create && missing(error)) return null;
    return unavailable(error);
  }
  if (target.scope === 'project') {
    if (!inside(await realpath(roots.projectRoot), root))
      return refusal(
        requested,
        'The project workflows folder resolves outside the project.',
      );
    let global: string | null = null;
    try {
      global = await realpath(roots.global);
    } catch (error) {
      if (!missing(error)) return unavailable(error);
    }
    if (global && pathKey(global) === pathKey(root))
      return refusal(
        requested,
        'The project folder is the global workflows folder. Save to the global scope instead.',
      );
  }
  const folder = join(root, `${target.kind}s`);
  try {
    const status = await lstat(folder).catch(error => {
      if (missing(error)) return null;
      throw error;
    });
    if (!status) {
      if (!create) return null;
      await mkdir(folder, { mode: folderMode });
    } else if (status.isSymbolicLink())
      return refusal(
        folder,
        'Symbolic links are not written. Use a regular folder.',
      );
    else if (!status.isDirectory())
      return refusal(folder, 'The path is not a folder.');
  } catch (error) {
    return unavailable(error);
  }
  return {
    root,
    folder,
    path: join(folder, `${target.name}.md`),
    projectRoot: roots.projectRoot,
  };
}

async function readCurrent(
  path: string,
  signal: AbortSignal,
): Promise<Current | WorkflowDefinitionRefused> {
  try {
    await lstat(path);
  } catch (error) {
    if (missing(error)) return { file: null };
    return refusal(path, 'The file cannot be accessed.');
  }
  try {
    return { file: await readDefinitionFile(path, signal) };
  } catch (error) {
    if (error instanceof DefinitionError && error.kind === 'invalid')
      return refusedIssues(error.issues);
    throw error;
  }
}

function isRefusal(
  value: Current | WorkflowDefinitionRefused,
): value is WorkflowDefinitionRefused {
  return 'type' in value;
}

function checkActiveRuns(
  target: DefinitionTarget,
  projectRoot: string,
  activeRuns: ActiveRunLookup | undefined,
) {
  if (target.kind !== 'workflow' || !activeRuns) return;
  const [runId] = activeRuns({
    scope: target.scope,
    kind: target.kind,
    name: target.name,
    projectRoot,
  });
  if (runId)
    throw new DefinitionError(
      'busy',
      `Workflow "${target.name}" has an active run (${runId}). Stop it or wait until it finishes before changing the definition.`,
    );
}

function missingSteps(
  names: string[],
  catalog: DefinitionCatalog,
  path: string,
): DefinitionIssue[] {
  const available = new Set(catalog.steps.map(step => step.name));
  return names
    .filter(name => !available.has(name))
    .map(name => ({
      severity: 'error',
      path,
      line: null,
      message: `Step "${name}" does not exist or is invalid`,
    }));
}

type WorkflowGraph = GraphInput & { path: string };

async function referencingWorkflows(
  name: string,
  roots: WriteRoots,
  catalog: DefinitionCatalog,
  signal: AbortSignal,
): Promise<WorkflowGraph[]> {
  const found = new Map<string, WorkflowGraph>(
    catalog.workflows.map(workflow => [
      pathKey(workflow.source.path),
      {
        path: workflow.source.path,
        name: workflow.name,
        steps: workflow.steps.map(item => item.name),
        edges: workflow.edges,
        lanes: workflow.lanes,
        layout: workflow.layout,
      },
    ]),
  );
  for (const root of [roots.project, roots.global]) {
    const folder = join(root, 'workflows');
    const entries = await readdir(folder).catch(() => [] as string[]);
    for (const entry of entries) {
      const path = join(folder, entry);
      if (!entry.endsWith('.md') || found.has(pathKey(path))) continue;
      const file = await readDefinitionFile(path, signal).catch(() => null);
      if (!file) continue;
      const checked = checkDocument('workflow', path, file.text);
      found.set(pathKey(path), {
        path,
        name: checked.name ?? entry.slice(0, -3),
        steps: checked.steps,
        edges: checked.edges,
        lanes: checked.lanes,
        layout: checked.layout,
      });
    }
  }
  return [...found.values()].filter(workflow =>
    workflow.steps.includes(name),
  );
}

async function guardedStepIssues(
  input: SaveDefinitionInput,
  step: StepDefinition,
  previous: DefinitionFile | null,
  catalog: DefinitionCatalog,
  roots: WriteRoots,
  path: string,
  signal: AbortSignal,
): Promise<DefinitionIssue[]> {
  const issues: DefinitionIssue[] = [];
  if (input.scope === 'global') {
    issues.push(
      ...unguardedExternalIssues(
        { name: input.name, steps: [input.name] },
        path,
        new Map([[input.name, step]]),
      ),
    );
    const replaced = previous
      ? checkDocument('step', path, previous.text).step
      : null;
    if (replaced?.type === 'human' && step.type !== 'human')
      issues.push(
        issueAt(
          path,
          `Global step "${input.name}" is a human step that workflows in other projects may rely on. ${EXTERNAL_GUARD_NOTE}`,
        ),
      );
  }
  const effective = catalog.steps.find(item => item.name === input.name);
  if (input.scope === 'global' && effective?.source.scope === 'project')
    return issues;
  const current = new Map<string, GraphStep>(
    catalog.steps.map(item => [item.name, item]),
  );
  const next = new Map(current).set(input.name, step);
  const workflows = await referencingWorkflows(
    input.name,
    roots,
    catalog,
    signal,
  );
  for (const workflow of workflows) {
    const known = new Set(
      unguardedExternalIssues(workflow, workflow.path, current).map(
        item => item.message,
      ),
    );
    const involved = unguardedExternalIssues(
      workflow,
      workflow.path,
      next,
      input.name,
    );
    const reported = new Set(involved.map(item => item.message));
    issues.push(
      ...involved,
      ...unguardedExternalIssues(workflow, workflow.path, next).filter(
        item => !reported.has(item.message) && !known.has(item.message),
      ),
    );
  }
  return issues;
}

function stepUsers(
  name: string,
  path: string,
  catalog: DefinitionCatalog,
): DefinitionIssue[] {
  return catalog.workflows
    .filter(workflow =>
      workflow.steps.some(
        step => step.name === name && pathKey(step.source.path) === pathKey(path),
      ),
    )
    .map(workflow => ({
      severity: 'error',
      path: workflow.source.path,
      line: null,
      message: `Step "${name}" is used by workflow "${workflow.name}"`,
    }));
}

async function publishFile(
  document: string,
  expectedHash: string | null,
  location: Location,
  signal: AbortSignal,
  authorize?: () => void,
): Promise<'written' | WorkflowDefinitionRefused | Current> {
  const temporary = `${location.path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, document, {
      mode: fileMode,
      flag: 'wx',
      flush: true,
    });
    if (expectedHash === null) {
      try {
        authorize?.();
        await link(temporary, location.path);
        return 'written';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          return unavailable(error);
      }
    } else {
      const current = await readCurrent(location.path, signal);
      if (isRefusal(current)) return current;
      if (current.file?.contentHash === expectedHash) {
        authorize?.();
        await rename(temporary, location.path);
        return 'written';
      }
    }
    return await readCurrent(location.path, signal);
  } catch (error) {
    return unavailable(error);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function publish(
  target: SaveDefinitionInput,
  location: Location,
  signal: AbortSignal,
  authorize?: () => void,
): Promise<'written' | DefinitionWriteResult> {
  const outcome = await publishFile(
    target.document,
    target.expectedHash,
    location,
    signal,
    authorize,
  );
  if (outcome === 'written' || isRefusal(outcome)) return outcome;
  return conflict(target, location.path, outcome.file);
}

export function checkFileText(
  document: string,
  path: string,
): DefinitionIssue[] {
  const bytes = Buffer.from(document, 'utf8');
  const limit = definitionReadLimits.fileBytes;
  try {
    if (text(bytes, 'The document') !== document)
      return [issueAt(path, 'The document must be valid UTF-8 text.')];
  } catch (error) {
    return [issueAt(path, (error as Error).message)];
  }
  return bytes.byteLength > limit
    ? [issueAt(path, `The document exceeds the ${limit / 1024} KiB limit.`)]
    : [];
}

function issueAt(path: string, message: string): DefinitionIssue {
  return { severity: 'error', path, line: null, message };
}

async function legacyPath(
  target: DefinitionTarget,
  requestedRoot: string,
  catalog: DefinitionCatalog,
): Promise<string | null> {
  const entries = target.kind === 'step' ? catalog.steps : catalog.workflows;
  const entry = entries.find(
    item => item.name === target.name && item.source.scope === target.scope,
  );
  if (!entry) return null;
  const parent = dirname(requestedRoot);
  const base = await realpath(parent).catch(() => parent);
  const expected = join(
    base,
    'pipelines',
    target.kind === 'step' ? 'steps' : 'pipelines',
    `${target.name}.md`,
  );
  return pathKey(entry.source.path) === pathKey(expected)
    ? entry.source.path
    : null;
}

async function readLegacy(
  target: DefinitionTarget,
  requestedRoot: string,
  current: Current,
  catalog: DefinitionCatalog,
  signal: AbortSignal,
): Promise<{ path: string; current: Current } | WorkflowDefinitionRefused | null> {
  if (current.file) return null;
  const path = await legacyPath(target, requestedRoot, catalog);
  if (!path) return null;
  const legacy = await readCurrent(path, signal);
  return isRefusal(legacy) ? legacy : { path, current: legacy };
}

async function removeLegacy(
  legacy: { path: string; current: Current } | null,
  signal: AbortSignal,
) {
  if (!legacy?.current.file) return;
  const latest = await readCurrent(legacy.path, signal);
  if (isRefusal(latest) || !latest.file) return;
  if (latest.file.contentHash !== legacy.current.file.contentHash) return;
  await unlink(legacy.path).catch(() => undefined);
}

export async function saveDefinition(
  input: SaveDefinitionInput,
  signal: AbortSignal,
  activeRuns?: ActiveRunLookup,
  options: WriteOptions = {},
): Promise<DefinitionWriteResult> {
  requireName(input.name);
  const roots = await resolveWriteRoots(input.directory, signal);
  const requested = input.scope === 'global' ? roots.global : roots.project;
  const textIssues = checkFileText(input.document, requested);
  if (textIssues.length) return refusedIssues(textIssues);
  const plannedPath = join(requested, `${input.kind}s`, `${input.name}.md`);
  const checked = checkDocument(input.kind, plannedPath, input.document);
  const issues = [...checked.issues];
  if (checked.name !== null && checked.name !== input.name)
    issues.push(
      issueAt(
        plannedPath,
        `Field "name" must be "${input.name}" to match the file name`,
      ),
    );
  if (issues.some(item => item.severity === 'error'))
    return refusedIssues(issues);
  return withWriteLock(requested, options, async () => {
    const moved = await movedRoot(requested, options.expectedRoot);
    if (moved) return moved;
    const existing = await prepareFolder(input, roots, false);
    if (existing && 'type' in existing) return existing;
    const path = existing?.path ?? plannedPath;
    const found: Current | WorkflowDefinitionRefused = existing
      ? await readCurrent(path, signal)
      : { file: null };
    if (isRefusal(found)) return found;
    let current: Current = found;
    const catalog = await loadCatalog(input.directory, signal);
    const legacy = await readLegacy(
      input,
      requested,
      current,
      catalog,
      signal,
    );
    if (legacy && 'type' in legacy) return legacy;
    if (legacy && options.configuration)
      return refusal(plannedPath, 'Migrate this definition in the workflow editor before proposing a change.');
    if (legacy) current = legacy.current;
    if ((current.file?.contentHash ?? null) !== input.expectedHash)
      return conflict(input, legacy?.path ?? path, current.file);
    checkActiveRuns(input, roots.projectRoot, activeRuns);
    if (input.kind === 'workflow') {
      const unresolved = missingSteps(checked.steps, catalog, path);
      if (unresolved.length) return refusedIssues(unresolved);
      const workflow = {
        name: input.name,
        steps: checked.steps,
        edges: checked.edges,
        lanes: checked.lanes,
        layout: checked.layout,
      };
      const steps = new Map(catalog.steps.map(step => [step.name, step]));
      const graph = checkGraph(workflow, path, checked.lines, steps);
      const graphErrors = graph.issues.filter(
        item => item.severity === 'error',
      );
      if (graphErrors.length) return refusedIssues(graphErrors);
      const unguarded = options.guardExternal
        ? unguardedExternalIssues(workflow, path, steps)
        : [];
      if (unguarded.length) return refusedIssues(unguarded);
    } else if (options.guardExternal && checked.step) {
      const unguarded = await guardedStepIssues(
        input,
        checked.step,
        current.file,
        catalog,
        roots,
        path,
        signal,
      );
      if (unguarded.length) return refusedIssues(unguarded);
    }
    if (options.configuration?.preview) return catalog;
    const location = await prepareFolder(input, roots, true);
    if (!location || 'type' in location)
      return location ?? refusal(requested, 'The folder cannot be created.');
    if (
      options.expectedRoot &&
      pathKey(location.root) !== pathKey(options.expectedRoot)
    )
      return refusal(
        options.expectedRoot,
        `The definitions folder now resolves to ${location.root}, not ${options.expectedRoot} where this change was made.`,
      );
    options.onPrevious?.(current.file, location.root);
    const outcome = await publish(
      legacy ? { ...input, expectedHash: null } : input,
      location,
      signal,
      options.configuration?.authorize,
    );
    if (outcome !== 'written') return outcome;
    await removeLegacy(legacy, signal);
    return loadCatalog(input.directory, signal);
  }).catch(error => {
    if (error instanceof DefinitionError) throw error;
    return unavailable(error);
  });
}

export async function deleteDefinition(
  input: DeleteDefinitionInput,
  signal: AbortSignal,
  activeRuns?: ActiveRunLookup,
  options: WriteOptions = {},
): Promise<DefinitionWriteResult> {
  requireName(input.name);
  const roots = await resolveWriteRoots(input.directory, signal);
  const requested = input.scope === 'global' ? roots.global : roots.project;
  return withWriteLock(requested, options, async () => {
    const moved = await movedRoot(requested, options.expectedRoot);
    if (moved) return moved;
    const location = await prepareFolder(input, roots, false);
    if (location && 'type' in location) return location;
    const plannedPath = join(requested, `${input.kind}s`, `${input.name}.md`);
    let path = location?.path ?? plannedPath;
    const found: Current | WorkflowDefinitionRefused = location
      ? await readCurrent(path, signal)
      : { file: null };
    if (isRefusal(found)) return found;
    let current: Current = found;
    const catalog = await loadCatalog(input.directory, signal);
    const legacy = await readLegacy(
      input,
      requested,
      current,
      catalog,
      signal,
    );
    if (legacy && 'type' in legacy) return legacy;
    if (legacy && options.configuration)
      return refusal(plannedPath, 'Migrate this definition in the workflow editor before proposing a change.');
    if (legacy) {
      path = legacy.path;
      current = legacy.current;
    }
    if (current.file?.contentHash !== input.expectedHash)
      return conflict(input, path, current.file);
    checkActiveRuns(input, roots.projectRoot, activeRuns);
    if (input.kind === 'step') {
      const users = stepUsers(input.name, path, catalog);
      if (users.length) return refusedIssues(users);
    }
    const latest = await readCurrent(path, signal);
    if (isRefusal(latest)) return latest;
    if (latest.file?.contentHash !== input.expectedHash)
      return conflict(input, path, latest.file);
    if (options.configuration?.preview) return catalog;
    options.onPrevious?.(
      latest.file,
      location?.root ?? (await realpath(requested).catch(() => requested)),
    );
    try {
      options.configuration?.authorize();
      await unlink(path);
    } catch (error) {
      return unavailable(error);
    }
    return loadCatalog(input.directory, signal);
  }).catch(error => {
    if (error instanceof DefinitionError) throw error;
    return unavailable(error);
  });
}

const entryRequested = async (
  target: RuleEntryFileTarget,
  signal: AbortSignal,
) => {
  const roots = await resolveWriteRoots(target.directory, signal);
  return {
    roots,
    requested: target.scope === 'global' ? roots.global : roots.project,
  };
};

const entryConflict = (
  path: string,
  current: Current,
): RuleEntryFileWriteResult => ({
  type: 'conflict',
  path,
  currentHash: current.file?.contentHash ?? null,
});

export async function writeProjectProfile(
  directory: string,
  document: string | null,
  expectedHash: string | null,
  signal: AbortSignal,
  options: WriteOptions = {},
): Promise<RuleEntryFileWriteResult> {
  const path = join(directory, projectProfilePath);
  const folder = dirname(path);
  return exclusive(pathKey(path), async () => {
    const refuse = (message: string) => ({ type: 'refused' as const, issues: [issueAt(path, message)] });
    const canonical = await realpath(directory);
    if (pathKey(canonical) !== pathKey(directory) ||
      (options.expectedRoot && pathKey(canonical) !== pathKey(options.expectedRoot)))
      return refuse('The Project checkout changed location.');
    if (document !== null) {
      const issues = checkFileText(document, path);
      if (issues.length) return { type: 'refused', issues };
      try { parseProjectOverride(document); }
      catch { return refuse('The Project profile is invalid.'); }
      await mkdir(folder, { recursive: true });
    }
    try {
      if (pathKey(await realpath(folder)) !== pathKey(folder))
        return refuse('The Project profile folder must be inside the checkout.');
    } catch (error) {
      if (missing(error)) return entryConflict(path, { file: null });
      throw error;
    }
    const current = await readCurrent(path, signal);
    if (isRefusal(current)) return { type: 'refused', issues: current.issues };
    if ((current.file?.contentHash ?? null) !== expectedHash)
      return entryConflict(path, current);
    options.onPrevious?.(current.file, canonical);
    signal.throwIfAborted();
    if (document === null) {
      if (current.file) await unlink(path);
    } else {
      const published = await publishFile(document, expectedHash, { path, root: directory, folder, projectRoot: directory }, signal);
      if (published !== 'written')
        return isRefusal(published) ? { type: 'refused', issues: published.issues } : entryConflict(path, published);
    }
    return { type: 'written', path, root: canonical };
  });
}

export async function saveRuleEntryFile(
  input: SaveRuleEntryFileInput,
  signal: AbortSignal,
  options: WriteOptions = {},
): Promise<RuleEntryFileWriteResult> {
  requireName(input.name);
  const { roots, requested } = await entryRequested(input, signal);
  const plannedPath = join(requested, RULE_ENTRY_FOLDERS[input.type], `${input.name}.md`);
  const textIssues = checkFileText(input.document, plannedPath);
  if (textIssues.length) return { type: 'refused', issues: textIssues };
  const target = { ...input, kind: input.type };
  return withWriteLock(requested, options, async () => {
    const invalid = await input.validate(input.document);
    if (invalid.length)
      return {
        type: 'refused' as const,
        issues: invalid.map(message => issueAt(plannedPath, message)),
      };
    const moved = await movedRoot(requested, options.expectedRoot);
    if (moved) return { type: 'refused' as const, issues: moved.issues };
    const existing = await prepareFolder(target, roots, false);
    if (existing && 'type' in existing)
      return { type: 'refused' as const, issues: existing.issues };
    const path = existing?.path ?? plannedPath;
    const current: Current | WorkflowDefinitionRefused = existing
      ? await readCurrent(path, signal)
      : { file: null };
    if (isRefusal(current))
      return { type: 'refused' as const, issues: current.issues };
    if ((current.file?.contentHash ?? null) !== input.expectedHash)
      return entryConflict(path, current);
    if (options.configuration?.preview) return { type: 'written' as const, path, root: requested };
    const location = await prepareFolder(target, roots, true);
    if (!location || 'type' in location)
      return {
        type: 'refused' as const,
        issues: location?.issues ?? [
          issueAt(requested, 'The folder cannot be created.'),
        ],
      };
    if (
      options.expectedRoot &&
      pathKey(location.root) !== pathKey(options.expectedRoot)
    )
      return {
        type: 'refused' as const,
        issues: [
          issueAt(
            options.expectedRoot,
            `The workflows folder now resolves to ${location.root}, not ${options.expectedRoot} where this change was made.`,
          ),
        ],
      };
    options.onPrevious?.(current.file, location.root);
    const outcome = await publishFile(
      input.document,
      input.expectedHash,
      location,
      signal,
      options.configuration?.authorize,
    );
    if (outcome === 'written')
      return { type: 'written' as const, path: location.path, root: location.root };
    if (isRefusal(outcome))
      return { type: 'refused' as const, issues: outcome.issues };
    return entryConflict(location.path, outcome);
  }).catch(error => {
    if (error instanceof DefinitionError) throw error;
    return unavailable(error);
  });
}

export async function deleteRuleEntryFile(
  input: DeleteRuleEntryFileInput,
  signal: AbortSignal,
  options: WriteOptions = {},
): Promise<RuleEntryFileWriteResult> {
  requireName(input.name);
  const { roots, requested } = await entryRequested(input, signal);
  const target = { ...input, kind: input.type };
  return withWriteLock(requested, options, async () => {
    const moved = await movedRoot(requested, options.expectedRoot);
    if (moved) return { type: 'refused' as const, issues: moved.issues };
    const location = await prepareFolder(target, roots, false);
    if (location && 'type' in location)
      return { type: 'refused' as const, issues: location.issues };
    const path =
      location?.path ?? join(requested, RULE_ENTRY_FOLDERS[input.type], `${input.name}.md`);
    const latest: Current | WorkflowDefinitionRefused = location
      ? await readCurrent(path, signal)
      : { file: null };
    if (isRefusal(latest))
      return { type: 'refused' as const, issues: latest.issues };
    if (latest.file?.contentHash !== input.expectedHash)
      return entryConflict(path, latest);
    if (options.configuration?.preview) return { type: 'written' as const, path, root: requested };
    options.onPrevious?.(
      latest.file,
      location?.root ?? (await realpath(requested).catch(() => requested)),
    );
    try {
      options.configuration?.authorize();
      await unlink(path);
    } catch (error) {
      return unavailable(error);
    }
    return {
      type: 'written' as const,
      path,
      root: location?.root ?? requested,
    };
  }).catch(error => {
    if (error instanceof DefinitionError) throw error;
    return unavailable(error);
  });
}
