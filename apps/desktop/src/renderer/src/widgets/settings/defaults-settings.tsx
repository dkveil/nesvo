import { useState } from 'react';
import type { DesktopApi, ProviderProfile } from '@nesvo/contracts';
import { DefaultFolderField } from '@/features/default-session-folder';
import { ProfileSelect } from '@/features/provider-profiles/profile-select';
import { useProfileStatus } from '@/features/provider-profiles/use-profile-status';
import {
  modeLabel,
  providerModes,
  providers,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import {
  defaultProfileKey,
  readNewSessionDefaults,
  saveNewSessionDefaults,
  type NewSessionDefaults,
} from '@/features/new-thread/new-session-defaults';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { WorktreeDefaultRow } from '@/features/new-thread/worktree-default-row';

type Props = {
  providerStates: ProviderStates;
  computerName: string;
  hostId: string;
  profiles: ProviderProfile[];
  connected: boolean;
  api: DesktopApi;
  defaultFolder: string | null;
  defaultFolderSupported: boolean;
  onSaveDefaultFolder: (directory: string | null) => Promise<string | null>;
};

type Option = { value: string; label: string };

const LAST_USED = 'last-used';

function DefaultSelect({
  id,
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string | null;
  options: Option[];
  disabled?: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <Select
      value={value ?? LAST_USED}
      disabled={disabled}
      onValueChange={next => onChange(next === LAST_USED ? null : next)}
    >
      <SelectTrigger id={id} aria-label={label} size="md" className="w-52">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end" className="max-h-72">
        <SelectItem value={LAST_USED}>Last used</SelectItem>
        {options.map(option => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function withStored(options: Option[], stored: string | null) {
  if (!stored || options.some(option => option.value === stored))
    return options;
  return [...options, { value: stored, label: `${stored} (not reported)` }];
}

export function DefaultsSettings({
  providerStates,
  computerName,
  hostId,
  profiles,
  connected,
  api,
  defaultFolder,
  defaultFolderSupported,
  onSaveDefaultFolder,
}: Props) {
  const [defaults, setDefaults] = useState(readNewSessionDefaults);
  const update = (patch: Partial<NewSessionDefaults>) => {
    setDefaults(previous => {
      const next = { ...previous, ...patch };
      saveNewSessionDefaults(next);
      return next;
    });
  };
  const provider = defaults.provider;
  const profileKey = provider ? defaultProfileKey(hostId, provider) : '';
  const profileId = profileKey ? defaults.profileIds[profileKey] : undefined;
  const profile = useProfileStatus(
    api,
    hostId,
    provider ?? 'Claude Code',
    profileId,
    connected,
  );
  const status = provider
    ? profileId
      ? profile.state.status
      : providerStates[provider].status
    : null;
  const models = withStored(
    (status?.models ?? []).map(model => ({
      value: model.id,
      label: model.label,
    })),
    defaults.model,
  );
  const modes = provider
    ? withStored(
        providerModes(provider, status).map(mode => ({
          value: mode,
          label: modeLabel(provider, mode),
        })),
        defaults.mode,
      )
    : [];
  const providerHint = provider
    ? status
      ? `Models and modes reported by ${computerName}.`
      : `${provider} has not reported its models on ${computerName} yet.`
    : 'Choose a provider to set its model and permission mode.';
  return (
    <div className="space-y-8">
      <SettingsSection title="New sessions">
        <SettingsRow
          title={<label htmlFor="defaults-provider">Provider</label>}
          description={providerHint}
        >
          <DefaultSelect
            id="defaults-provider"
            label="Default provider"
            value={provider}
            options={providers.map(item => ({ value: item, label: item }))}
            onChange={next =>
              update({
                provider: next as Provider | null,
                model: null,
                mode: null,
              })
            }
          />
        </SettingsRow>
        <SettingsRow
          title={<label htmlFor="defaults-profile">Provider account</label>}
          description={`Applies to new sessions on ${computerName}.`}
        >
          <ProfileSelect
            id="defaults-profile"
            profiles={profiles}
            provider={provider}
            value={profileId}
            className="w-52"
            onChange={id =>
              update({
                profileIds: {
                  ...defaults.profileIds,
                  [profileKey]: id ?? null,
                },
              })
            }
          />
        </SettingsRow>
        <SettingsRow
          title={<label htmlFor="defaults-model">Model</label>}
          description="Falls back to the provider default when unavailable."
        >
          <DefaultSelect
            id="defaults-model"
            label="Default model"
            value={defaults.model}
            options={models}
            disabled={!provider}
            onChange={model => update({ model })}
          />
        </SettingsRow>
        <SettingsRow
          title={<label htmlFor="defaults-mode">Permission mode</label>}
          description="Only modes this provider supports are offered."
        >
          <DefaultSelect
            id="defaults-mode"
            label="Default permission mode"
            value={defaults.mode}
            options={modes}
            disabled={!provider}
            onChange={mode =>
              update({ mode: mode as NewSessionDefaults['mode'] })
            }
          />
        </SettingsRow>
        <DefaultFolderField
          key={hostId + ':' + (defaultFolder ?? defaults.directory)}
          id="defaults-directory"
          label="Folder"
          computerName={computerName}
          value={
            defaultFolderSupported ? defaultFolder : defaults.directory || null
          }
          supported={defaultFolderSupported || connected}
          chooseDirectory={hostId === 'local' ? api.chooseDirectory : undefined}
          onSave={
            defaultFolderSupported
              ? onSaveDefaultFolder
              : async directory => {
                  update({ directory: directory ?? '' });
                  return directory;
                }
          }
        />
        <WorktreeDefaultRow
          id="defaults-worktree"
          checked={defaults.worktree}
          onChange={worktree => update({ worktree })}
        />
      </SettingsSection>
      <p className="px-3 text-xs text-muted-foreground">
        Defaults prefill new sessions unless a session group overrides them.
      </p>
    </div>
  );
}
