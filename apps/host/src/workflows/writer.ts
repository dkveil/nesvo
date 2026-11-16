import {
  stepNameSchema,
  type DefinitionCatalog,
  type DefinitionIssue,
  type DefinitionKind,
  type DefinitionScope,
  type DefinitionWriteResult,
  type GraphStep,
  type WorkflowDefinitionConflict,
  type WorkflowDefinitionRefused,
} from '@nesvo/contracts';
import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { text } from '../skills/portable';
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
  type DefinitionFile,
} from './definitions';

export type DefinitionTarget = {
  directory: string;
  scope: DefinitionScope;
  kind: DefinitionKind;
  name: string;
};

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
  onPrevious?: (file: DefinitionFile | null) => void;
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
  target: DefinitionTarget,
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

function guardedStepIssues(
  input: SaveDefinitionInput,
  step: GraphStep,
  catalog: DefinitionCatalog,
): DefinitionIssue[] {
  const effective = catalog.steps.find(item => item.name === input.name);
  if (effective && effective.source.scope !== input.scope) return [];
  const steps = new Map<string, GraphStep>(
    catalog.steps.map(item => [item.name, item]),
  );
  steps.set(input.name, step);
  return catalog.workflows
    .filter(workflow => workflow.steps.some(item => item.name === input.name))
    .flatMap(workflow =>
      unguardedExternalIssues(
        {
          name: workflow.name,
          steps: workflow.steps.map(item => item.name),
          edges: workflow.edges,
          layout: workflow.layout,
        },
        workflow.source.path,
        steps,
        input.name,
      ),
    );
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

async function publish(
  target: SaveDefinitionInput,
  location: Location,
  signal: AbortSignal,
): Promise<'written' | DefinitionWriteResult> {
  const temporary = `${location.path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, target.document, {
      mode: fileMode,
      flag: 'wx',
      flush: true,
    });
    if (target.expectedHash === null) {
      try {
        await link(temporary, location.path);
        return 'written';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          return unavailable(error);
      }
    } else {
      const current = await readCurrent(location.path, signal);
      if (isRefusal(current)) return current;
      if (current.file?.contentHash === target.expectedHash) {
        await rename(temporary, location.path);
        return 'written';
      }
    }
    const latest = await readCurrent(location.path, signal);
    return isRefusal(latest)
      ? latest
      : conflict(target, location.path, latest.file);
  } catch (error) {
    return unavailable(error);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
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
  return exclusive(pathKey(requested), async () => {
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
      const unguarded = guardedStepIssues(input, checked.step, catalog);
      if (unguarded.length) return refusedIssues(unguarded);
    }
    const location = await prepareFolder(input, roots, true);
    if (!location || 'type' in location)
      return location ?? refusal(requested, 'The folder cannot be created.');
    options.onPrevious?.(current.file);
    const outcome = await publish(
      legacy ? { ...input, expectedHash: null } : input,
      location,
      signal,
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
  return exclusive(pathKey(requested), async () => {
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
    options.onPrevious?.(latest.file);
    try {
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
