import type {
  ConfigurationTarget,
  SetupProfileDeclaration,
} from '@nesvo/contracts';
import {
  absentConfigurationVersion,
  configurationHash,
  ConfigurationRefusal,
  type ConfigurationChanges,
  type ConfigurationPrincipal,
  type ConfigurationWriter,
} from './workflows/configuration-changes';
import {
  readSetupProfile,
  type LoadedSetupProfile,
} from './setup-profile-file';
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

export type SetupNativeReview = {
  fingerprint: string;
  description: string;
  accept: () => void;
  applied?: () => boolean;
  revoke?: () => void;
};

export type SetupReviewInspection = (
  profile: LoadedSetupProfile,
  declaration: SetupProfileDeclaration,
  instanceId: string,
) => Promise<SetupNativeReview | string | undefined>;

function proposalActionId(scope: string, key: string, digest: string) {
  const hash = configurationHash(JSON.stringify([scope, key, digest]));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export class SetupProfileReviewQueue {
  private reviews = new Map<string, SetupNativeReview | string>();

  constructor(
    private readonly changes: ConfigurationChanges,
    private readonly live: () => {
      profile: LoadedSetupProfile;
      instanceId: string;
    } | null,
    private readonly inspect?: SetupReviewInspection,
  ) {
    changes.register('setup-review', this.writer());
  }

  async synchronize(prefix?: string) {
    const live = this.live();
    if (!live) return;
    const scope = this.scope(live);
    const pending = live.profile.declarations.filter(
      entry =>
        entry.state === 'pending' && (!prefix || entry.key.startsWith(prefix)),
    );
    if (prefix && !pending.length) return;
    const reviews = prefix
      ? new Map(this.reviews)
      : new Map<string, SetupNativeReview | string>();
    for (const entry of pending) {
      if (this.live()?.profile.revision !== live.profile.revision) return;
      const review = await this.inspect?.(live.profile, entry, live.instanceId);
      if (review) reviews.set(this.key(live, entry), review);
      else reviews.delete(this.key(live, entry));
    }
    if (this.live()?.profile.revision !== live.profile.revision) return;
    this.reviews = reviews;
    for (const entry of pending) {
      const review = this.reviews.get(this.key(live, entry));
      if (typeof review === 'object' && review.applied?.()) continue;
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
      const digest = this.digest(live, entry);
      await this.changes
        .submit(source, 'propose', {
          target,
          actionId: proposalActionId(scope, entry.key, digest),
          operation: typeof review === 'object' ? 'create' : 'update',
          baseVersion:
            typeof review === 'object'
              ? absentConfigurationVersion
              : baseVersion,
          draft: {
            kind: 'setup-review',
            value: { scope, digest, label: entry.label },
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

  private key(
    live: NonNullable<ReturnType<SetupProfileReviewQueue['live']>>,
    entry: SetupProfileDeclaration,
  ) {
    return JSON.stringify([this.scope(live), live.profile.revision, entry.key]);
  }

  private digest(
    live: NonNullable<ReturnType<SetupProfileReviewQueue['live']>>,
    entry: SetupProfileDeclaration,
  ) {
    const review = this.reviews.get(this.key(live, entry));
    return typeof review === 'object'
      ? configurationHash(JSON.stringify([entry.revision, review.fingerprint]))
      : entry.revision;
  }

  isApplied(
    profile: LoadedSetupProfile,
    instanceId: string,
    entry: SetupProfileDeclaration,
  ) {
    const review = this.reviews.get(this.key({ profile, instanceId }, entry));
    return typeof review === 'object' && review.applied?.();
  }

  reason(
    profile: LoadedSetupProfile,
    instanceId: string,
    entry: SetupProfileDeclaration,
  ) {
    const review = this.reviews.get(this.key({ profile, instanceId }, entry));
    return typeof review === 'string' ? review : undefined;
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
        const review = this.reviews.get(this.key(live, entry));
        const digest = this.digest(live, entry);
        const native = typeof review === 'object' ? review : undefined;
        const initialVersion = native
          ? absentConfigurationVersion
          : baseVersion;
        const appliedValue = {
          kind: 'setup-review',
          value: { scope, digest, label: entry.label },
        } as const;
        return {
          read: () => {
            const applied = native?.applied?.();
            return {
              identity: scope,
              dependencies: digest,
              version: applied
                ? { type: 'revision', revision: 2 }
                : initialVersion,
              value: applied ? appliedValue : null,
              label: entry.label,
              document: applied
                ? native?.description
                : 'No runtime approval on this computer.',
            };
          },
          prepare: ({ draft }, before, restore) => {
            if (restore && draft === null && native?.revoke)
              return {
                classification: 'review',
                after: {
                  ...before,
                  value: null,
                  version: initialVersion,
                  document: 'Local runtime approval revoked.',
                },
              };
            if (
              draft?.kind !== 'setup-review' ||
              draft.value.scope !== scope ||
              draft.value.digest !== digest ||
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
                ...(native ? { setupVerified: true as const } : {}),
                document:
                  typeof review === 'object'
                    ? review.description
                    : description(entry),
              },
            };
          },
          write({ to }) {
            if (native) {
              let revision;
              try {
                revision = readSetupProfile(live.profile.path).revision;
              } catch {}
              if (revision !== live.profile.revision)
                throw new ConfigurationRefusal(
                  'conflict',
                  'The profile changed. Review the current definition.',
                );
              if (to.value === null) native.revoke?.();
              else native.accept();
              return;
            }
            throw new ConfigurationRefusal(
              'unsupported',
              typeof review === 'string'
                ? review
                : 'The owning computer cannot verify this definition in the current build.',
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
