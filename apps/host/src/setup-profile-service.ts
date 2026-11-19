import {
  inboxSettingsSchema,
  setupProfileReviewSchema,
  type ConfigurationTarget,
  type SetupProfileInput,
  type SetupProfileReview,
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
  readSetupProfile,
  readSetupRouteSource,
  replaceSetupProfileFile,
  writeNewSetupProfile,
  SetupProfileFileError,
  type LoadedSetupProfile,
} from './setup-profile-file';
import { SetupProfileReviewQueue } from './setup-profile-review-queue';

const target = {
  area: 'setup-profile',
  key: 'selection',
} as const satisfies ConfigurationTarget;
const routeSchema = inboxSettingsSchema.shape.defaultRoute;
type Routing = SetupProfileReview['routing']['effective'];
type Selection = {
  profile: LoadedSetupProfile;
  managed: boolean;
};
type RouteEditorState = { path: string; text: string };

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
  const { profile, managed } = selection;
  return [
    'Profile ' + basename(profile.path),
    ...(managed ? ['Default Inbox route: ' + (profile.route ?? 'inbox')] : []),
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
  ) {
    this.defaultFile = defaultSetupProfilePath(directory);
    changes?.register('setup-profile', this.writer());
    changes?.register('setup-profile-file', this.routeWriter());
    if (changes)
      this.reviews = new SetupProfileReviewQueue(changes, () => {
        const current = this.current();
        if (!current.selection || !current.instanceId) return null;
        return {
          profile: current.selection.profile,
          instanceId: current.instanceId,
        };
      });
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
        declarations: loaded.declarations,
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
      current.routing.effective,
      this.defaultFile,
    );
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
  }

  private routeWriter(): ConfigurationWriter {
    return {
      kind: 'file',
      locked: async (requested, use, recovery) => {
        const current = this.current();
        if (
          requested.area !== 'setup-profile-file' ||
          !current.selection?.managed
        )
          throw new ConfigurationRefusal(
            'unsupported',
            'Choose an active profile-managed Inbox route.',
          );
        const selected = current.selection.profile;
        const { profile, source } = readSetupRouteSource(
          selected.path,
          requested.key === 'shared-routing',
        );
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
        };
        return use({
          read: () => ({
            identity,
            dependencies: String(current.revision),
            label: 'Profile Inbox route',
            version: { type: 'hash', hash: profile.revision },
            value: { kind: 'route', value: profile.route ?? 'inbox' },
            state: JSON.stringify(state),
          }),
          prepare: ({ draft }, before, restore) => {
            if (
              draft?.kind !== 'route' ||
              (!recovery && selected.revision !== profile.revision)
            )
              throw new ConfigurationRefusal(
                'conflict',
                'Review the active profile before editing this setting.',
              );
            const replacement: RouteEditorState = restore?.state
              ? JSON.parse(restore.state)
              : {
                  path: source.path,
                  text: profileWithRoute(source.value, draft.value),
                };
            if (!profile.files.some(file => file.path === replacement.path))
              throw new ConfigurationRefusal(
                'conflict',
                'The original profile fragment is unavailable.',
              );
            const preview = readSetupProfile(selected.path, replacement);
            if ((preview.route ?? 'inbox') !== draft.value)
              throw new ConfigurationRefusal(
                'conflict',
                'A higher-priority profile layer overrides this setting.',
              );
            return {
              classification: 'direct',
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
            this.save({ profile: verified, managed: true });
          },
        });
      },
    };
  }
}
