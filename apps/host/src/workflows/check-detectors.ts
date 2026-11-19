import type {
  CheckCandidate,
  ProjectCheckOverride,
  ResolvedStep,
} from '@nesvo/contracts';
import { posix } from 'node:path';
import { yamlMapping } from '../skills/portable';
import type { DefinitionFile } from './definitions';
import {
  windows,
  sourceAt,
  parseCheckCommand,
  isUniversalTest,
  type CandidateInput,
  type Invocation,
} from './check-inventory';

export type DetectorContext = {
  root: string;
  module: string;
  files: ReadonlyMap<string, DefinitionFile>;
  preferences: readonly ResolvedStep[];
  override: ProjectCheckOverride;
};
export type CheckDetector = (context: DetectorContext) => CandidateInput[];

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const testScope = (name: string) => {
  const suffix = /^tests?(?:[-_:](.+)|([A-Z].*))?$/.exec(name);
  const prefix = /^([a-z][\w.-]*)Tests?$/.exec(name);
  if (!suffix && !prefix) return null;
  const scope = (suffix?.[1] ?? suffix?.[2] ?? prefix?.[1] ?? '').toLowerCase();
  return !scope || scope === 'all' || scope === 'ci'
    ? 'tests'
    : 'tests:' + scope;
};

export const packageManagers = ['bun', 'npm', 'pnpm', 'yarn'] as const;
const lockfiles = {
  bun: ['bun.lock', 'bun.lockb'],
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
};
export const packageInputs = [
  'package.json',
  ...Object.values(lockfiles).flat(),
];
export const gradleInputs = [
  'settings.gradle',
  'settings.gradle.kts',
  'build.gradle',
  'build.gradle.kts',
  'gradle.properties',
  'gradle/wrapper/gradle-wrapper.properties',
  windows ? 'gradlew.bat' : 'gradlew',
];

const atModule = (context: DetectorContext, name: string) =>
  context.files.get(posix.join(context.module, name));

function packageJson(file: DefinitionFile | undefined) {
  try {
    return object(file && JSON.parse(file.text));
  } catch {
    return {};
  }
}

export function packageManager(context: DetectorContext) {
  const project = packageJson(atModule(context, 'package.json'));
  const root = packageJson(context.files.get('package.json'));
  const declared = project.packageManager ?? root.packageManager;
  if (typeof declared === 'string')
    return (
      packageManagers.find(tool => declared.startsWith(tool + '@')) ?? null
    );
  for (const directory of new Set([context.module, '.'])) {
    const matches = packageManagers.filter(tool =>
      lockfiles[tool].some(name =>
        context.files.has(posix.join(directory, name)),
      ),
    );
    if (matches.length) return matches.length === 1 ? matches[0]! : null;
  }
  return 'npm';
}

export const detectPackageScripts: CheckDetector = context => {
  const file = atModule(context, 'package.json');
  if (!file) return [];
  const scripts = object(packageJson(file).scripts);
  const explicit = context.override.checks?.tests;
  const preferred = context.preferences.flatMap(
    step => step.preferred?.typescript?.script ?? [],
  );
  const configured =
    explicit?.runner === 'package-script' ? [explicit.script] : [];
  const names = new Set([
    ...configured,
    ...preferred,
    ...Object.keys(scripts)
      .filter(name => testScope(name) !== null)
      .sort(),
  ]);
  return [...names].map(script => {
    const command = scripts[script];
    const exists =
      Object.hasOwn(scripts, script) &&
      typeof command === 'string' &&
      Boolean(command.trim());
    const coverage =
      testScope(script) ??
      (configured.includes(script) ? 'tests' : 'unverified');
    return {
      target: { runner: 'package-script', script },
      coverage,
      directory: context.module,
      source: sourceAt(context.root, file, 'scripts.' + script),
      availability:
        coverage === 'unverified'
          ? 'unverified'
          : exists
            ? 'available'
            : 'missing',
      reason:
        coverage === 'unverified'
          ? 'The script has no verified test intent.'
          : exists
            ? null
            : 'The script is absent from package.json.',
    };
  });
};

const gradleLexical =
  /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_][\w-]*|[.()<>{}=]|[^\s]/g;

export const gradleBuildFile = (context: DetectorContext) =>
  atModule(context, 'build.gradle.kts') ?? atModule(context, 'build.gradle');

export const detectGradle: CheckDetector = context => {
  const file = gradleBuildFile(context);
  if (!file) return [];
  const normalized = [...file.text.matchAll(gradleLexical)]
    .map(match => match[0])
    .filter(token => !token.startsWith('//') && !token.startsWith('/*'))
    .join(' ');
  const defaults =
    /\bplugins \{[^}]*(?:\bjava\b|\bjava-library\b|["'](?:java(?:-library)?|org\.jetbrains\.kotlin\.jvm|jvm)["'])/.test(
      normalized,
    );
  const declared = new Set(
    [
      ...normalized.matchAll(
        /\btasks \. (?:register|create) (?:< Test > )?\( ["']([\w.-]+)["'](?: [),])/g,
      ),
    ].map(match => match[1]!),
  );
  if (defaults) declared.add('test');
  const configured = context.override.checks?.tests;
  const tasks = [
    ...(configured?.runner === 'gradle-wrapper' ? [configured.task] : []),
    ...context.preferences.flatMap(step => step.preferred?.kotlin?.task ?? []),
    ...[...declared].filter(name => testScope(name) !== null).sort(),
  ];
  const prefix =
    context.module === '.'
      ? ':'
      : ':' + context.module.replaceAll('/', ':') + ':';
  return [
    ...new Set(
      tasks.map(task =>
        task.includes(':')
          ? task.startsWith(':')
            ? task
            : ':' + task
          : prefix + task,
      ),
    ),
  ].flatMap(task => {
    if (!task.startsWith(prefix)) return [];
    const name = task.slice(prefix.length);
    if (name.includes(':')) return [];
    const coverage =
      testScope(name) ??
      (configured?.runner === 'gradle-wrapper' &&
      configured.task.split(':').at(-1) === name
        ? 'tests'
        : 'unverified');
    const available = coverage !== 'unverified' && declared.has(name);
    return [
      {
        target: { runner: 'gradle-wrapper' as const, task },
        coverage,
        directory: context.module,
        source: sourceAt(context.root, file, 'task ' + task),
        availability: available
          ? ('available' as const)
          : ('unverified' as const),
        reason: available
          ? null
          : 'The Gradle test task could not be established from the build file.',
      },
    ];
  });
};

export const universalInputs = [
  'Makefile',
  'makefile',
  'GNUmakefile',
  'justfile',
  'Justfile',
  'Taskfile.yml',
  'Taskfile.yaml',
  'README.md',
  'CONTRIBUTING.md',
  '.gitlab-ci.yml',
  '.circleci/config.yml',
  'azure-pipelines.yml',
  'azure-pipelines.yaml',
  '.travis.yml',
  'Jenkinsfile',
  ...(windows
    ? ['scripts/test.cmd', 'scripts/test.bat']
    : ['scripts/test', 'scripts/test.sh']),
];

function detectedCommand(
  context: DetectorContext,
  file: DefinitionFile,
  location: string,
  command: string,
): CandidateInput[] {
  const target = parseCheckCommand(command);
  return target && isUniversalTest(target)
    ? [
        {
          target,
          coverage: 'tests',
          directory: context.module,
          source: sourceAt(context.root, file, location),
          availability: 'available',
          reason: null,
        },
      ]
    : [];
}

function structuredCi(file: DefinitionFile): [string, string][] {
  const data = yamlMapping(file.text, 'CI');
  if (file.path.replaceAll('\\', '/').includes('/.github/workflows/')) {
    if (data.defaults || data.env) return [];
    return Object.entries(object(data.jobs)).flatMap(([name, value]) => {
      const job = object(value);
      if (job.defaults || job.container || job.env || !Array.isArray(job.steps))
        return [];
      return job.steps.flatMap((raw, index) => {
        const step = object(raw);
        return typeof step.run === 'string' &&
          !step.env &&
          !step['working-directory'] &&
          !step.shell &&
          !step.if
          ? [
              [
                name +
                  ' / ' +
                  (typeof step.name === 'string'
                    ? step.name
                    : 'step ' + (index + 1)),
                step.run,
              ] as [string, string],
            ]
          : [];
      });
    });
  }
  const commands = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
  const name = posix.basename(file.path.replaceAll('\\', '/'));
  if (name === '.gitlab-ci.yml')
    return Object.entries(data).flatMap(([job, value]) =>
      commands(object(value).script).map((text): [string, string] => [
        job + ' / script',
        text,
      ]),
    );
  if (name === '.travis.yml')
    return commands(data.script).map(text => ['script', text]);
  const steps = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.map(object) : [];
  if (file.path.replaceAll('\\', '/').includes('/.circleci/'))
    return Object.entries(object(data.jobs)).flatMap(([job, value]) =>
      !object(value).working_directory
        ? steps(object(value).steps).flatMap(step =>
            commands(
              typeof step.run === 'string'
                ? step.run
                : object(step.run).command,
            ).map((text): [string, string] => [job + ' / run', text]),
          )
        : [],
    );
  return [
    ...steps(data.steps).map(step => ['steps', step] as const),
    ...steps(data.jobs).flatMap(job =>
      steps(job.steps).map(step => [String(job.job ?? 'job'), step] as const),
    ),
  ].flatMap(([job, step]) =>
    !step.workingDirectory && !step.env && !step.condition
      ? commands(step.script ?? step.bash ?? step.pwsh).map(
          (text): [string, string] => [job + ' / script', text],
        )
      : [],
  );
}

const taskPatterns = {
  make: /^([A-Za-z][\w.-]*):(?:[^=]|$)/gm,
  just: /^([A-Za-z][\w.-]*):[^\r\n]*$/gm,
};

export const detectUniversal: CheckDetector = context => {
  const results: CandidateInput[] = [];
  for (const [path, file] of context.files) {
    const filename = posix.basename(path);
    if (
      posix.dirname(path) === posix.join(context.module, 'scripts') &&
      /^test(?:\.(?:cmd|bat|sh))?$/.test(filename)
    ) {
      const script = './scripts/' + filename;
      const target = parseCheckCommand(script);
      if (target)
        results.push({
          target,
          coverage: 'tests',
          directory: context.module,
          source: sourceAt(context.root, file, 'test entry point'),
          availability: 'available',
          reason: null,
        });
    }
    if (
      posix.dirname(path) === context.module &&
      /^(?:GNUmakefile|makefile|justfile|taskfile\.(?:yml|yaml))$/i.test(
        filename,
      )
    ) {
      const tool = /^justfile$/i.test(filename)
        ? 'just'
        : /^taskfile/i.test(filename)
          ? 'task'
          : 'make';
      try {
        const tasks =
          tool === 'task'
            ? Object.keys(object(yamlMapping(file.text, 'Taskfile').tasks))
            : [...file.text.matchAll(taskPatterns[tool])].map(
                match => match[1]!,
              );
        for (const task of tasks.slice(0, 100))
          results.push(
            ...detectedCommand(
              context,
              file,
              'target ' + task,
              tool + ' ' + task,
            ),
          );
      } catch {
        continue;
      }
    }
    if (
      /^(?:README|CONTRIBUTING)\.md$/i.test(filename) &&
      posix.dirname(path) === context.module
    ) {
      let section = filename;
      let fence = false;
      for (const line of file.text.split(/\r?\n/)) {
        if (/^(?: {0,3})(?:\x60{3,}|~{3,})/.test(line)) {
          fence = !fence;
        } else if (fence) {
          results.push(
            ...detectedCommand(
              context,
              file,
              section,
              line.replace(/^\s*\$ /, ''),
            ),
          );
        } else if (/^#{1,6}\s/.test(line)) {
          section = line.replace(/^#+\s*/, '').trim() || filename;
        }
      }
    }
    if (
      context.module !== '.' ||
      !/(?:\.ya?ml|Jenkinsfile)$/i.test(path) ||
      !(
        path.startsWith('.github/workflows/') ||
        (universalInputs.includes(path) && !/^taskfile/i.test(filename))
      )
    )
      continue;
    try {
      const commands: [string, string][] =
        filename === 'Jenkinsfile'
          ? [
              ...file.text.matchAll(
                /^\s*(?:sh|bat) ['"]([^'"\r\n]+)['"]\s*$/gm,
              ),
            ].map(match => ['pipeline / command', match[1]!])
          : structuredCi(file);
      for (const [location, command] of commands)
        results.push(...detectedCommand(context, file, location, command));
    } catch {
      continue;
    }
  }
  return results;
};

export function commandFor(
  target: CheckCandidate['target'],
  context: DetectorContext,
): Invocation | null {
  if ('tool' in target) return target;
  if (target.runner === 'gradle-wrapper')
    return {
      tool: windows ? './gradlew.bat' : './gradlew',
      args: [
        '--offline',
        '--no-daemon',
        '--console=plain',
        '--rerun-tasks',
        '--no-build-cache',
        target.task,
      ],
    };
  const tool = packageManager(context);
  return tool ? { tool, args: ['run', target.script] } : null;
}
