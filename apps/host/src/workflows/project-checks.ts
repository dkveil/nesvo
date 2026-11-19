import {
  checkProjectProfileSchema,
  checkStackDetectors,
  checkStackSchema,
  projectCheckOverrideSchema,
  type CheckCandidate,
  type CheckProjectProfile,
  type CheckStack,
  type ProjectCheckOverride,
  type ResolvedStep,
} from '@nesvo/contracts';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import { document, yamlMapping } from '../skills/portable';
import { inside, missing, pathKey, type DefinitionFile } from './definitions';
import {
  commandFor,
  detectGradle,
  detectPackageScripts,
  detectUniversal,
  gradleBuildFile,
  gradleInputs,
  packageInputs,
  universalInputs,
  type CheckDetector,
  type DetectorContext,
} from './check-detectors';
import {
  candidate,
  hashText,
  launcher,
  parseCheckCommand,
  readCheckInput,
  sourceAt,
  windows,
  type CandidateInput,
  type Invocation,
} from './check-inventory';

export const projectProfilePath = '.agents/project.md';
const maxCandidates = 48;
const maxCached = 48;

export function parseProjectOverride(text: string): ProjectCheckOverride {
  const parsed = document(text, 'Project profile');
  if (parsed.yaml === null)
    throw new Error('The Project profile needs YAML frontmatter.');
  return projectCheckOverrideSchema.parse(parsed.fields);
}

function moduleHint(config: ProjectCheckOverride) {
  const target = config.checks?.tests;
  const implied =
    target?.runner === 'gradle-wrapper'
      ? target.task.replace(/^:/, '').split(':').slice(0, -1).join('/')
      : '';
  return config.module ?? (implied || '.');
}

async function actionsFiles(
  root: string,
  signal: AbortSignal,
): Promise<string[]> {
  const path = join(root, '.github', 'workflows');
  try {
    if (pathKey(await realpath(path)) !== pathKey(path)) return [];
    const files = [];
    const directory = await opendir(path);
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (entry.isFile() && /^[\w.-]+\.ya?ml$/i.test(entry.name))
        files.push('.github/workflows/' + entry.name);
      if (files.length >= 24) break;
    }
    return files.sort();
  } catch (error) {
    if (!missing(error)) throw error;
    return [];
  }
}

const opaqueInput =
  /(?:\blockb?$|lock[.-]|gradle-wrapper\.jar$|shrinkwrap\.json$)/;
async function inventoryFile(root: string, name: string, signal: AbortSignal) {
  if (!opaqueInput.test(name)) return readCheckInput(root, name, signal);
  const path = join(root, name);
  try {
    if (pathKey(await realpath(path)) !== pathKey(path)) return null;
    const info = await lstat(path, { bigint: true });
    return info.isFile()
      ? {
          path,
          text: '',
          contentHash: hashText(
            [info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'),
          ),
        }
      : null;
  } catch (error) {
    if (!missing(error)) throw error;
    return null;
  }
}

const stackDetectors = {
  typescript: {
    matches: (context: DetectorContext) =>
      context.files.has(posix.join(context.module, 'package.json')),
    detect: detectPackageScripts,
  },
  kotlin: {
    matches: (context: DetectorContext) =>
      gradleBuildFile(context) !== undefined,
    detect: detectGradle,
  },
} satisfies Record<
  CheckStack,
  {
    matches: (context: DetectorContext) => boolean;
    detect: CheckDetector;
  }
>;

function stackFor(context: DetectorContext): CheckProjectProfile['stack'] {
  if (context.override.stack) return context.override.stack;
  const stacks = checkStackSchema.options.filter(stack =>
    stackDetectors[stack].matches(context),
  );
  return stacks.length > 1 ? 'ambiguous' : (stacks[0] ?? 'unknown');
}

function mapping(context: DetectorContext): CandidateInput[] {
  const entry = context.override.checks?.tests;
  const file = context.files.get(projectProfilePath);
  if (entry?.runner !== 'command' || !file) return [];
  const target = parseCheckCommand(entry.command);
  return target
    ? [
        {
          target,
          coverage: 'tests',
          directory: context.module,
          source: sourceAt(
            context.root,
            file,
            'checks.tests from ' +
              entry.source.file +
              ' / ' +
              entry.source.location,
          ),
          availability: 'available',
          reason: null,
        },
      ]
    : [];
}

const matchesTarget = (
  value: CheckCandidate,
  target: NonNullable<ProjectCheckOverride['checks']>['tests'],
) => {
  if (!target) return false;
  if (target.runner === 'command')
    return value.source.file === projectProfilePath;
  if ('tool' in value.target) return false;
  if (target.runner === 'package-script')
    return (
      value.target.runner === target.runner &&
      value.target.script === target.script
    );
  return (
    value.target.runner === target.runner &&
    (target.task.includes(':')
      ? value.target.task.replace(/^:/, '') === target.task.replace(/^:/, '')
      : value.target.task.split(':').at(-1) === target.task)
  );
};

export function rankedCandidates(
  scan: ProjectScan,
  definition: ResolvedStep,
): CheckCandidate[] {
  const stack = checkStackSchema.safeParse(scan.profile.stack);
  const preferred = stack.success
    ? definition.preferred?.[stack.data]
    : undefined;
  const configured = scan.context.override.checks?.tests;
  const score = (entry: CheckCandidate) =>
    matchesTarget(entry, configured)
      ? 0
      : matchesTarget(entry, preferred)
        ? 1
        : entry.availability === 'available'
          ? 2
          : 3;
  return scan.profile.candidates
    .filter(entry => entry.intent === definition.intent)
    .sort((a, b) => score(a) - score(b));
}

async function installedGradle(
  context: DetectorContext,
  environment: NodeJS.ProcessEnv,
) {
  const props = context.files.get('gradle/wrapper/gradle-wrapper.properties');
  if (!props) return environment.NESVO_TEST_MODE === '1' ? 'fixture' : null;
  const fields = Object.fromEntries(
    props.text.split(/\r?\n/).flatMap(line => {
      const value = /^([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(line);
      return value ? [[value[1]!, value[2]!.replaceAll('\\:', ':')]] : [];
    }),
  );
  const url = fields.distributionUrl ?? '';
  const archive = /\/((gradle-[0-9][\w.\-]*)-(?:bin|all))\.zip$/.exec(url);
  if (
    !archive ||
    !/^https:\/\//.test(url) ||
    (fields.distributionBase ?? 'GRADLE_USER_HOME') !== 'GRADLE_USER_HOME' ||
    (fields.distributionPath ?? 'wrapper/dists') !== 'wrapper/dists'
  )
    return null;
  const key = BigInt(
    '0x' + createHash('md5').update(url).digest('hex'),
  ).toString(36);
  const gradleHome = environment.GRADLE_USER_HOME ?? join(homedir(), '.gradle');
  if (!isAbsolute(gradleHome)) return null;
  const cache = join(gradleHome, 'wrapper', 'dists', archive[1]!, key);
  const marker = await lstat(join(cache, archive[1]! + '.zip.ok'), {
    bigint: true,
  }).catch(() => null);
  const executable = await launcher(
    windows ? './gradle.bat' : './gradle',
    join(cache, archive[2]!, 'bin'),
    environment,
  );
  return marker?.isFile() && executable
    ? executable.stamp + ':' + marker.mtimeNs
    : null;
}

export async function projectCommand(
  scan: ProjectScan,
  entry: CheckCandidate,
  environment: NodeJS.ProcessEnv,
) {
  const invocation = commandFor(entry.target, scan.context);
  if (!invocation) return null;
  const gradle =
    'runner' in entry.target && entry.target.runner === 'gradle-wrapper';
  const cwd = join(scan.context.root, gradle ? '.' : entry.directory);
  const distribution = gradle
    ? await installedGradle(scan.context, environment)
    : null;
  if (gradle && !distribution) return null;
  const found = await launcher(invocation.tool, cwd, environment);
  const java = gradle
    ? await launcher(
        'java',
        cwd,
        environment.JAVA_HOME && isAbsolute(environment.JAVA_HOME)
          ? { Path: join(environment.JAVA_HOME, 'bin') }
          : environment,
      )
    : null;
  if (!found || (gradle && !java && distribution !== 'fixture')) return null;
  return {
    cwd,
    found,
    invocation,
    stamp: hashText(found.stamp + (java?.stamp ?? '') + (distribution ?? '')),
  };
}

export type ProjectScan = {
  context: DetectorContext;
  profile: CheckProjectProfile;
  tools: Map<string, string>;
};

const detectors = [
  mapping,
  ...checkStackSchema.options.map(stack => stackDetectors[stack].detect),
  detectUniversal,
];

export class ProjectChecks {
  private readonly cache = new Map<
    string,
    {
      inputHash: string;
      candidates: CheckCandidate[];
      latest?: ProjectScan;
    }
  >();

  async read(
    directory: string,
    steps: readonly ResolvedStep[],
    environment: NodeJS.ProcessEnv,
    caller: AbortSignal,
    mappingApproved?: (hash: string) => boolean,
  ): Promise<ProjectScan> {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(8000)]);
    const root = await realpath(directory);
    if (pathKey(root) !== pathKey(directory))
      throw new Error('The check checkout changed location.');
    const files = new Map<string, DefinitionFile>();
    const config = await readCheckInput(root, projectProfilePath, signal);
    const override = config ? parseProjectOverride(config.text) : {};
    if (config) files.set(projectProfilePath, config);
    const module = moduleHint(override);
    const modulePath = join(root, module);
    if (
      !inside(root, modulePath) ||
      pathKey(await realpath(modulePath)) !== pathKey(modulePath)
    )
      throw new Error(
        'The Project module must be a folder inside the checkout.',
      );
    if (!(await lstat(modulePath)).isDirectory())
      throw new Error('The Project module is not a directory.');
    const names = new Set([
      ...packageInputs,
      ...gradleInputs,
      'gradle/wrapper/gradle-wrapper.jar',
      ...universalInputs,
      ...(await actionsFiles(root, signal)),
      ...[...packageInputs, ...gradleInputs, ...universalInputs].map(name =>
        posix.join(module, name),
      ),
    ]);
    const inputs = [...names];
    for (let index = 0; index < inputs.length; index += 8) {
      signal.throwIfAborted();
      const batch = inputs.slice(index, index + 8);
      const read = await Promise.all(
        batch.map(async name => {
          try {
            return await inventoryFile(root, name, signal);
          } catch {
            signal.throwIfAborted();
            return null;
          }
        }),
      );
      batch.forEach((name, index) => {
        const file = read[index];
        if (file) files.set(name, file);
      });
    }
    const preferences = steps.filter(step => step.type === 'check');
    const context = { root, module, files, preferences, override };
    const key = hashText(
      JSON.stringify([
        pathKey(root),
        module,
        preferences.map(step => step.preferred),
      ]),
    );
    const trustedMapping =
      config && mappingApproved?.(config.contentHash) === true;
    const inputHash = hashText(
      JSON.stringify([
        trustedMapping,
        [...files].map(([name, file]) => [name, file.contentHash]),
      ]),
    );
    let cached = this.cache.get(key);
    const stack = stackFor(context);
    if (cached?.inputHash !== inputHash) {
      const candidates = detectors
        .flatMap(detector => detector(context))
        .flatMap(input => {
          const value = candidate(input);
          return value
            ? [
                value.source.file === projectProfilePath && !trustedMapping
                  ? {
                      ...value,
                      availability: 'unverified' as const,
                      reason:
                        'This Project command needs operator approval on this host.',
                    }
                  : value,
              ]
            : [];
        });
      const recognized = checkStackSchema.safeParse(stack);
      const allowed = candidates.filter(
        entry =>
          'tool' in entry.target ||
          (recognized.success &&
            entry.target.runner ===
              checkStackDetectors[recognized.data].runner),
      );
      cached = {
        inputHash,
        candidates: [
          ...new Map(allowed.map(entry => [entry.id, entry])).values(),
        ].slice(0, maxCandidates),
      };
    }
    const tools = new Map<string, string>();
    const profile = checkProjectProfileSchema.parse({
      stack,
      directory: module,
      hash: inputHash,
      overrideHash: config?.contentHash ?? null,
      issue:
        stack === 'ambiguous'
          ? 'Choose the stack and module in .agents/project.md.'
          : null,
      candidates: cached.candidates,
    });
    const scan: ProjectScan = { context, profile, tools };
    const candidates = await Promise.all(
      profile.candidates.map(async entry => {
        if (entry.availability !== 'available') return entry;
        const command = await projectCommand(scan, entry, environment);
        if (!command)
          return {
            ...entry,
            availability: 'missing' as const,
            reason:
              'runner' in entry.target &&
              entry.target.runner === 'gradle-wrapper'
                ? 'The Gradle wrapper, its cached distribution or Java is unavailable.'
                : 'The check launcher or required toolchain is unavailable.',
          };
        tools.set(entry.id, command.stamp);
        return entry;
      }),
    );
    profile.hash = hashText(JSON.stringify([inputHash, [...tools].sort()]));
    profile.candidates = candidates;
    if (cached.latest?.profile.hash === profile.hash) return cached.latest;
    cached.latest = scan;
    this.cache.delete(key);
    this.cache.set(key, cached);
    if (this.cache.size > maxCached)
      this.cache.delete(this.cache.keys().next().value!);
    return scan;
  }
}

export const projectChecks = new ProjectChecks();

export function emptyProjectProfile(): CheckProjectProfile {
  return {
    stack: 'unknown',
    directory: '.',
    hash: hashText('unavailable'),
    overrideHash: null,
    issue:
      'The Project profile could not be read. Check the module, input files and .agents/project.md.',
    candidates: [],
  };
}

export function projectProfileWithMapping(
  current: DefinitionFile | null,
  command: string,
  source: CheckCandidate['source'],
): string {
  const parsed = current ? document(current.text, 'Project profile') : null;
  const fields = current ? parseProjectOverride(current.text) : {};
  const checks = {
    ...fields.checks,
    tests: { runner: 'command', command, source },
  };
  const updated = { ...fields, checks };
  projectCheckOverrideSchema.parse(updated);
  const yaml = [
    ...(updated.stack ? ['stack: ' + updated.stack] : []),
    ...(updated.module ? ['module: ' + updated.module] : []),
    'checks:',
    '  tests: ' + JSON.stringify(checks.tests),
  ].join('\n');
  yamlMapping(yaml);
  return '---\n' + yaml + '\n---\n' + (parsed?.body ?? '');
}

export const invocationText = (invocation: Invocation) =>
  [invocation.tool, ...invocation.args].join(' ');
