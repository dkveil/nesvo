import { useState } from 'react';
import {
  inboxRulePresets,
  type Computer,
  type DesktopApi,
  type InboxRulePreset,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';
import { Switch } from '@/shared/ui/switch';

type Props = {
  api: Pick<
    DesktopApi,
    'saveInboxRule' | 'listInboxRules' | 'setInboxRuleEnabled'
  >;
  computer: Computer | undefined;
};

type PresetState = { on: boolean; busy: boolean; error: string };

const presetName = (preset: InboxRulePreset) =>
  /name: ([a-z0-9-]+)/.exec(preset.text)?.[1] ?? preset.id;

export function InboxStep({ api, computer }: Props) {
  const hostId = computer?.id ?? 'local';
  const supported =
    computer?.status === 'connected' &&
    computer.capabilities.includes('inbox-rules');
  const [states, setStates] = useState<Record<string, PresetState>>({});
  const toggle = async (preset: InboxRulePreset, on: boolean) => {
    setStates(previous => ({
      ...previous,
      [preset.id]: { on, busy: true, error: '' },
    }));
    try {
      const catalog = await api.listInboxRules({}, hostId);
      const existing = catalog.rules.find(
        rule => rule.scope === 'global' && rule.name === presetName(preset),
      );
      if (existing)
        await api.setInboxRuleEnabled(
          {
            scope: 'global',
            name: existing.name,
            expectedHash: existing.contentHash,
            enabled: on,
          },
          hostId,
        );
      else if (on)
        await api.saveInboxRule(
          { scope: 'global', text: preset.text, expectedHash: null },
          hostId,
        );
      setStates(previous => ({
        ...previous,
        [preset.id]: { on, busy: false, error: '' },
      }));
    } catch (failure) {
      setStates(previous => ({
        ...previous,
        [preset.id]: { on: !on, busy: false, error: errorDetail(failure) },
      }));
    }
  };
  if (!supported)
    return (
      <InlineNotice tone="warning">
        Connect a computer with a current Nesvo host to choose Inbox rules.
      </InlineNotice>
    );
  return (
    <div className="space-y-3">
      <p className="text-xs leading-5 text-muted-foreground">
        Everything is off until you turn it on. Each choice writes a normal rule
        file you can edit in Settings › Inbox rules.
      </p>
      <SettingsSection title="What should reach your Inbox?">
        {inboxRulePresets.map(preset => {
          const state = states[preset.id];
          return (
            <SettingsRow
              key={preset.id}
              title={preset.label}
              description={
                state?.error ? (
                  <StatusMessage tone="error">{state.error}</StatusMessage>
                ) : undefined
              }
            >
              <Switch
                aria-label={preset.label}
                data-preset={preset.id}
                checked={!!state?.on}
                disabled={!!state?.busy}
                onCheckedChange={on => void toggle(preset, on)}
              />
            </SettingsRow>
          );
        })}
      </SettingsSection>
    </div>
  );
}
