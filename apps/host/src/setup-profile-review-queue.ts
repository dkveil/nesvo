import type {
  ConfigurationTarget,
  SetupProfileDeclaration,
} from '@nesvo/contracts';
import {
  configurationHash,
  ConfigurationRefusal,
  type ConfigurationChanges,
  type ConfigurationPrincipal,
  type ConfigurationWriter,
} from './workflows/configuration-changes';
import type { LoadedSetupProfile } from './setup-profile-file';
import { setupRuntimeRequirement } from './setup-runtime-requirements';

const baseVersion = { type: 'revision', revision: 1 } as const;
const source: ConfigurationPrincipal = {
  source: { kind: 'system', source: 'setup-profile' },
  authorize(verb, target) {
    if (target.area !== 'setup-review' || verb === 'apply')
      throw new ConfigurationRefusal(
        'unauthorized',
        'Setup observations can only prepare a review.',
      );
  },
};

function proposalActionId(scope: string, key: string, digest: string) {
  const hash = configurationHash(JSON.stringify([scope, key, digest]));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export class SetupProfileReviewQueue {
  constructor(
    private readonly changes: ConfigurationChanges,
    private readonly live: () => {
      profile: LoadedSetupProfile;
      instanceId: string;
    } | null,
  ) {
    changes.register('setup-review', this.writer());
  }

  async synchronize() {
    const live = this.live();
    if (!live) return;
    const scope = this.scope(live);
    for (const entry of live.profile.declarations) {
      if (entry.state !== 'pending') continue;
      const current = this.live();
      if (
        !current ||
        current.profile.revision !== live.profile.revision ||
        this.scope(current) !== scope
      )
        return;
      const target = {
        area: 'setup-review',
        id: entry.key,
      } as const satisfies ConfigurationTarget;
      await this.changes
        .submit(source, 'propose', {
          target,
          actionId: proposalActionId(scope, entry.key, entry.revision),
          operation: 'update',
          baseVersion,
          draft: {
            kind: 'setup-review',
            value: { scope, digest: entry.revision, label: entry.label },
          },
        })
        .catch(error => {
          if (
            error instanceof ConfigurationRefusal &&
            ['conflict', 'pending-limit', 'unavailable'].includes(error.code)
          )
            return;
          throw error;
        });
    }
  }

  private scope(
    live: NonNullable<ReturnType<SetupProfileReviewQueue['live']>>,
  ) {
    return configurationHash(
      JSON.stringify([live.instanceId, live.profile.path]),
    );
  }

  private writer(): ConfigurationWriter {
    return {
      kind: 'database',
      open: target => {
        const live = this.live();
        const entry =
          target.area === 'setup-review' &&
          live?.profile.declarations.find(item => item.key === target.id);
        if (!live || !entry || entry.state !== 'pending')
          throw new ConfigurationRefusal(
            'unavailable',
            'This declaration is no longer pending in the selected profile.',
          );
        const scope = this.scope(live);
        return {
          read: () => ({
            identity: scope,
            dependencies: entry.revision,
            version: baseVersion,
            value: null,
            label: entry.label,
            document: 'No runtime approval on this computer.',
          }),
          prepare: ({ draft }, before) => {
            if (
              draft?.kind !== 'setup-review' ||
              draft.value.scope !== scope ||
              draft.value.digest !== entry.revision ||
              draft.value.label !== entry.label
            )
              throw new ConfigurationRefusal(
                'conflict',
                'The profile declaration changed. Review its current revision.',
              );
            return {
              classification: 'authority',
              after: {
                ...before,
                value: draft,
                version: { type: 'revision', revision: 2 },
                document: description(entry),
              },
            };
          },
          write() {
            throw new ConfigurationRefusal(
              'unsupported',
              'The owning computer cannot verify this definition in the current build.',
            );
          },
        };
      },
    };
  }
}

function description(entry: SetupProfileDeclaration) {
  const native = setupRuntimeRequirement(entry.key);
  return [
    entry.label,
    'Desired definition is withheld pending local runtime verification.',
    'Definition digest: ' + entry.revision,
    ...(native
      ? [
          native.description,
          'Required host capabilities: ' + native.capabilities.join(', '),
        ]
      : []),
  ].join('\n');
}
