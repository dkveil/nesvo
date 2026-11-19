import { useState } from 'react';
import type { AllowRule } from '@nesvo/contracts';
import { directoryLabel } from '@/entities/session';
import { MiddleTruncatedText } from '@/shared/ui/middle-truncated-text';
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
            title={
              <MiddleTruncatedText
                value={rule.pattern}
                className="font-mono text-xs"
              />
            }
            description={
              <span title={rule.directory}>
                {rule.scope === 'session' ? 'This session' : 'This project'} ·{' '}
                {directoryLabel(rule.directory)}
              </span>
            }
          >
            <Button
              variant="ghost"
              size="sm"
              className="text-error-foreground"
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
