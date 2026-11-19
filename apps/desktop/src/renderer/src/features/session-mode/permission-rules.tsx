import { useState } from 'react';
import type { AllowRule } from '@nesvo/contracts';
import { Button } from '@/shared/ui/button';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';

export function PermissionRules({
  rules,
  onRemove,
}: {
  rules: AllowRule[];
  onRemove: (id: string) => Promise<void>;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [failure, setFailure] = useState('');
  const remove = async (id: string) => {
    setRemoving(id);
    setFailure('');
    try {
      await onRemove(id);
    } catch (error) {
      setFailure(
        error instanceof Error
          ? error.message
          : 'The allow rule could not be removed.',
      );
    } finally {
      setRemoving(null);
    }
  };
  return (
    <SettingsSection title="Allow rules">
      {rules.length ? (
        rules.map(rule => (
          <SettingsRow
            key={rule.id}
            title={<code className="font-mono">{rule.pattern}</code>}
            description={
              (rule.scope === 'session' ? 'Session' : 'Project') +
              ' · ' +
              rule.directory
            }
          >
            <Button
              variant="destructive"
              disabled={removing !== null}
              aria-label={'Remove ' + rule.pattern}
              onClick={() => void remove(rule.id)}
            >
              Remove
            </Button>
          </SettingsRow>
        ))
      ) : (
        <div className="px-3 py-2">
          <StatusMessage tone="info">No saved allow rules.</StatusMessage>
        </div>
      )}
      {failure && (
        <div className="px-3 py-2">
          <StatusMessage tone="error">{failure}</StatusMessage>
        </div>
      )}
    </SettingsSection>
  );
}
