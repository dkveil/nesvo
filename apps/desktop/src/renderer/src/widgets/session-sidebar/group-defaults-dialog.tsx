import { useState } from 'react';
import {
  providerSessionModes,
  sessionGroupDefaultsSchema,
  type ProviderProfile,
  type SessionGroup,
  type SessionGroupDefaults,
  type SessionWorkflow,
} from '@nesvo/contracts';
import { modeLabel, providers, type Provider } from '@/entities/session';
import { ProfileSelect } from '@/features/provider-profiles/profile-select';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  group: SessionGroup | null;
  profiles: ProviderProfile[];
  onOpenChange: (open: boolean) => void;
  onSave: (defaults: SessionGroupDefaults) => Promise<boolean>;
};

const ANY = 'any';

type Draft = {
  directory: string;
  provider: Provider | typeof ANY;
  profileId?: string | null;
  model: string;
  mode: string;
  workflowName: string;
  workflowRoot: SessionWorkflow['root'];
};

const toDraft = (defaults: SessionGroupDefaults): Draft => ({
  directory: defaults.directory ?? '',
  provider: defaults.provider ?? ANY,
  profileId: defaults.profileId,
  model: defaults.model ?? '',
  mode: defaults.mode ?? ANY,
  workflowName: defaults.workflow?.name ?? '',
  workflowRoot: defaults.workflow?.root ?? 'project',
});

const toDefaults = (draft: Draft) => {
  const provider = draft.provider === ANY ? undefined : draft.provider;
  return sessionGroupDefaultsSchema.safeParse({
    ...(draft.directory.trim() ? { directory: draft.directory.trim() } : {}),
    ...(provider ? { provider, profileId: draft.profileId } : {}),
    ...(provider && draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(provider && draft.mode !== ANY ? { mode: draft.mode } : {}),
    ...(draft.workflowName.trim()
      ? {
          workflow: {
            name: draft.workflowName.trim(),
            root: draft.workflowRoot,
          },
        }
      : {}),
  });
};

export function GroupDefaultsDialog({
  group,
  profiles,
  onOpenChange,
  onSave,
}: Props) {
  const [draft, setDraft] = useState<Draft>(() =>
    toDraft(group?.defaults ?? {}),
  );
  const [saving, setSaving] = useState(false);
  const parsed = toDefaults(draft);
  const change = (patch: Partial<Draft>) =>
    setDraft(previous => ({ ...previous, ...patch }));
  const modes =
    draft.provider === ANY ? [] : providerSessionModes[draft.provider];
  return (
    <Dialog
      open={!!group}
      onOpenChange={open => {
        if (!saving) onOpenChange(open);
      }}
    >
      <DialogContent className="gap-4 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New-session defaults for {group?.name}</DialogTitle>
          <DialogDescription>
            These values only pre-fill the form when you start a session from
            this group. Existing sessions keep their settings.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field id="group-default-directory" label="Folder">
            <Input
              size="lg"
              id="group-default-directory"
              placeholder="Absolute path on this computer"
              value={draft.directory}
              maxLength={4096}
              onChange={event => change({ directory: event.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field id="group-default-provider" label="Provider">
              <Select
                value={draft.provider}
                onValueChange={value =>
                  change({
                    provider: value as Draft['provider'],
                    profileId: undefined,
                    mode: ANY,
                    model: '',
                  })
                }
              >
                <SelectTrigger
                  size="lg"
                  id="group-default-provider"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>No default</SelectItem>
                  {providers.map(provider => (
                    <SelectItem key={provider} value={provider}>
                      {provider}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="group-default-mode" label="Permissions">
              <Select
                value={draft.mode}
                disabled={draft.provider === ANY}
                onValueChange={mode => change({ mode })}
              >
                <SelectTrigger
                  size="lg"
                  id="group-default-mode"
                  className="w-full"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>No default</SelectItem>
                  {draft.provider !== ANY &&
                    modes.map(mode => (
                      <SelectItem key={mode} value={mode}>
                        {modeLabel(draft.provider as Provider, mode)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field id="group-default-profile" label="Provider account">
            <ProfileSelect
              id="group-default-profile"
              className="w-full"
              profiles={profiles}
              provider={draft.provider === ANY ? null : draft.provider}
              value={draft.profileId}
              inherit="Use desktop default"
              onChange={profileId => change({ profileId })}
            />
          </Field>
          <Field id="group-default-model" label="Model">
            <Input
              size="lg"
              id="group-default-model"
              placeholder={
                draft.provider === ANY ? 'Choose a provider first' : 'default'
              }
              disabled={draft.provider === ANY}
              value={draft.model}
              maxLength={200}
              onChange={event => change({ model: event.target.value })}
            />
          </Field>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field id="group-default-workflow" label="Workflow">
              <Input
                size="lg"
                id="group-default-workflow"
                placeholder="No default"
                value={draft.workflowName}
                maxLength={200}
                onChange={event => change({ workflowName: event.target.value })}
              />
            </Field>
            <Field id="group-default-workflow-root" label="Source">
              <Select
                value={draft.workflowRoot}
                disabled={!draft.workflowName.trim()}
                onValueChange={value =>
                  change({ workflowRoot: value as SessionWorkflow['root'] })
                }
              >
                <SelectTrigger
                  size="lg"
                  id="group-default-workflow-root"
                  className="w-28"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="project">Project</SelectItem>
                  <SelectItem value="global">Global</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          {!parsed.success && (
            <StatusMessage tone="error">
              {parsed.error.issues[0]?.message}
            </StatusMessage>
          )}
        </div>
        <DialogFooter>
          <DialogCancel disabled={saving} onClick={() => onOpenChange(false)} />
          <Button
            size="lg"
            type="button"
            disabled={saving || !parsed.success}
            onClick={async () => {
              if (!parsed.success) return;
              setSaving(true);
              const saved = await onSave(parsed.data);
              setSaving(false);
              if (saved) onOpenChange(false);
            }}
          >
            {saving ? 'Saving…' : 'Save defaults'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
