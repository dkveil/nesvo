import { useEffect, useState } from 'react';
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
  const [states, setStates] = useState<Record<string, PresetState> | null>(
    null,
  );
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    if (!supported) return;
    let active = true;
    void api.listInboxRules({}, hostId).then(
      catalog => {
        if (!active) return;
        const enabled = new Set(
          catalog.rules
            .filter(rule => rule.scope === 'global' && rule.rule?.enabled)
            .map(rule => rule.name),
        );
        setLoadError('');
        setStates(
          Object.fromEntries(
            inboxRulePresets.map(preset => [
              preset.id,
              { on: enabled.has(presetName(preset)), busy: false, error: '' },
            ]),
          ),
        );
      },
      failure => {
        if (active) setLoadError(errorDetail(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [api, hostId, supported]);
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
  if (loadError) return <InlineNotice tone="error">{loadError}</InlineNotice>;
  if (!states)
    return <InlineNotice tone="loading">Loading Inbox rules…</InlineNotice>;
  return (
    <div className="space-y-3">
      <SettingsSection title="Inbox rules">
        {inboxRulePresets.map(preset => {
          const state = states[preset.id];
          return (
            <SettingsRow
              key={preset.id}
              title={preset.label}
              description={
                state?.error ? (
                  <StatusMessage tone="error">{state.error}</StatusMessage>
                ) : state?.on ? (
                  'Enabled for this computer.'
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
      <p className="px-3 text-2xs text-subtle-foreground">
        Edit these rules any time in Settings › Inbox rules.
      </p>
    </div>
  );
}
