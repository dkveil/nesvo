import { useState } from 'react';
import { PermissionRules } from '@/features/session-mode/permission-rules';
import { useClaudeAutonomy } from '@/features/session-mode/use-claude-autonomy';
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
        Permissions are unavailable on this computer.
      </StatusMessage>
    );
  if (!data)
    return (
      <StatusMessage tone={error ? 'error' : 'loading'}>
        {error || 'Loading permissions…'}
      </StatusMessage>
    );
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <label className="flex items-center justify-between gap-2 text-sm font-medium">
          Allow Full access mode
          <Switch
            checked={data.fullAccessEnabled}
            disabled={saving}
            onCheckedChange={enabled => void enable(enabled)}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Each session still requires confirmation. Turning this off stops
          active Full access turns and revokes their confirmations.
        </p>
        {failure && <StatusMessage tone="error">{failure}</StatusMessage>}
      </div>
      <PermissionRules
        rules={data.rules}
        onRemove={async id => {
          await execute({ action: 'remove-rule', id });
          onChange();
        }}
      />
    </div>
  );
}
