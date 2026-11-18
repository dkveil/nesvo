import {
  workflowSharingLimits,
  type DefinitionIssue,
  type DefinitionKind,
  type ImportWorkflowBundleInput,
  type StepDefinition,
  type WorkflowImportFile,
  type WorkflowImportResult,
  type WorkflowShareBundle,
  type WorkflowShareDraft,
  type WorkflowShareFinding,
} from '@nesvo/contracts';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  capIssues,
  checkDocument,
  checkGraph,
  DefinitionError,
  loadCatalog,
  missing,
  readDefinitionFile,
  resolveWriteRoots,
} from './definitions';
import { maskProbeText, secretPatterns, detectedLabels } from './steps/sensitive-patterns';
import { saveDefinition, type ActiveRunLookup } from './writer';

type ShareFile = { fileName: string; content: string };

const SUGGESTION_ATTEMPTS = 50;

export function scanShareFiles(files: readonly ShareFile[]): {
  findings: WorkflowShareFinding[];
  count: number;
} {
  const findings: WorkflowShareFinding[] = [];
  let count = 0;
  for (const file of files)
    file.content.split(/\r?\n/).forEach((line, index) => {
      for (const label of detectedLabels(line, secretPatterns)) {
        count++;
        if (findings.length < workflowSharingLimits.findings)
          findings.push({
            fileName: file.fileName,
            line: index + 1,
            label,
            excerpt: maskProbeText(line.trim()).slice(
              0,
              workflowSharingLimits.excerpt,
            ),
          });
      }
    });
  return { findings, count };
}

export async function prepareShare(
  directory: string,
  name: string,
  signal: AbortSignal,
): Promise<WorkflowShareDraft> {
  const catalog = await loadCatalog(directory, signal);
  const workflow = catalog.workflows.find(item => item.name === name);
  if (!workflow)
    throw new DefinitionError(
      'invalid',
      `The workflow "${name}" is missing or has errors. Fix its issues before sharing it.`,
    );
  const workflowFile = await readDefinitionFile(workflow.source.path, signal);
  const steps = [];
  for (const step of workflow.steps) {
    const file = await readDefinitionFile(step.source.path, signal);
    steps.push({
      fileName: `${step.name}.md`,
      content: file.text,
      type: step.type,
      scope: step.source.scope,
    });
  }
  const shared = { fileName: `${name}.md`, content: workflowFile.text };
  const { findings, count } = scanShareFiles([shared, ...steps]);
  return {
    name,
    description: workflow.description ?? null,
    scope: workflow.source.scope,
    workflow: shared,
    steps,
    findings,
    findingCount: count,
  };
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function issueAt(path: string, message: string): DefinitionIssue {
  return { severity: 'error', path, line: null, message };
}

export function renameWorkflowDocument(
  content: string,
  from: string,
  to: string,
): string | null {
  if (from === to) return content;
  const frontmatter = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(
    content,
  );
  if (!frontmatter) return null;
  const pattern = new RegExp(
    `^(name:[ \\t]*)(["']?)${from}\\2([ \\t]*)$`,
    'm',
  );
  if (!pattern.test(frontmatter[2]!)) return null;
  const renamed = frontmatter[2]!.replace(pattern, `$1$2${to}$2$3`);
  return (
    frontmatter[1] +
    renamed +
    frontmatter[3] +
    content.slice(frontmatter[0].length)
  );
}

function bundleIssues(
  bundle: WorkflowShareBundle,
  workflowName: string,
  workflowDocument: string,
  root: string,
): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const steps = new Map<string, StepDefinition>();
  for (const file of bundle.steps) {
    const name = file.fileName.slice(0, -'.md'.length);
    const path = join(root, 'steps', file.fileName);
    const checked = checkDocument('step', path, file.content);
    issues.push(...checked.issues.filter(item => item.severity === 'error'));
    if (checked.name !== null && checked.name !== name)
      issues.push(
        issueAt(path, `Field "name" must be "${name}" to match the file name`),
      );
    if (checked.step) steps.set(name, checked.step);
  }
  const path = join(root, 'workflows', `${workflowName}.md`);
  const checked = checkDocument('workflow', path, workflowDocument);
  issues.push(...checked.issues.filter(item => item.severity === 'error'));
  if (checked.name !== null && checked.name !== workflowName)
    issues.push(
      issueAt(
        path,
        `Field "name" must be "${workflowName}" to match the file name`,
      ),
    );
  const shared = new Set(
    bundle.steps.map(file => file.fileName.slice(0, -'.md'.length)),
  );
  for (const step of checked.steps)
    if (!shared.has(step))
      issues.push(
        issueAt(path, `The shared workflow lists step "${step}" without its file.`),
      );
  for (const step of shared)
    if (!checked.steps.includes(step))
      issues.push(
        issueAt(
          join(root, 'steps', `${step}.md`),
          `The shared step "${step}" is not used by the workflow.`,
        ),
      );
  if (!issues.length && checked.steps.length) {
    const graph = checkGraph(
      {
        name: workflowName,
        steps: checked.steps,
        edges: checked.edges,
        layout: checked.layout,
      },
      path,
      checked.lines,
      steps,
    );
    issues.push(...graph.issues.filter(item => item.severity === 'error'));
  }
  return capIssues(issues);
}

async function currentFile(path: string, signal: AbortSignal) {
  try {
    await lstat(path);
  } catch (error) {
    if (missing(error)) return null;
    throw new DefinitionError('unavailable', 'The file cannot be accessed.');
  }
  return readDefinitionFile(path, signal);
}

async function plannedFile(
  kind: DefinitionKind,
  name: string,
  content: string,
  root: string,
  signal: AbortSignal,
): Promise<WorkflowImportFile> {
  const path = join(root, `${kind}s`, `${name}.md`);
  const current = await currentFile(path, signal);
  return {
    kind,
    name,
    state: !current
      ? 'new'
      : current.contentHash === hash(content)
        ? 'same'
        : 'different',
    currentHash: current?.contentHash ?? null,
    currentContent: current?.text ?? null,
    path,
  };
}

async function suggestName(
  base: string,
  root: string,
  taken: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<string | null> {
  const stem = base.replace(/-\d+$/, '');
  for (let index = 2; index < SUGGESTION_ATTEMPTS + 2; index++) {
    const candidate = `${stem}-${index}`.slice(0, 64).replace(/-+$/, '');
    if (taken.has(candidate)) continue;
    if (!(await currentFile(join(root, 'workflows', `${candidate}.md`), signal)))
      return candidate;
  }
  return null;
}

export type ImportOptions = {
  directory: string;
  activeRuns?: ActiveRunLookup;
};

export async function importBundle(
  input: Omit<ImportWorkflowBundleInput, 'target'> & {
    scope: 'global' | 'project';
    overwrite?: ImportWorkflowBundleInput['overwrite'];
  },
  options: ImportOptions,
  signal: AbortSignal,
): Promise<WorkflowImportResult> {
  const roots = await resolveWriteRoots(options.directory, signal);
  const root = input.scope === 'global' ? roots.global : roots.project;
  const workflowName = input.workflowName;
  const renamed = renameWorkflowDocument(
    input.bundle.workflow.content,
    input.bundle.name,
    workflowName,
  );
  const workflowPath = join(root, 'workflows', `${workflowName}.md`);
  const issues = renamed
    ? bundleIssues(input.bundle, workflowName, renamed, root)
    : [
        issueAt(
          workflowPath,
          'The workflow name could not be changed in its file. Keep the shared name.',
        ),
      ];
  const document = renamed ?? input.bundle.workflow.content;
  const files: WorkflowImportFile[] = [];
  for (const file of input.bundle.steps)
    files.push(
      await plannedFile(
        'step',
        file.fileName.slice(0, -'.md'.length),
        file.content,
        root,
        signal,
      ),
    );
  files.push(
    await plannedFile('workflow', workflowName, document, root, signal),
  );
  const workflowState = files.at(-1)!;
  const suggestedName =
    workflowState.state === 'different'
      ? await suggestName(
          workflowName,
          root,
          new Set(files.filter(file => file.kind === 'step').map(file => file.name)),
          signal,
        )
      : null;
  const scan = scanShareFiles([
    { fileName: `${workflowName}.md`, content: document },
    ...input.bundle.steps,
  ]);
  const base = {
    findings: scan.findings,
    findingCount: scan.count,
    scope: input.scope,
    root,
    directory: options.directory,
    workflowName,
    suggestedName,
    files,
    issues,
  };
  const overwrite = input.overwrite ?? [];
  const approved = (file: WorkflowImportFile) =>
    overwrite.some(
      item =>
        item.kind === file.kind &&
        item.name === file.name &&
        item.expectedHash === file.currentHash,
    );
  const blocked =
    issues.length > 0 ||
    files.some(file => file.state === 'different' && !approved(file));
  if (!input.write) return { ...base, status: blocked ? 'blocked' : 'ready' };
  if (blocked) return { ...base, status: 'blocked' };
  const contents = new Map<string, string>(
    input.bundle.steps.map(file => [
      `step:${file.fileName.slice(0, -'.md'.length)}`,
      file.content,
    ]),
  );
  contents.set(`workflow:${workflowName}`, document);
  for (const file of files) {
    if (file.state === 'same') continue;
    const result = await saveDefinition(
      {
        directory: options.directory,
        scope: input.scope,
        kind: file.kind,
        name: file.name,
        document: contents.get(`${file.kind}:${file.name}`)!,
        expectedHash: file.state === 'new' ? null : file.currentHash,
      },
      signal,
      options.activeRuns,
    );
    if (!('type' in result)) continue;
    const failure =
      result.type === 'workflow-definition-refused'
        ? result.issues
        : [
            issueAt(
              result.path,
              'The file changed while it was imported. Review it and import again.',
            ),
          ];
    return { ...base, status: 'failed', issues: capIssues(failure) };
  }
  return { ...base, status: 'saved' };
}
