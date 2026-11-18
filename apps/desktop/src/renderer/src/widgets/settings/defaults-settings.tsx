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
import { Input } from '@/shared/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { Switch } from '@/shared/ui/switch';

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
        {defaultFolderSupported ? (
          <div className="px-3 py-2.5">
            <DefaultFolderField
              key={`${hostId}:${defaultFolder ?? ''}`}
              id="defaults-directory"
              label="Folder"
              computerName={computerName}
              value={defaultFolder}
              supported
              onSave={onSaveDefaultFolder}
            />
          </div>
        ) : (
          <SettingsRow
            title={<label htmlFor="defaults-directory">Folder</label>}
            description="Leave blank to keep the last folder."
          >
            <Input
              id="defaults-directory"
              size="md"
              className="w-52 font-mono"
              placeholder="Absolute path"
              spellCheck={false}
              maxLength={4096}
              value={defaults.directory}
              onChange={event => update({ directory: event.target.value })}
            />
          </SettingsRow>
        )}
        <SettingsRow
          title={
            <label htmlFor="defaults-worktree">
              Start sessions in a worktree
            </label>
          }
          description="Applies when the folder is a Git repository."
        >
          <Switch
            id="defaults-worktree"
            checked={defaults.worktree}
            onCheckedChange={worktree => update({ worktree })}
          />
        </SettingsRow>
      </SettingsSection>
      <p className="px-3 text-xs text-muted-foreground">
        Defaults only pre-fill the new session form. The folder is saved on the
        computer; the other defaults stay on this desktop. They never change
        existing sessions, and group defaults take precedence when you start a
        session in a group.
      </p>
    </div>
  );
}
