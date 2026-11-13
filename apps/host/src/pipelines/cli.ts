import {
  stepNameSchema,
  type DefinitionCatalog,
  type DefinitionIssue,
  type DefinitionScope,
  type DefinitionWriteResult,
} from '@nesvo/contracts';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  checkDocument,
  DefinitionError,
  definitionReadLimits,
  loadCatalog,
  readDefinitionFile,
  resolveWriteRoots,
} from './definitions';
import { editStepsList, type StepsListEdit } from './steps-list';
import { saveDefinition } from './writer';

export type CliOutput = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export const cliExitCodes = {
  ok: 0,
  invalid: 1,
  conflict: 2,
  runSession: 3,
  usage: 64,
} as const;

const optionSpecification = {
  directory: { type: 'string' },
  scope: { type: 'string' },
  file: { type: 'string' },
  pipeline: { type: 'string' },
  step: { type: 'string' },
  after: { type: 'string' },
  'expected-hash': { type: 'string' },
  json: { type: 'boolean' },
} as const;

const usage =
  'Usage: pipelines <validate|list|add-step|add-to-pipeline|remove-from-pipeline> [options]';
const conflictMessage = 'The file changed since it was read. Read it again.';
const hashPattern = /^[a-f0-9]{64}$/;
const commandTimeoutMilliseconds = 60_000;
const holdPollMilliseconds = 20;
const holdPolls = 500;

type Options = {
  directory: string;
  scope: DefinitionScope | null;
  file: string | null;
  pipeline: string | null;
  step: string | null;
  after: string | null;
  expectedHash: string | null;
  json: boolean;
};

type Context = {
  options: Options;
  env: NodeJS.ProcessEnv;
  output: CliOutput;
  signal: AbortSignal;
};

class UsageError extends Error {}

function parseCliArgs(args: string[]) {
  return parseArgs({
    args,
    options: optionSpecification,
    allowPositionals: true,
    strict: true,
  });
}

function parseOptions(args: string[]): { command: string; options: Options } {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n${usage}`);
  }
  const [command, ...extra] = parsed.positionals;
  if (!command || extra.length) throw new UsageError(usage);
  const { values } = parsed;
  if (values.scope && values.scope !== 'project' && values.scope !== 'global')
    throw new UsageError('Use --scope project or --scope global.');
  const expectedHash = values['expected-hash'] ?? null;
  if (expectedHash && !hashPattern.test(expectedHash))
    throw new UsageError('--expected-hash must be a 64-character lowercase hex hash.');
  return {
    command,
    options: {
      directory: resolve(values.directory ?? process.cwd()),
      scope: (values.scope as DefinitionScope | undefined) ?? null,
      file: values.file ?? null,
      pipeline: values.pipeline ?? null,
      step: values.step ?? null,
      after: values.after ?? null,
      expectedHash,
      json: values.json ?? false,
    },
  };
}

function needed<T>(value: T | null, flag: string): T {
  if (value === null) throw new UsageError(`${flag} is required.`);
  return value;
}

function requireName(value: string | null, flag: string): string {
  const name = needed(value, flag);
  if (!stepNameSchema.safeParse(name).success)
    throw new UsageError(
      `${flag} must use lowercase letters, digits and single hyphens.`,
    );
  return name;
}

function renderIssue(issue: DefinitionIssue): string {
  const location = issue.path
    ? ` ${issue.path}${issue.line ? `:${issue.line}` : ''}`
    : '';
  return `${issue.severity}${location}: ${issue.message}`;
}

function printJson(context: Context, value: unknown) {
  context.output.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function printIssues(context: Context, issues: DefinitionIssue[]) {
  if (context.options.json)
    return printJson(context, { type: 'pipeline-definition-refused', issues });
  for (const issue of issues) context.output.stderr(`${renderIssue(issue)}\n`);
}

function refuse(context: Context, message: string, path = ''): number {
  const issue: DefinitionIssue = {
    severity: 'error',
    path,
    line: null,
    message,
  };
  printIssues(context, [issue]);
  return cliExitCodes.invalid;
}

function hasErrors(issues: DefinitionIssue[]): boolean {
  return issues.some(issue => issue.severity === 'error');
}

function describeCatalog(catalog: DefinitionCatalog): string {
  const lines = [
    ...catalog.steps.map(
      step => `step ${step.name} ${step.source.scope} ${step.source.contentHash}`,
    ),
    ...catalog.pipelines.map(
      pipeline =>
        `pipeline ${pipeline.name} ${pipeline.source.scope} ${pipeline.source.contentHash}`,
    ),
  ];
  return lines.length ? `${lines.join('\n')}\n` : 'No definitions found.\n';
}

function savedHash(
  catalog: DefinitionCatalog,
  kind: 'step' | 'pipeline',
  name: string,
  scope: DefinitionScope,
): string | null {
  const entries = kind === 'step' ? catalog.steps : catalog.pipelines;
  return (
    entries.find(item => item.name === name && item.source.scope === scope)
      ?.source.contentHash ?? null
  );
}

function reportWrite(
  context: Context,
  result: DefinitionWriteResult,
  summary: (catalog: DefinitionCatalog) => string,
): number {
  if (!('type' in result)) {
    if (context.options.json) printJson(context, result);
    else context.output.stdout(`${summary(result)}\n`);
    return cliExitCodes.ok;
  }
  if (context.options.json) printJson(context, result);
  if (result.type === 'pipeline-definition-refused') {
    if (!context.options.json) printIssues(context, result.issues);
    return cliExitCodes.invalid;
  }
  if (!context.options.json)
    context.output.stderr(
      `${conflictMessage}\nPath: ${result.path}\nCurrent hash: ${result.currentHash ?? 'none (the file does not exist)'}\n`,
    );
  return cliExitCodes.conflict;
}

async function readDocument(
  path: string,
): Promise<{ document: string } | { issue: string }> {
  try {
    const status = await stat(path);
    if (!status.isFile()) return { issue: 'The path is not a regular file.' };
    if (status.size > definitionReadLimits.fileBytes)
      return {
        issue: `The file exceeds the ${definitionReadLimits.fileBytes / 1024} KiB limit.`,
      };
    const bytes = await readFile(path);
    return {
      document: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    };
  } catch (error) {
    return {
      issue:
        error instanceof TypeError
          ? 'The file must be valid UTF-8 text.'
          : 'The file cannot be read.',
    };
  }
}

async function holdForReader(env: NodeJS.ProcessEnv) {
  const marker = env.NESVO_TEST_MODE === '1' ? env.NESVO_PIPELINES_CLI_HOLD : null;
  if (!marker || !isAbsolute(marker)) return;
  await writeFile(`${marker}.ready`, '');
  for (let poll = 0; poll < holdPolls; poll++) {
    const released = await stat(`${marker}.release`).then(
      () => true,
      () => false,
    );
    if (released) return;
    await sleep(holdPollMilliseconds);
  }
}

async function validate(context: Context): Promise<number> {
  const catalog = await loadCatalog(context.options.directory, context.signal);
  if (context.options.json) printJson(context, { issues: catalog.issues });
  else {
    for (const issue of catalog.issues)
      context.output.stderr(`${renderIssue(issue)}\n`);
    if (!catalog.issues.length) context.output.stdout('No issues.\n');
  }
  return hasErrors(catalog.issues) ? cliExitCodes.invalid : cliExitCodes.ok;
}

async function list(context: Context): Promise<number> {
  const catalog = await loadCatalog(context.options.directory, context.signal);
  if (context.options.json) printJson(context, catalog);
  else {
    context.output.stdout(describeCatalog(catalog));
    for (const issue of catalog.issues)
      context.output.stderr(`${renderIssue(issue)}\n`);
  }
  return cliExitCodes.ok;
}

async function addStep(context: Context): Promise<number> {
  const { options } = context;
  const scope = needed(options.scope, '--scope');
  const file = resolve(needed(options.file, '--file'));
  const read = await readDocument(file);
  if ('issue' in read) return refuse(context, read.issue, file);
  const checked = checkDocument('step', file, read.document);
  if (checked.name === null) {
    const issues = hasErrors(checked.issues)
      ? checked.issues
      : [
          ...checked.issues,
          {
            severity: 'error' as const,
            path: file,
            line: null,
            message: 'The step needs a "name" field.',
          },
        ];
    printIssues(context, issues);
    return cliExitCodes.invalid;
  }
  const name = checked.name;
  const result = await saveDefinition(
    {
      directory: options.directory,
      scope,
      kind: 'step',
      name,
      document: read.document,
      expectedHash: options.expectedHash,
    },
    context.signal,
  );
  return reportWrite(context, result, catalog => {
    const hash = savedHash(catalog, 'step', name, scope);
    return `Saved step "${name}" (${scope})${hash ? `, hash ${hash}` : ''}`;
  });
}

async function editPipeline(
  context: Context,
  edit: StepsListEdit,
): Promise<number> {
  const { options } = context;
  const scope = needed(options.scope, '--scope');
  const pipeline = requireName(options.pipeline, '--pipeline');
  const roots = await resolveWriteRoots(options.directory, context.signal);
  const path = join(roots[scope], 'pipelines', `${pipeline}.md`);
  const current = await readDefinitionFile(path, context.signal);
  const edited = editStepsList(current.text, edit);
  if (!edited.ok) return refuse(context, edited.message, path);
  await holdForReader(context.env);
  const result = await saveDefinition(
    {
      directory: options.directory,
      scope,
      kind: 'pipeline',
      name: pipeline,
      document: edited.text,
      expectedHash: options.expectedHash ?? current.contentHash,
    },
    context.signal,
  );
  return reportWrite(context, result, catalog => {
    const hash = savedHash(catalog, 'pipeline', pipeline, scope);
    const verb = edit.kind === 'add' ? 'Added' : 'Removed';
    const direction = edit.kind === 'add' ? 'to' : 'from';
    return `${verb} step "${edit.step}" ${direction} pipeline "${pipeline}" (${scope})${hash ? `, hash ${hash}` : ''}`;
  });
}

function addToPipeline(context: Context): Promise<number> {
  const step = requireName(context.options.step, '--step');
  const after = context.options.after
    ? requireName(context.options.after, '--after')
    : null;
  return editPipeline(context, { kind: 'add', step, after });
}

function removeFromPipeline(context: Context): Promise<number> {
  const step = requireName(context.options.step, '--step');
  return editPipeline(context, { kind: 'remove', step });
}

const readCommands = { validate, list };
const writeCommands = {
  'add-step': addStep,
  'add-to-pipeline': addToPipeline,
  'remove-from-pipeline': removeFromPipeline,
};

function runSessionRefusal(env: NodeJS.ProcessEnv): string | null {
  const runId = env.NESVO_RUN_ID?.trim();
  return runId
    ? `Pipeline definitions cannot be changed from inside pipeline run ${runId}. Ask the operator.`
    : null;
}

function reportFailure(
  output: CliOutput,
  json: boolean,
  message: string,
  issues: DefinitionIssue[],
) {
  if (json) {
    const reported = issues.length
      ? issues
      : [{ severity: 'error' as const, path: '', line: null, message }];
    output.stdout(
      `${JSON.stringify({ type: 'pipeline-definition-refused', issues: reported }, null, 2)}\n`,
    );
    return;
  }
  output.stderr(`${message}\n`);
  for (const issue of issues) output.stderr(`${renderIssue(issue)}\n`);
}

export async function runPipelinesCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  output: CliOutput,
): Promise<number> {
  const json = args.includes('--json');
  try {
    const { command, options } = parseOptions(args);
    const context: Context = {
      options,
      env,
      output,
      signal: AbortSignal.timeout(commandTimeoutMilliseconds),
    };
    if (Object.hasOwn(readCommands, command))
      return await readCommands[command as keyof typeof readCommands](context);
    if (!Object.hasOwn(writeCommands, command)) throw new UsageError(usage);
    const refusal = runSessionRefusal(env);
    if (refusal) {
      reportFailure(output, json, refusal, []);
      return cliExitCodes.runSession;
    }
    return await writeCommands[command as keyof typeof writeCommands](context);
  } catch (error) {
    if (error instanceof UsageError) {
      reportFailure(output, json, error.message, []);
      return cliExitCodes.usage;
    }
    if (error instanceof DefinitionError) {
      reportFailure(output, json, error.message, error.issues);
      return cliExitCodes.invalid;
    }
    reportFailure(
      output,
      json,
      error instanceof Error ? error.message : 'The command failed.',
      [],
    );
    return cliExitCodes.invalid;
  }
}
