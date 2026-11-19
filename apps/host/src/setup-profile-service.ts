import {
  inboxSettingsSchema,
  setupProfileSessionControlSchema,
  setupProfileLayerSchema,
  setupProfileReviewSchema,
  type ConfigurationTarget,
  type ConfigurationValue,
  type SetupProfileInput,
  type SetupProfileDeclaration,
  type SetupProfileReview,
  type ProviderUsage,
} from '@nesvo/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import {
  configurationText,
  ConfigurationRefusal,
  type ConfigurationChanges,
  type ConfigurationPrincipal,
  type ConfigurationWriter,
} from './workflows/configuration-changes';
import type { ConfigurationSnapshot } from './workflows/assistant-change-store';
import {
  defaultSetupProfilePath,
  profileWithRoute,
  profileWithRecipe,
  readSetupProfile,
  readSetupRouteSource,
  readSetupRecipeSource,
  readSetupFragment,
  replaceSetupProfileFile,
  setupInboxRuleScope,
  writeNewSetupProfile,
  SetupProfileFileError,
  type LoadedSetupProfile,
  type SetupInboxRule,
} from './setup-profile-file';
import {
  SetupProfileReviewQueue,
  type SetupReviewInspection,
} from './setup-profile-review-queue';

const target = {
  area: 'setup-profile',
  key: 'selection',
} as const satisfies ConfigurationTarget;
const routeSchema = inboxSettingsSchema.shape.defaultRoute;
type Routing = SetupProfileReview['routing']['effective'];
type SessionLimits = Pick<
  NonNullable<LoadedSetupProfile['sessionControl']>,
  'maxSessions' | 'maxDepth' | 'workers'
>;
type Selection = {
  profile: LoadedSetupProfile;
  managed: boolean;
  sessionLimits?: SessionLimits;
  retiredInboxRules?: SetupInboxRule[];
};
type RouteEditorState = {
  path: string;
  text: string;
  selection?: Pick<
    Selection,
    'managed' | 'sessionLimits' | 'retiredInboxRules'
  >;
};

const allowOnlyProfile = (verb: string, requested: ConfigurationTarget) => {
  if (verb !== 'apply' || requested.area !== 'setup-profile')
    throw new ConfigurationRefusal(
      'unauthorized',
      'This action only applies a verified profile.',
    );
};
const desktop: ConfigurationPrincipal = {
  source: { kind: 'owner' },
  authorize: allowOnlyProfile,
};
const drift: ConfigurationPrincipal = {
  source: { kind: 'system', source: 'setup-profile' },
  authorize: allowOnlyProfile,
};

export function installSetupProfile(database: DatabaseSync) {
  database.exec(
    'CREATE TABLE IF NOT EXISTS setup_profile (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, document TEXT CHECK (json_valid(document)), route TEXT, managed INTEGER NOT NULL)',
  );
  database.exec(`
    CREATE TABLE IF NOT EXISTS setup_automation_bindings (
      id TEXT PRIMARY KEY,
      declaration TEXT NOT NULL,
      profile TEXT NOT NULL,
      revision TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      retired INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 0
    )
  `);
}

function tableExists(database: DatabaseSync | undefined, name: string) {
  return !!database
    ?.prepare('SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?')
    .get('table', name);
}

export function managedSetupRoute(database: DatabaseSync): Routing | null {
  const stored = database
    .prepare('SELECT route, managed FROM setup_profile WHERE id = 1')
    .get();
  return stored?.managed
    ? routeSchema.catch('inbox').parse(stored.route)
    : null;
}

function activeProfileSelection(database: DatabaseSync): Selection | null {
  if (!tableExists(database, 'setup_profile')) return null;
  const row = database
    .prepare('SELECT document FROM setup_profile WHERE id = 1')
    .get();
  return typeof row?.document === 'string' ? JSON.parse(row.document) : null;
}

export function activeSetupProfile(database: DatabaseSync) {
  return activeProfileSelection(database)?.profile;
}

export function managedSessionLimits(database: DatabaseSync): SessionLimits {
  const selection = activeProfileSelection(database);
  return (
    setupProfileSessionControlSchema.safeParse(selection?.sessionLimits).data ??
    {}
  );
}

export function managedInboxRules(database: DatabaseSync) {
  const selection = activeProfileSelection(database);
  return [
    ...(selection?.profile.inboxRules ?? []),
    ...(selection?.retiredInboxRules ?? []),
  ];
}

function retainInboxRuleOwnership(
  previous: Selection | null | undefined,
  desired: LoadedSetupProfile,
) {
  const key = (entry: SetupInboxRule) =>
    JSON.stringify([entry.value.id, setupInboxRuleScope(entry)]);
  const active = new Set((desired.inboxRules ?? []).map(key));
  const retired = new Map<string, SetupInboxRule>();
  for (const entry of [
    ...(previous?.profile.inboxRules ?? []),
    ...(previous?.retiredInboxRules ?? []),
  ]) {
    if (active.has(key(entry))) continue;
    retired.set(key(entry), {
      ...entry,
      value: { id: entry.value.id, disabled: true },
      maskedScope: setupInboxRuleScope(entry),
    });
  }
  if (retired.size > 192)
    throw new ConfigurationRefusal(
      'invalid-request',
      'This profile has reached the limit for retired Inbox rule bindings.',
    );
  return [...retired.values()];
}

export function withProfileUsageWarning(
  database: DatabaseSync,
  usage: ProviderUsage,
  profileId: string | null | undefined,
): ProviderUsage {
  if (profileId || usage.status !== 'ready') return usage;
  const limits = activeProfileSelection(database)?.profile.usageLimits ?? [];
  const warnings = limits.flatMap(limit => {
    if (
      'disabled' in limit ||
      limit.provider !== usage.provider ||
      limit.effect !== 'warn' ||
      (limit.account && limit.account !== 'default')
    )
      return [];
    const window = usage.windows.find(item => item.id === limit.window);
    if (
      !window ||
      window.usedPercent < limit.threshold ||
      (window.resetsAt && Date.parse(window.resetsAt) <= Date.now())
    )
      return [];
    return [
      `${window.label} reached the profile warning threshold of ${limit.threshold}%.`,
    ];
  });
  if (!warnings.length) return usage;
  return {
    ...usage,
    detail: [...new Set([...warnings, ...(usage.detail ? [usage.detail] : [])])]
      .join(' ')
      .slice(0, 1000),
  };
}

function profileChanges(
  current: SetupProfileDeclaration[],
  desired: SetupProfileDeclaration[],
) {
  const previous = new Map(current.map(item => [item.key, item]));
  const next = new Map(desired.map(item => [item.key, item]));
  const summary = (item: SetupProfileDeclaration | undefined) =>
    item?.state === 'masked'
      ? 'Disabled'
      : (item?.preview ??
        (item?.state === 'pending'
          ? 'Awaiting local review'
          : (item?.label ?? null)));
  return [...new Set([...previous.keys(), ...next.keys()])].map(key => {
    const before = previous.get(key);
    const after = next.get(key);
    return {
      key,
      label: (after ?? before)!.label,
      before: summary(before),
      after: summary(after),
      effect: !before
        ? ('add' as const)
        : !after
          ? ('remove' as const)
          : before.revision === after.revision
            ? ('keep' as const)
            : ('update' as const),
    };
  });
}

function restrictSessionLimits(
  previous: SessionLimits | undefined,
  desired: LoadedSetupProfile['sessionControl'],
): SessionLimits {
  const maxSessions = Math.min(
    previous?.maxSessions ?? 8,
    desired?.maxSessions ?? 8,
  );
  const maxDepth = Math.min(previous?.maxDepth ?? 2, desired?.maxDepth ?? 2);
  const readOnly =
    previous?.workers === 'read-only' || desired?.workers === 'read-only';
  return {
    maxSessions:
      previous?.maxSessions !== undefined || desired?.maxSessions !== undefined
        ? maxSessions
        : undefined,
    maxDepth:
      previous?.maxDepth !== undefined || desired?.maxDepth !== undefined
        ? maxDepth
        : undefined,
    workers: readOnly ? 'read-only' : undefined,
  };
}

function manualRoute(database?: DatabaseSync) {
  const stored = tableExists(database, 'inbox_settings')
    ? database
        ?.prepare("SELECT * FROM inbox_settings WHERE key = 'default-route'")
        .get()
    : undefined;
  return {
    value: routeSchema.catch('inbox').parse(stored?.value),
    revision: Number(stored?.revision ?? 0),
  };
}

function selectionText(selection: Selection | null) {
  if (!selection) return 'Manual setup';
  const { profile, managed, sessionLimits } = selection;
  return [
    'Profile ' + basename(profile.path),
    ...(managed ? ['Default Inbox route: ' + (profile.route ?? 'inbox')] : []),
    ...Object.entries(sessionLimits ?? {}).map(
      ([key, value]) => `Session control · ${key} · ${value}`,
    ),
    ...profile.declarations
      .filter(item => item.state === 'pending' || item.state === 'masked')
      .map(
        item => `${item.label} · ${item.state} · ${item.revision.slice(0, 12)}`,
      ),
  ]
    .map(configurationText)
    .join('\n');
}

export class SetupProfileService {
  private readonly defaultFile: string;
  private readonly reviews?: SetupProfileReviewQueue;

  constructor(
    directory: string | undefined,
    private readonly database?: DatabaseSync,
    private readonly changes?: ConfigurationChanges,
    inspectReview?: SetupReviewInspection,
    private readonly projectProfile?: (
      profile: LoadedSetupProfile | null,
    ) => void,
  ) {
    this.defaultFile = defaultSetupProfilePath(directory);
    changes?.register('setup-profile', this.writer());
    changes?.register('setup-profile-file', this.fileWriter());
    if (changes)
      this.reviews = new SetupProfileReviewQueue(
        changes,
        () => {
          const current = this.current();
          if (!current.selection || !current.instanceId) return null;
          return {
            profile: current.selection.profile,
            instanceId: current.instanceId,
          };
        },
        inspectReview,
      );
  }

  private current() {
    const database = this.database;
    const row = tableExists(database, 'setup_profile')
      ? database
          ?.prepare('SELECT revision, document FROM setup_profile WHERE id = 1')
          .get()
      : undefined;
    const selection: Selection | null = row?.document
      ? JSON.parse(String(row.document))
      : null;
    const route = manualRoute(database);
    const meta = tableExists(database, 'metadata')
      ? database
          ?.prepare("SELECT value FROM metadata WHERE key = 'instance_id'")
          .get()
      : undefined;
    return {
      selection,
      route,
      revision: Number(row?.revision ?? 0) + route.revision,
      instanceId: typeof meta?.value === 'string' ? meta.value : null,
    };
  }

  inspect(file?: string): SetupProfileReview {
    const current = this.current();
    const path = resolve(
      file ?? current.selection?.profile.path ?? this.defaultFile,
    );
    const activePath = current.selection?.profile.path ?? null;
    const route = current.selection?.managed
      ? (current.selection.profile.route ?? 'inbox')
      : current.route.value;
    const common = {
      instanceId: current.instanceId,
      path,
      activePath,
      effectiveRevision: current.revision,
      routing: {
        desired: null,
        effective: route,
        managed: current.selection?.managed ?? false,
        source: current.selection?.profile.routeSource ?? null,
        writesTo: null,
      },
    };
    try {
      const loaded = readSetupProfile(path);
      return setupProfileReviewSchema.parse({
        ...common,
        revision: loaded.revision,
        status:
          activePath !== path
            ? 'candidate'
            : current.selection?.profile.revision === loaded.revision
              ? 'current'
              : 'changed',
        files: loaded.files,
        issues: [],
        declarations: loaded.declarations.map(entry =>
          current.instanceId &&
          this.reviews?.isApplied(loaded, current.instanceId, entry)
            ? { ...entry, state: 'reviewed' }
            : entry,
        ),
        changes: profileChanges(
          current.selection?.profile.declarations ?? [],
          loaded.declarations,
        ),
        routing: {
          ...common.routing,
          desired: loaded.route,
          source: loaded.routeSource,
          writesTo: loaded.routeWritePath,
        },
      });
    } catch (error) {
      if (!(error instanceof SetupProfileFileError)) throw error;
      return setupProfileReviewSchema.parse({
        ...common,
        revision: null,
        status: error.status,
        files: [],
        issues:
          error.status === 'absent' && path !== activePath ? [] : error.issues,
        declarations: current.selection?.profile.declarations ?? [],
      });
    }
  }

  async apply(
    input: Extract<SetupProfileInput, { action: 'apply' }>,
    principal = desktop,
  ) {
    if (!this.changes || !this.database)
      throw new ConfigurationRefusal(
        'unavailable',
        'Open the local configuration store before applying a profile.',
      );
    if (this.current().instanceId !== input.instanceId)
      throw new ConfigurationRefusal(
        'conflict',
        'The computer identity changed. Preview the profile again.',
      );
    const result = await this.changes.submit(principal, 'apply', {
      actionId: input.actionId,
      target,
      operation: 'update',
      baseVersion: { type: 'revision', revision: input.effectiveRevision },
      draft: {
        kind: 'setup-profile',
        value: { path: resolve(input.file), digest: input.revision },
      },
    });
    if (result.receipt.status === 'applied') await this.recoverPendingReviews();
    return result;
  }

  editRouting(input: Extract<SetupProfileInput, { action: 'edit-routing' }>) {
    const authorize = () => {
      const current = this.current();
      if (
        !current.selection?.managed ||
        current.selection.profile.path !== resolve(input.file) ||
        current.instanceId !== input.instanceId ||
        current.revision !== input.effectiveRevision
      )
        throw new ConfigurationRefusal(
          'conflict',
          'The computer or profile changed. Preview the setting again.',
        );
    };
    return this.changes!.submit(
      { source: { kind: 'owner' }, authorize },
      'apply',
      {
        actionId: input.actionId,
        target: {
          area: 'setup-profile-file',
          key: input.layer === 'shared' ? 'shared-routing' : 'routing',
        },
        operation: 'update',
        baseVersion: { type: 'hash', hash: input.revision },
        draft: { kind: 'route', value: input.route },
      },
    );
  }

  inspectFragment(
    input: Extract<
      SetupProfileInput,
      { action: 'inspect-fragment' | 'edit-fragment' }
    >,
  ) {
    const current = this.current();
    if (
      current.instanceId !== input.instanceId ||
      !current.selection ||
      current.selection.profile.revision !== input.revision ||
      (input.action === 'edit-fragment' &&
        input.effectiveRevision !== current.revision)
    )
      throw new ConfigurationRefusal(
        'conflict',
        'The computer or profile changed. Refresh the profile first.',
      );
    const { profile, source } = readSetupFragment(
      current.selection.profile.path,
      input.layer,
    );
    if (profile.revision !== input.revision)
      throw new ConfigurationRefusal(
        'conflict',
        'The profile or an include changed. Refresh it before editing.',
      );
    return { layer: source.layer, path: source.path, text: source.text };
  }

  async editFragment(
    input: Extract<SetupProfileInput, { action: 'edit-fragment' }>,
  ) {
    const result = await this.changes!.submit(
      {
        source: { kind: 'owner' },
        authorize: () => {
          this.inspectFragment(input);
        },
      },
      'apply',
      {
        actionId: input.actionId,
        target: {
          area: 'setup-profile-file',
          key: 'fragment',
          name: input.layer,
        },
        operation: 'update',
        baseVersion: { type: 'hash', hash: input.revision },
        draft: { kind: 'markdown', document: input.text },
      },
    );
    if (result.receipt.status === 'applied') await this.recoverPendingReviews();
    return result;
  }

  saveAs(input: Extract<SetupProfileInput, { action: 'save-as' }>) {
    const current = this.inspect();
    if (
      current.instanceId !== input.instanceId ||
      current.effectiveRevision !== input.effectiveRevision
    )
      throw new ConfigurationRefusal(
        'conflict',
        'The computer settings changed. Review the export again.',
      );
    const file = writeNewSetupProfile(
      input.file,
      this.portableProfile(),
      this.defaultFile,
    );
    if (current.activePath) return undefined;
    const candidate = readSetupProfile(file);
    return this.apply({
      action: 'apply',
      file,
      instanceId: input.instanceId,
      effectiveRevision: input.effectiveRevision,
      revision: candidate.revision,
      actionId: input.actionId,
    });
  }

  portableProfile() {
    const { selection, route } = this.current();
    const desired = selection?.profile.portable;
    return {
      ...desired,
      version: 1 as const,
      sessionControl: selection?.sessionLimits,
      inbox: {
        ...desired?.inbox,
        defaultRoute: selection?.managed
          ? (selection.profile.route ?? 'inbox')
          : route.value,
      },
    };
  }

  async refresh() {
    const current = this.current();
    if (!current.selection) return;
    const view = this.inspect(current.selection.profile.path);
    if (view.status === 'changed' && view.revision)
      await this.apply(
        {
          action: 'apply',
          file: view.path,
          revision: view.revision,
          effectiveRevision: view.effectiveRevision,
          instanceId: view.instanceId,
          actionId: randomUUID(),
        },
        drift,
      );
  }

  async recoverPendingReviews() {
    if (!this.reviews || this.inspect().status !== 'current') return;
    await this.reviews?.synchronize();
  }

  private writer(): ConfigurationWriter {
    const snapshot = (): ConfigurationSnapshot => {
      const current = this.current();
      const { selection } = current;
      const path = selection?.profile.path ?? null;
      const digest = selection?.profile.revision ?? null;
      const source = path ? this.inspect(path) : null;
      return {
        identity: current.instanceId ?? 'uninitialized',
        label: 'Setup profile',
        dependencies: source?.revision ?? source?.status ?? '',
        version: { type: 'revision', revision: current.revision },
        value: { kind: 'setup-profile', value: { path, digest } },
        document: selectionText(selection),
        state: JSON.stringify(selection),
      };
    };
    return {
      kind: 'database',
      open: requested => {
        if (requested.area !== 'setup-profile')
          throw new ConfigurationRefusal(
            'unsupported',
            'Choose the supported profile target.',
          );
        return {
          read: snapshot,
          prepare: ({ draft }, before, restore) => {
            if (
              before.version.type !== 'revision' ||
              draft?.kind !== 'setup-profile'
            )
              throw new ConfigurationRefusal(
                'invalid-request',
                'Preview a profile before applying it.',
              );
            const { path, digest } = draft.value;
            if (!restore && (!path || !digest))
              throw new ConfigurationRefusal(
                'invalid-request',
                'Select a profile on this computer.',
              );
            const previous: Selection | null = before.state
              ? JSON.parse(before.state)
              : null;
            const loaded = path ? readSetupProfile(path) : null;
            if ((loaded?.revision ?? null) !== digest)
              throw new ConfigurationRefusal(
                'conflict',
                'The profile or an include changed. Preview it again.',
              );
            const oldSelection: Selection | null = restore?.state
              ? JSON.parse(restore.state)
              : null;
            const selection: Selection | null = loaded
              ? {
                  profile: loaded,
                  managed: restore
                    ? !!oldSelection?.managed
                    : loaded.route !== null || !!previous?.managed,
                  sessionLimits: restore
                    ? oldSelection?.sessionLimits
                    : restrictSessionLimits(
                        previous?.sessionLimits,
                        loaded.sessionControl,
                      ),
                  retiredInboxRules: restore
                    ? oldSelection?.retiredInboxRules
                    : retainInboxRuleOwnership(previous, loaded),
                }
              : null;
            return {
              classification: 'direct',
              after: {
                ...before,
                value: draft,
                dependencies: digest ?? '',
                version: {
                  type: 'revision',
                  revision: before.version.revision + 1,
                },
                state: JSON.stringify(selection),
                document: selectionText(selection),
              },
            };
          },
          write: ({ to }) => {
            const selection: Selection | null = to.state
              ? JSON.parse(to.state)
              : null;
            if (
              selection &&
              readSetupProfile(selection.profile.path).revision !==
                selection.profile.revision
            )
              throw new ConfigurationRefusal(
                'conflict',
                'The profile or an include changed. Preview it again.',
              );
            this.save(selection);
          },
        };
      },
    };
  }

  private save(selection: Selection | null) {
    this.database!.prepare(
      'INSERT INTO setup_profile (id, revision, document, route, managed) VALUES (1, 1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET revision = revision + 1, document = excluded.document, route = excluded.route, managed = excluded.managed',
    ).run(
      selection ? JSON.stringify(selection) : null,
      selection?.profile.route ?? null,
      selection?.managed ? 1 : 0,
    );
    this.projectProfile?.(selection?.profile ?? null);
  }

  private fileWriter(): ConfigurationWriter {
    return {
      kind: 'file',
      locked: async (requested, use, recovery) => {
        const current = this.current();
        if (requested.area !== 'setup-profile-file' || !current.selection)
          throw new ConfigurationRefusal(
            'unsupported',
            'Choose an active profile on this computer.',
          );
        const recipeId =
          requested.key === 'recipe' ? requested.name : undefined;
        const layer =
          requested.key === 'fragment'
            ? setupProfileLayerSchema.safeParse(requested.name).data
            : undefined;
        if (
          requested.key === 'recipe'
            ? !recipeId
            : requested.key === 'fragment'
              ? !layer
              : !current.selection.managed
        )
          throw new ConfigurationRefusal(
            'unsupported',
            'Choose a valid profile setting.',
          );
        const selected = current.selection.profile;
        const opened = recipeId
          ? readSetupRecipeSource(selected.path, recipeId)
          : layer
            ? readSetupFragment(selected.path, layer)
            : readSetupRouteSource(
                selected.path,
                requested.key === 'shared-routing',
              );
        const { profile, source } = opened;
        const value: ConfigurationValue = recipeId
          ? {
              kind: 'setup-recipe',
              value: {
                id: recipeId,
                definition: opened.definition,
              },
            }
          : layer
            ? { kind: 'markdown', document: source.text }
            : { kind: 'route', value: profile.route ?? 'inbox' };
        const ensureFresh = (digest: string) => {
          const now = this.current();
          const loaded = readSetupProfile(selected.path);
          if (
            now.revision !== current.revision ||
            now.instanceId !== current.instanceId ||
            now.selection?.profile.path !== selected.path ||
            loaded.revision !== digest
          )
            throw new ConfigurationRefusal(
              'conflict',
              'The profile or an include changed. Review the newest version.',
            );
          return loaded;
        };
        const identity = (current.instanceId ?? '') + ':' + selected.path;
        const state: RouteEditorState = {
          path: source.path,
          text: source.text,
          ...(layer
            ? {
                selection: {
                  managed: current.selection.managed,
                  sessionLimits: current.selection.sessionLimits,
                  retiredInboxRules: current.selection.retiredInboxRules,
                },
              }
            : {}),
        };
        return use({
          read: () => ({
            identity,
            dependencies: String(current.revision),
            label: layer
              ? 'Profile fragment'
              : recipeId
                ? undefined
                : 'Profile Inbox route',
            version: { type: 'hash', hash: profile.revision },
            value,
            state: JSON.stringify(state),
          }),
          prepare: ({ draft }, before, restore) => {
            if (
              draft?.kind !== value.kind ||
              (!recovery && selected.revision !== profile.revision)
            )
              throw new ConfigurationRefusal(
                'conflict',
                'Review the active profile before editing this setting.',
              );
            if (
              draft.kind === 'setup-recipe' &&
              (draft.value.id !== recipeId ||
                (!restore && draft.value.definition?.id !== recipeId))
            )
              throw new ConfigurationRefusal(
                'invalid-request',
                'The recipe does not match the reviewed profile entry.',
              );
            const replacement: RouteEditorState = restore?.state
              ? JSON.parse(restore.state)
              : {
                  path: source.path,
                  text:
                    draft.kind === 'setup-recipe' && draft.value.definition
                      ? profileWithRecipe(source.value, draft.value.definition)
                      : draft.kind === 'route'
                        ? profileWithRoute(source.value, draft.value)
                        : draft.kind === 'markdown'
                          ? draft.document
                          : source.text,
                };
            if (!profile.files.some(file => file.path === replacement.path))
              throw new ConfigurationRefusal(
                'conflict',
                'The original profile fragment is unavailable.',
              );
            const preview = readSetupProfile(selected.path, replacement);
            if (
              layer &&
              (preview.files.length !== profile.files.length ||
                preview.files.some(
                  (file, index) => file.path !== profile.files[index]?.path,
                ))
            )
              throw new ConfigurationRefusal(
                'invalid-request',
                'Keep the same include paths when editing a fragment.',
              );
            if (layer && !restore)
              replacement.selection = {
                managed: preview.route !== null || !!current.selection?.managed,
                sessionLimits: restrictSessionLimits(
                  current.selection?.sessionLimits,
                  preview.sessionControl,
                ),
                retiredInboxRules: retainInboxRuleOwnership(
                  current.selection,
                  preview,
                ),
              };
            if (
              draft.kind === 'route' &&
              (preview.route ?? 'inbox') !== draft.value
            )
              throw new ConfigurationRefusal(
                'conflict',
                'A higher-priority profile layer overrides this setting.',
              );
            return {
              classification: recipeId ? 'review' : 'direct',
              after: {
                ...before,
                value: draft,
                dependencies: String(current.revision + 1),
                version: { type: 'hash', hash: preview.revision },
                state: JSON.stringify(replacement),
              },
            };
          },
          verify: async from => {
            if (from.version.type === 'hash') ensureFresh(from.version.hash);
          },
          write: async ({ from, to }, authorize) => {
            if (from.version.type !== 'hash' || !to.state)
              throw new ConfigurationRefusal(
                'invalid-request',
                'The file edit is unavailable.',
              );
            const expected = from.version.hash;
            const replacement: RouteEditorState = JSON.parse(to.state);
            replaceSetupProfileFile(replacement, () => {
              authorize();
              ensureFresh(expected);
            });
          },
          settle: ({ from, to }) => {
            if (
              to.version.type !== 'hash' ||
              from.dependencies !== String(current.revision)
            )
              throw new ConfigurationRefusal(
                'conflict',
                'Inspect the unconfirmed profile edit.',
              );
            const verified = ensureFresh(to.version.hash);
            const replacement: RouteEditorState | null = to.state
              ? JSON.parse(to.state)
              : null;
            this.save({
              profile: verified,
              managed:
                replacement?.selection?.managed ??
                Boolean(current.selection?.managed),
              sessionLimits: replacement?.selection
                ? replacement.selection.sessionLimits
                : current.selection?.sessionLimits,
              retiredInboxRules: replacement?.selection
                ? replacement.selection.retiredInboxRules
                : current.selection?.retiredInboxRules,
            });
          },
        });
      },
    };
  }
}
