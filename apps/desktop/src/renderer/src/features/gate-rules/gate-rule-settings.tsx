import { useState } from 'react';
import type { Computer } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';
import { Switch } from '@/shared/ui/switch';
import { useGateRules } from './use-gate-rules';

export function GateRuleSettings({
  computer,
}: {
  computer: Computer | undefined;
}) {
  const hostId = computer?.id ?? 'local';
  const connected =
    computer?.status === 'connected' &&
    computer.capabilities.includes('gate-rules');
  const { overview, error, reload } = useGateRules(hostId, connected);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const save = async (
    enabled: boolean,
    action: 'settings' | 'decision-memory' = 'settings',
  ) => {
    setSaving(true);
    setFailure('');
    try {
      await window.nesvo.gateRules({ action, enabled }, hostId);
      reload();
    } catch (reason) {
      setFailure(errorDetail(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsSection title="Gate rules">
      <SettingsRow
        title="Propose gate rules after Fix and Reject"
        description="After a workflow settles, its gate model can draft rules for your review in the Inbox."
      >
        <Switch
          aria-label="Propose gate rules after Fix and Reject"
          checked={overview?.enabled ?? false}
          disabled={!connected || !overview || saving}
          onCheckedChange={enabled => void save(enabled)}
        />
      </SettingsRow>
      <SettingsRow
        title="Remember workflow decisions"
        description="Queue owner decisions for review as precedents for workflows on this computer."
      >
        <Switch
          aria-label="Remember workflow decisions"
          checked={overview?.decisionMemory ?? false}
          disabled={!connected || !overview || saving}
          onCheckedChange={enabled => void save(enabled, 'decision-memory')}
        />
      </SettingsRow>
      {(!connected || error || failure) && (
        <StatusMessage
          className="px-3 py-2"
          tone={error || failure ? 'error' : 'info'}
        >
          {failure ||
            error ||
            'Connect to a computer that supports gate rules.'}
        </StatusMessage>
      )}
    </SettingsSection>
  );
}
