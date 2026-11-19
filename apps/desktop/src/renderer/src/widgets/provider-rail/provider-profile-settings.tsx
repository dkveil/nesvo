import { FolderPicker } from '@/shared/ui/folder-picker';
import { MiddleTruncatedText } from '@/shared/ui/middle-truncated-text';
import { PathInput } from '@/shared/ui/path-input';
import { useState } from 'react';
import type {
  Computer,
  DesktopApi,
  Provider,
  ProviderProfile,
} from '@nesvo/contracts';
import { errorDetail, providers } from '@/entities/session';
import { useProfileStatus } from '@/features/provider-profiles/use-profile-status';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';
import { useProviderUsage } from '@/pages/workspace/use-provider-usage';
import { ProviderAccounts } from './provider-accounts';

const NEW = 'new';

export function ProviderProfileSettings({
  computer,
  api,
  profiles,
  catalogError,
  onChange,
}: {
  computer: Computer | undefined;
  api: DesktopApi;
  profiles: ProviderProfile[] | undefined;
  catalogError?: string;
  onChange: (profiles: ProviderProfile[]) => void;
}) {
  const [selection, setSelection] = useState(NEW);
  const [provider, setProvider] = useState<Provider>('Claude Code');
  const [directory, setDirectory] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);
  const selected = profiles?.find(profile => profile.id === selection);
  const hostId = computer?.id ?? 'local';
  const connected = computer?.status === 'connected';
  const supported = !!computer?.capabilities.includes('provider-profiles');
  const editable = connected && supported && !!profiles && !catalogError;
  const status = useProfileStatus(
    api,
    hostId,
    selected?.provider ?? provider,
    selected?.id,
    connected,
  );
  const usage = useProviderUsage(hostId, connected, api, '', selected);
  const choose = (id: string) => {
    setSelection(id);
    setLabel(profiles?.find(profile => profile.id === id)?.label ?? '');
    setDirectory('');
    setError('');
  };
  const edit = async (action: () => Promise<ProviderProfile[]>) => {
    setBusy(true);
    setError('');
    try {
      const next = await action();
      onChange(next);
      return next;
    } catch (failure) {
      setError(errorDetail(failure));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const login = status.state.status;
  return (
    <div className="space-y-6">
      <ProviderAccounts
        hostId={hostId}
        computerName={computer?.name ?? 'Local'}
        connected={connected}
        states={usage.states}
        shown={selected?.provider ?? 'all'}
        onRefresh={() => {
          status.refresh();
          void usage.refresh();
        }}
        className="px-3"
      >
        {selected && (
          <p className="text-xs text-muted-foreground">
            {selected.label} ·{' '}
            {connected
              ? status.state.loading
                ? 'Checking sign-in…'
                : login?.status === 'ready'
                  ? 'Signed in'
                  : login?.status === 'unauthenticated'
                    ? 'Sign-in required'
                    : status.state.error ||
                      login?.detail ||
                      'Sign-in status unavailable'
              : 'Offline'}
          </p>
        )}
      </ProviderAccounts>
      <SettingsSection title="Provider accounts">
        {catalogError && (
          <StatusMessage tone="error">{catalogError}</StatusMessage>
        )}
        {!supported && connected && (
          <StatusMessage tone="warning">
            Update this computer’s Nesvo host to manage accounts.
          </StatusMessage>
        )}
        {editable && (
          <form
            className="grid grid-cols-1 gap-3 p-3"
            onSubmit={async event => {
              event.preventDefault();
              if (busy || !label.trim() || (!selected && !directory.trim()))
                return;
              if (selected) {
                if (
                  await edit(() =>
                    api.renameProviderProfile({
                      profileId: selected.id,
                      label,
                    }),
                  )
                )
                  setLabel(label.trim());
              } else {
                const previous = new Set(profiles.map(profile => profile.id));
                const next = await edit(() =>
                  api.createProviderProfile({
                    provider,
                    label,
                    configDirectory: directory,
                  }),
                );
                const added = next?.filter(
                  profile =>
                    !previous.has(profile.id) &&
                    profile.provider === provider &&
                    profile.label === label.trim(),
                );
                if (next) {
                  const created = added?.length === 1 ? added[0] : undefined;
                  setSelection(created?.id ?? NEW);
                  setLabel(created?.label ?? '');
                  setDirectory('');
                }
              }
            }}
          >
            <Field id="provider-account-selection" label="Account">
              <Select
                value={selected?.id ?? NEW}
                onValueChange={choose}
                disabled={busy}
              >
                <SelectTrigger
                  id="provider-account-selection"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NEW}>Add an account</SelectItem>
                  {profiles.map(profile => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.label} · {profile.provider}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {!selected && (
              <Field id="provider-account-provider" label="Provider">
                <Select
                  value={provider}
                  onValueChange={value => setProvider(value as Provider)}
                  disabled={busy}
                >
                  <SelectTrigger
                    id="provider-account-provider"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map(item => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field id="provider-account-label" label="Label">
              <Input
                id="provider-account-label"
                value={label}
                maxLength={80}
                disabled={busy}
                onChange={event => setLabel(event.target.value)}
              />
            </Field>
            <Field
              id="provider-account-directory"
              label="Configuration directory"
              as={selected ? 'span' : 'label'}
            >
              {selected ? (
                <MiddleTruncatedText
                  path
                  value={selected.configDirectory}
                  className="text-xs text-muted-foreground"
                />
              ) : hostId === 'local' ? (
                <FolderPicker
                  id="provider-account-directory"
                  value={directory || null}
                  chooseDirectory={api.chooseDirectory}
                  onChange={value => setDirectory(value ?? '')}
                  disabled={busy}
                />
              ) : (
                <PathInput
                  id="provider-account-directory"
                  value={directory}
                  disabled={busy}
                  placeholder="Absolute path on this computer"
                  maxLength={4096}
                  spellCheck={false}
                  onChange={event => setDirectory(event.target.value)}
                />
              )}
            </Field>
            {error && !removing && (
              <StatusMessage tone="error">{error}</StatusMessage>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              {selected && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setError('');
                    setRemoving(true);
                  }}
                >
                  Remove account
                </Button>
              )}
              <Button
                type="submit"
                disabled={
                  busy ||
                  !label.trim() ||
                  (selected
                    ? label.trim() === selected.label
                    : !directory.trim())
                }
              >
                {selected ? 'Save label' : 'Add account'}
              </Button>
            </div>
          </form>
        )}
      </SettingsSection>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${selected?.label ?? 'account'}?`}
        description="This removes the account from Nesvo. The provider directory stays on this computer."
        confirmLabel="Remove account"
        pendingLabel="Removing…"
        tone="destructive"
        onConfirm={async () => {
          if (!selected) return true;
          const removed = await edit(() =>
            api.removeProviderProfile({ profileId: selected.id }),
          );
          if (removed) choose(NEW);
          return !!removed;
        }}
      >
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
      </ConfirmDialog>
    </div>
  );
}
