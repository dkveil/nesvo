import { useState } from 'react';
import type { AllowRule } from '@nesvo/contracts';
import { Button } from '@/shared/ui/button';
import { MiddleTruncatedText } from '@/shared/ui/middle-truncated-text';
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
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0">
                  {rule.scope === 'session' ? 'This session' : 'This project'} ·
                </span>
                <MiddleTruncatedText path value={rule.directory} />
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
          <StatusMessage tone="info">
            No saved allow rules. Choose Always allow on an eligible Claude tool
            request to save one.
          </StatusMessage>
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
