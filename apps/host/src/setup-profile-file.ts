import {
  setupProfileCollectionKeys,
  setupProfileDocumentSchema,
  type SetupProfileDeclaration,
  type SetupProfileDocument,
  type SetupProfileReview,
  type SetupProfileRecipe,
} from '@nesvo/contracts';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { loadBoundedYaml, YamlLimitError } from './skills/yaml-limits';
import { dump } from 'js-yaml';
import { configurationText } from './workflows/configuration-changes';

const maxBytes = 64 * 1024;
type Layer = SetupProfileReview['files'][number]['layer'];
type Issue = SetupProfileReview['issues'][number];
type Route = SetupProfileReview['routing']['effective'];
type Entry = { id: string; disabled?: true; name?: string };
type InboxRuleEntry = NonNullable<
  NonNullable<SetupProfileDocument['inbox']>['rules']
>[number];
export type SetupInboxRuleScope = Exclude<
  InboxRuleEntry,
  { disabled: true }
>['scope'];
export type SetupInboxRule = {
  value: InboxRuleEntry;
  source: string;
  digest: string;
  maskedScope?: SetupInboxRuleScope;
};

export class SetupProfileFileError extends Error {
  constructor(
    readonly status: 'absent' | 'invalid' | 'unsupported',
    readonly issues: Issue[],
  ) {
    super(issues[0]?.reason ?? 'The profile is unavailable.');
  }
}

export function defaultSetupProfilePath(directory: string | undefined) {
  if (process.env.NESVO_PROFILE_PATH)
    return resolve(process.env.NESVO_PROFILE_PATH);
  if (
    directory &&
    (process.env.NESVO_TEST_MODE === '1' ||
      process.env.NESVO_ISOLATED_PROFILE === '1')
  )
    return join(directory, 'profile.yaml');
  return join(homedir(), '.nesvo', 'profile.yaml');
}

function sha(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function fileError(
  file: string,
  reason: string,
  field = '',
  status: SetupProfileFileError['status'] = 'invalid',
): never {
  throw new SetupProfileFileError(status, [{ file, field, reason }]);
}

type Replacement = { path: string; text: string };

function readLayer(
  root: string,
  file: string,
  layer: Layer,
  replacement?: Replacement,
) {
  const path = relative(root, file);
  if (isAbsolute(path) || path === '..' || path.startsWith('..' + sep))
    fileError(file, 'Keep the profile and included files inside its root.');
  let cursor = root;
  for (const component of path.split(sep)) {
    cursor = join(cursor, component);
    const item = lstatSync(cursor, { throwIfNoEntry: false });
    if (!item)
      fileError(
        file,
        layer === 'entry'
          ? 'No profile was found at this path.'
          : 'An included file could not be found.',
        '',
        layer === 'entry' ? 'absent' : 'invalid',
      );
    if (item.isSymbolicLink())
      fileError(file, 'Use a regular profile file without symbolic links.');
  }
  const initial = lstatSync(file);
  if (
    !initial.isFile() ||
    initial.size > maxBytes ||
    relative(realpathSync(file), file)
  )
    fileError(file, 'Use a regular YAML file of at most 64 KiB.');
  const handle = openSync(
    file,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  let bytes: Buffer;
  try {
    const opened = fstatSync(handle);
    if (
      !opened.isFile() ||
      opened.ino !== initial.ino ||
      opened.dev !== initial.dev
    )
      fileError(file, 'The file identity changed while it was read.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(
        handle,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (!count) break;
      offset += count;
    }
    const current = lstatSync(file);
    if (
      offset > maxBytes ||
      current.size !== offset ||
      current.ino !== initial.ino ||
      current.dev !== initial.dev ||
      current.mtimeMs !== initial.mtimeMs ||
      relative(realpathSync(file), file)
    )
      fileError(
        file,
        'The profile changed while it was read. Refresh the preview.',
      );
    bytes = buffer.subarray(0, offset);
  } finally {
    closeSync(handle);
  }
  let data: unknown;
  let text: string;
  try {
    text =
      replacement?.path === file
        ? replacement.text
        : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            bytes,
          );
    data = loadBoundedYaml(text);
  } catch (error) {
    if (error instanceof YamlLimitError) fileError(file, error.message);
    const line = (error as { mark?: { line?: number } }).mark?.line;
    throw new SetupProfileFileError('invalid', [
      {
        file,
        field: '',
        line: line === undefined ? undefined : line + 1,
        reason: 'The YAML is malformed or contains duplicate mapping keys.',
      },
    ]);
  }
  if (
    data &&
    typeof data === 'object' &&
    'version' in data &&
    typeof data.version === 'number' &&
    data.version !== 1
  )
    fileError(
      file,
      'This profile version is unsupported.',
      'version',
      'unsupported',
    );
  const result = setupProfileDocumentSchema.safeParse(data);
  if (!result.success) {
    throw new SetupProfileFileError(
      'invalid',
      result.error.issues.slice(0, 20).map(issue => ({
        file,
        field: issue.path.join('.').slice(0, 140),
        reason:
          issue.code === 'unrecognized_keys'
            ? 'Remove fields outside the profile schema.'
            : issue.code === 'custom' &&
                issue.message === 'Duplicate ID in this layer.'
              ? issue.message
              : 'Check the field type, supported value and limits.',
      })),
    );
  }
  if (layer !== 'entry' && result.data.include)
    fileError(file, 'Only the entry file can include fragments.', 'include');
  if (
    configurationText(text.replace(/\r\n?/g, '\n')) !==
    text.replace(/\r\n?/g, '\n')
  )
    fileError(
      file,
      'Remove credential-like text and use typed references in supported fields.',
    );
  if (Buffer.byteLength(text) > maxBytes)
    fileError(file, 'Use a profile file of at most 64 KiB.');
  return {
    layer,
    path: file,
    revision: replacement?.path === file ? sha(text) : sha(bytes),
    value: result.data,
    text,
  };
}

export type LoadedSetupProfile = {
  path: string;
  revision: string;
  files: SetupProfileReview['files'];
  declarations: SetupProfileDeclaration[];
  route: Route | null;
  routeSource: string | null;
  routeWritePath: string;
  sessionControl?: SetupProfileDocument['sessionControl'];
  inboxRules?: SetupInboxRule[];
  usageLimits?: SetupProfileDocument['limits'];
  portable?: SetupProfileDocument;
};

function profileLayers(file: string, replacement?: Replacement) {
  const path = resolve(file);
  const root = dirname(path);
  try {
    const folder = lstatSync(root, { throwIfNoEntry: false });
    if (!folder)
      fileError(path, 'No profile was found at this path.', '', 'absent');
    if (
      !folder.isDirectory() ||
      folder.isSymbolicLink() ||
      relative(realpathSync(root), root)
    )
      fileError(path, 'Choose a profile root without symbolic links.');
    const entry = readLayer(root, path, 'entry', replacement);
    const { shared, machine } = entry.value.include ?? {};
    const layers = [];
    const paths: string[] = [path];
    for (const [layer, name] of [
      ['shared', shared],
      ['machine', machine],
    ] as const) {
      if (!name) continue;
      const candidate = resolve(root, name);
      if (paths.some(existing => !relative(existing, candidate)))
        fileError(
          path,
          'Include each fragment once and keep the entry file out of its includes.',
          'include.' + layer,
        );
      layers.push(readLayer(root, candidate, layer, replacement));
      paths.push(candidate);
    }
    layers.push(entry);
    return { path, layers };
  } catch (error) {
    if (error instanceof SetupProfileFileError) throw error;
    fileError(path, 'The profile or an include could not be read.');
  }
}

type ProfileLayer = ReturnType<typeof readLayer>;

export function readSetupProfile(
  file: string,
  replacement?: Replacement,
): LoadedSetupProfile {
  const { path, layers } = profileLayers(file, replacement);
  return mergeProfile(path, layers);
}

export function readSetupRouteSource(file: string, shared: boolean) {
  const { path, layers } = profileLayers(file);
  const profile = mergeProfile(path, layers);
  const source = shared
    ? layers.find(layer => layer.layer === 'shared')
    : layers.find(layer => layer.path === profile.routeWritePath);
  if (!source)
    fileError(path, 'The profile has no shared fragment.', 'include.shared');
  return { profile, source, definition: null };
}

export function readSetupFragment(file: string, layer: Layer) {
  const { path, layers } = profileLayers(file);
  const source = layers.find(item => item.layer === layer);
  if (!source) fileError(path, 'This profile layer is unavailable.');
  return { profile: mergeProfile(path, layers), source, definition: null };
}

export function readSetupRecipeSource(file: string, id: string) {
  const { path, layers } = profileLayers(file);
  const profile = mergeProfile(path, layers);
  const active = layers.findLast(layer =>
    layer.value.recipes?.some(recipe => recipe.id === id),
  );
  const value = active?.value.recipes?.find(recipe => recipe.id === id);
  const source =
    active?.layer === 'entry'
      ? active
      : (layers.find(layer => layer.layer === 'machine') ?? layers.at(-1)!);
  return {
    profile,
    source,
    definition: value && !('disabled' in value) ? value : null,
  };
}

export function profileWithRecipe(
  document: SetupProfileDocument,
  recipe: SetupProfileRecipe,
) {
  return dump(
    {
      ...document,
      recipes: [
        ...(document.recipes ?? []).filter(
          existing => existing.id !== recipe.id,
        ),
        recipe,
      ],
    },
    { lineWidth: -1, noRefs: true },
  );
}

export function profileWithRoute(document: SetupProfileDocument, route: Route) {
  return dump(
    { ...document, inbox: { ...document.inbox, defaultRoute: route } },
    { lineWidth: -1, noRefs: true },
  );
}

export function replaceSetupProfileFile(
  replacement: Replacement,
  recheck: () => void,
) {
  const root = dirname(replacement.path);
  const temporary = join(root, '.nesvo-profile-' + randomUUID() + '.tmp');
  let created = false;
  try {
    const handle = openSync(temporary, 'wx', 0o600);
    created = true;
    try {
      writeFileSync(handle, replacement.text, 'utf8');
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    recheck();
    renameSync(temporary, replacement.path);
    created = false;
    if (process.platform !== 'win32') {
      const directory = openSync(root, constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    if (created) unlinkSync(temporary);
  }
}

export function writeNewSetupProfile(
  file: string,
  document: SetupProfileDocument,
  defaultPath: string,
) {
  if (!isAbsolute(file) || !/\.ya?ml$/iu.test(file))
    fileError(file, 'Use an absolute path ending in .yaml or .yml.');
  const path = resolve(file);
  const root = dirname(path);
  if (path === defaultPath && !lstatSync(root, { throwIfNoEntry: false }))
    mkdirSync(root, { mode: 0o700 });
  const directory = lstatSync(root, { throwIfNoEntry: false });
  if (
    !directory?.isDirectory() ||
    directory.isSymbolicLink() ||
    relative(realpathSync(root), root)
  )
    fileError(file, 'Choose a local profile directory without symbolic links.');
  try {
    writeFileSync(path, dump(document, { lineWidth: -1, noRefs: true }), {
      flag: 'wx',
      mode: 0o600,
      flush: true,
    });
  } catch (error) {
    fileError(
      file,
      (error as { code?: string }).code === 'EEXIST'
        ? 'Choose a new file. A profile already exists at this path.'
        : 'The profile could not be created.',
    );
  }
  return path;
}

function mergeProfile(
  path: string,
  layers: ProfileLayer[],
): LoadedSetupProfile {
  const merged = new Map<
    string,
    { value: Entry; source: string; field: string }
  >();
  const overrides = new Map<string, SetupProfileDeclaration>();
  let route: Route | null = null;
  let routeSource: string | null = null;
  let sessionControl: SetupProfileDocument['sessionControl'];
  const inboxRules = new Map<string, SetupInboxRule>();
  const usageLimits = new Map<
    string,
    NonNullable<SetupProfileDocument['limits']>[number]
  >();
  const add = (layer: ProfileLayer, field: string, entries: Entry[] = []) =>
    entries.forEach((value, index) =>
      merged.set(field + '/' + value.id, {
        value,
        source: layer.path,
        field: field + '.' + index,
      }),
    );
  for (const layer of layers) {
    const value: SetupProfileDocument = layer.value;
    for (const key of setupProfileCollectionKeys) add(layer, key, value[key]);
    add(layer, 'inbox.rules', value.inbox?.rules);
    for (const rule of value.inbox?.rules ?? []) {
      const previous = inboxRules.get(rule.id);
      inboxRules.set(rule.id, {
        value: rule,
        source: layer.path,
        digest: sha(JSON.stringify(rule)),
        ...('disabled' in rule && previous
          ? { maskedScope: setupInboxRuleScope(previous) }
          : {}),
      });
    }
    for (const limit of value.limits ?? []) usageLimits.set(limit.id, limit);
    if (value.inbox?.defaultRoute !== undefined) {
      route = value.inbox.defaultRoute;
      routeSource = layer.path;
      overrides.set('inbox.defaultRoute', {
        key: 'inbox.defaultRoute',
        label: 'Default Inbox route',
        field: 'inbox.defaultRoute',
        source: layer.path,
        revision: sha(JSON.stringify(route)),
        state: 'ordinary',
        preview: route,
      });
    }
    if (value.sessionControl)
      sessionControl = { ...sessionControl, ...value.sessionControl };
    for (const [key, content] of Object.entries(value.sessionControl ?? {})) {
      overrides.set('sessionControl.' + key, {
        key: 'sessionControl.' + key,
        label:
          {
            maxSessions: 'Coordinator group limit',
            maxDepth: 'Coordinator nesting limit',
            workers: 'Worker permissions',
            wake: 'Coordinator wake',
          }[key] ?? 'Session control',
        field: 'sessionControl.' + key,
        source: layer.path,
        revision: sha(JSON.stringify(content)),
        state:
          key === 'wake' || (key === 'workers' && content === 'ask')
            ? 'pending'
            : 'ordinary',
        preview: String(content),
      });
    }
  }
  for (const [key, entry] of merged) {
    if (
      key.startsWith('recipes/') &&
      !entry.value.disabled &&
      'provider' in entry.value &&
      typeof entry.value.provider === 'string'
    ) {
      const provider = merged.get('worktrees/' + entry.value.provider);
      if (!provider || provider.value.disabled)
        fileError(
          entry.source,
          'Choose an available worktree provider declared in this profile.',
          entry.field + '.provider',
        );
    }
    const value = entry.value;
    const preview =
      'template' in value && typeof value.template === 'string'
        ? value.template
        : 'threshold' in value && 'effect' in value
          ? `${value.effect} at ${value.threshold}%`
          : 'schedule' in value && 'timeZone' in value
            ? `${value.schedule} · ${value.timeZone} · Paused pending review`
            : undefined;
    const rule = key.startsWith('inbox.rules/')
      ? inboxRules.get(value.id)?.value
      : undefined;
    const ordinary =
      key.startsWith('branches/') ||
      (key.startsWith('limits/') &&
        'effect' in value &&
        value.effect === 'warn' &&
        (!('account' in value) || value.account === 'default')) ||
      (rule && !('disabled' in rule));
    overrides.set(key, {
      key,
      source: entry.source,
      field: entry.field,
      label: (entry.value.name ?? entry.value.id).slice(0, 120),
      revision: sha(JSON.stringify(entry.value)),
      state: value.disabled
        ? 'masked'
        : ordinary || key.startsWith('rituals/')
          ? 'ordinary'
          : 'pending',
      preview: configurationText(preview ?? '').slice(0, 300) || undefined,
    });
  }
  const files = layers.map(({ layer, path, revision }) => ({
    layer,
    path,
    revision,
  }));
  const collection = (key: string) =>
    [...merged.entries()]
      .filter(([path]) => path.startsWith(key + '/'))
      .map(([, entry]) => entry.value);
  const settings: SetupProfileDocument = setupProfileDocumentSchema.parse({
    version: 1,
    branches: collection('branches'),
    recipes: collection('recipes').filter(entry => !('provider' in entry)),
    automations: collection('automations'),
    rituals: collection('rituals'),
    limits: [...usageLimits.values()],
    sessionControl,
    inbox: {
      defaultRoute: route ?? undefined,
      rules: [...inboxRules.values()].map(entry => entry.value),
    },
  });
  return {
    path,
    files,
    declarations: [...overrides.values()],
    sessionControl,
    inboxRules: [...inboxRules.values()],
    usageLimits: [...usageLimits.values()],
    portable: settings,
    route,
    routeSource,
    routeWritePath:
      routeSource === path
        ? path
        : (layers.find(layer => layer.layer === 'machine')?.path ?? path),
    revision: sha(
      JSON.stringify(
        files.map(({ layer, path: source, revision }) => [
          layer,
          relative(dirname(path), source) || basename(path),
          revision,
        ]),
      ),
    ),
  };
}

export function setupInboxRuleScope(
  entry: SetupInboxRule,
): SetupInboxRuleScope {
  return 'disabled' in entry.value
    ? (entry.maskedScope ?? { kind: 'global' })
    : entry.value.scope;
}
