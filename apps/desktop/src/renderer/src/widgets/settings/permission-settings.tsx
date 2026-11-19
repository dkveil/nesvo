import { Badge } from '@/shared/ui/badge';
import { useState } from 'react';
import { PermissionRules } from '@/features/session-mode/permission-rules';
import { useClaudeAutonomy } from '@/features/session-mode/use-claude-autonomy';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { Switch } from '@/shared/ui/switch';
import { StatusMessage } from '@/shared/ui/status-message';

export function PermissionSettings({
  hostId,
  ready,
  onChange,
}: {
  hostId: string;
  ready: boolean;
  onChange: () => void;
}) {
  const { data, error, execute } = useClaudeAutonomy(hostId, ready);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState('');
  const enable = async (enabled: boolean) => {
    setFailure('');
    setSaving(true);
    try {
      await execute({ action: 'set-full-access', enabled });
      onChange();
    } catch (error) {
      setFailure(
        error instanceof Error
          ? error.message
          : 'Full access settings could not be saved.',
      );
    } finally {
      setSaving(false);
    }
  };
  if (!ready)
    return (
      <StatusMessage tone="info">
        Connect a computer that supports Claude permissions.
      </StatusMessage>
    );
  if (!data)
    return (
      <StatusMessage tone={error ? 'error' : 'loading'}>
        {error || 'Loading permissions…'}
      </StatusMessage>
    );
  return (
    <>
      <SettingsSection title="Full access">
        <SettingsRow
          title="Allow Full access mode"
          description="Confirm each session. Turning this off stops active Full access turns and revokes confirmations."
        >
          <Badge
            appearance="outline"
            tone={data.fullAccessEnabled ? 'warning' : 'neutral'}
          >
            {data.fullAccessEnabled ? 'On' : 'Off'}
          </Badge>
          <Switch
            aria-label="Allow Full access mode"
            checked={data.fullAccessEnabled}
            disabled={saving}
            onCheckedChange={enabled => void enable(enabled)}
          />
        </SettingsRow>
        {failure && (
          <div className="px-3 py-2">
            <StatusMessage tone="error">{failure}</StatusMessage>
          </div>
        )}
      </SettingsSection>
      <PermissionRules
        rules={data.rules}
        onRemove={async id => {
          await execute({ action: 'remove-rule', id });
          onChange();
        }}
      />
    </>
  );
}
