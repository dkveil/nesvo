import type { Provider } from '@nesvo/contracts';
import type { ProviderStates } from '@/entities/session';
import { useState } from 'react';
import type {
  CodeReviewSettings as Settings,
  Computer,
  DesktopApi,
  ReviewConvention,
  ReviewerProfile,
} from '@nesvo/contracts';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import {
  findingTypeLabels,
  layerLabels,
  severityLabels,
  toneLabels,
  useCodeReviewSettings,
} from '@/features/code-review';
import { errorDetail, modelLabel } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { IconButton } from '@/shared/ui/icon-button';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';
import { ConventionForm } from './convention-form';
import { ProfileForm } from './profile-form';

type CodeReviewSettingsApi = Pick<
  DesktopApi,
  | 'readCodeReviewSettings'
  | 'saveReviewerProfile'
  | 'deleteReviewerProfile'
  | 'saveReviewConvention'
  | 'deleteReviewConvention'
>;

type CodeReviewSettingsProps = {
  computer: Computer | undefined;
  api: CodeReviewSettingsApi;
  statuses: ProviderStates;
  onRefreshProvider: (provider: Provider) => void;
};

type Editing =
  | { kind: 'profile'; profile: ReviewerProfile | null }
  | { kind: 'convention'; convention: ReviewConvention | null }
  | null;

type Removing =
  | { kind: 'profile'; profile: ReviewerProfile }
  | { kind: 'convention'; convention: ReviewConvention }
  | null;

const profileDescription = (profile: ReviewerProfile) =>
  [
    `${profile.provider} · ${profile.provider === 'Claude Code' ? modelLabel(profile.model) : profile.model}${profile.effort ? ` · ${profile.effort}` : ''}`,
    profile.findingTypes.map(type => findingTypeLabels[type]).join(', '),
    `${severityLabels[profile.minimumSeverity]} and above · up to ${profile.maxFindings}`,
    `${toneLabels[profile.tone]} · ${profile.language}${profile.includeSummary ? ' · summary' : ''}`,
  ].join(' · ');

export function CodeReviewSettings({
  computer,
  api,
  statuses,
  onRefreshProvider,
}: CodeReviewSettingsProps) {
  const hostId = computer?.id ?? 'local';
  const connected = computer?.status === 'connected';
  const supported = !!computer?.capabilities.includes('pull-request-reviews');
  const settings = useCodeReviewSettings(api, hostId, connected && supported);
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<Removing>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const apply = async (action: () => Promise<Settings>) => {
    setPending(true);
    setError('');
    try {
      settings.replace(await action());
      return true;
    } catch (failure) {
      setError(errorDetail(failure));
      return false;
    } finally {
      setPending(false);
    }
  };
  const open = (next: Editing) => {
    setError('');
    setEditing(next);
  };
  if (!connected)
    return (
      <InlineNotice>
        Connect {computer?.name ?? 'this computer'} to manage its code review
        settings.
      </InlineNotice>
    );
  if (!supported)
    return (
      <InlineNotice tone="warning">
        Update this computer’s Nesvo host and reconnect to review pull requests
        with an agent.
      </InlineNotice>
    );
  const profiles = settings.settings?.profiles ?? [];
  const conventions = settings.settings?.conventions ?? [];
  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">
        Profiles and conventions are stored on the selected computer.
      </p>
      {settings.status === 'error' && (
        <StatusMessage tone="error">{settings.error}</StatusMessage>
      )}
      <SettingsSection
        title="Reviewer profiles"
        action={
          profiles?.length ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={pending || editing?.kind === 'profile'}
              onClick={() => open({ kind: 'profile', profile: null })}
            >
              <Plus />
              Add profile
            </Button>
          ) : undefined
        }
      >
        {editing?.kind === 'profile' && !editing.profile && (
          <ProfileForm
            statuses={statuses}
            onRefreshProvider={onRefreshProvider}
            profile={null}
            pending={pending}
            error={error}
            onCancel={() => setEditing(null)}
            onSave={input =>
              void apply(() => api.saveReviewerProfile(input)).then(saved => {
                if (saved) setEditing(null);
              })
            }
          />
        )}
        {profiles.map(profile =>
          editing?.kind === 'profile' && editing.profile?.id === profile.id ? (
            <ProfileForm
              statuses={statuses}
              onRefreshProvider={onRefreshProvider}
              key={profile.id}
              profile={profile}
              pending={pending}
              error={error}
              onCancel={() => setEditing(null)}
              onDelete={() => setRemoving({ kind: 'profile', profile })}
              onSave={input =>
                void apply(() => api.saveReviewerProfile(input)).then(saved => {
                  if (saved) setEditing(null);
                })
              }
            />
          ) : (
            <SettingsRow
              key={profile.id}
              title={profile.name}
              description={profileDescription(profile)}
            >
              <IconButton
                label={`Edit ${profile.name}`}
                disabled={pending}
                onClick={() => open({ kind: 'profile', profile })}
              >
                <Pencil />
              </IconButton>
            </SettingsRow>
          ),
        )}
        {!profiles.length && editing?.kind !== 'profile' && (
          <SettingsRow
            title="No reviewer profiles"
            description={
              <span className="block space-y-2">
                <span className="block">
                  Add a profile to choose the provider, model and rules for
                  agent reviews.
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={pending}
                  onClick={() => open({ kind: 'profile', profile: null })}
                >
                  <Plus />
                  Add profile
                </Button>
              </span>
            }
          />
        )}
      </SettingsSection>
      <SettingsSection
        title="Conventions"
        action={
          conventions?.length ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={pending || editing?.kind === 'convention'}
              onClick={() => open({ kind: 'convention', convention: null })}
            >
              <Plus />
              Add convention
            </Button>
          ) : undefined
        }
      >
        {editing?.kind === 'convention' && !editing.convention && (
          <ConventionForm
            convention={null}
            pending={pending}
            error={error}
            onCancel={() => setEditing(null)}
            onSave={input =>
              void apply(() => api.saveReviewConvention(input)).then(saved => {
                if (saved) setEditing(null);
              })
            }
          />
        )}
        {conventions.map(convention =>
          editing?.kind === 'convention' &&
          editing.convention?.id === convention.id ? (
            <ConventionForm
              key={convention.id}
              convention={convention}
              pending={pending}
              error={error}
              onCancel={() => setEditing(null)}
              onSave={input =>
                void apply(() => api.saveReviewConvention(input)).then(
                  saved => {
                    if (saved) setEditing(null);
                  },
                )
              }
            />
          ) : (
            <SettingsRow
              key={convention.id}
              title={
                <span className="font-normal whitespace-pre-wrap">
                  {convention.text}
                </span>
              }
              description={
                convention.layer === 'global'
                  ? layerLabels.global
                  : `${layerLabels[convention.layer]} · ${convention.scope}`
              }
            >
              <IconButton
                label="Edit convention"
                disabled={pending}
                onClick={() => open({ kind: 'convention', convention })}
              >
                <Pencil />
              </IconButton>
              <IconButton
                label="Delete convention"
                tone="danger"
                disabled={pending}
                onClick={() => setRemoving({ kind: 'convention', convention })}
              >
                <Trash2 />
              </IconButton>
            </SettingsRow>
          ),
        )}
        {!conventions.length && editing?.kind !== 'convention' && (
          <SettingsRow
            title="No conventions"
            description={
              <span className="block space-y-2">
                <span className="block">
                  Global conventions apply to every review, language conventions
                  to matching changed files and project conventions to one
                  repository or folder.
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={pending}
                  onClick={() => open({ kind: 'convention', convention: null })}
                >
                  <Plus />
                  Add convention
                </Button>
              </span>
            }
          />
        )}
      </SettingsSection>
      <ConfirmDialog
        surface="panel"
        open={!!removing}
        onOpenChange={next => {
          if (!next) setRemoving(null);
        }}
        title={
          removing?.kind === 'profile'
            ? `Delete ${removing.profile.name}?`
            : 'Delete this convention?'
        }
        description={
          removing?.kind === 'profile'
            ? 'Existing draft reviews keep the settings they were started with.'
            : 'Later reviews no longer include it.'
        }
        confirmLabel={
          removing?.kind === 'profile' ? 'Delete profile' : 'Delete convention'
        }
        pendingLabel="Deleting…"
        onConfirm={async () => {
          if (!removing) return true;
          const done = await apply(() =>
            removing.kind === 'profile'
              ? api.deleteReviewerProfile({
                  id: removing.profile.id,
                  expectedRevision: removing.profile.revision,
                })
              : api.deleteReviewConvention({ id: removing.convention.id }),
          );
          if (done) setEditing(null);
          return done;
        }}
      >
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
      </ConfirmDialog>
    </div>
  );
}
