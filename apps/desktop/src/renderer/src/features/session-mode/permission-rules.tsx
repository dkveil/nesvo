import { useState } from 'react';
import type { AllowRule } from '@nesvo/contracts';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
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
    <section className="space-y-2" aria-label="Allow rules">
      <h3 className="text-sm font-medium">Allow rules</h3>
      {!rules.length && (
        <p className="text-xs text-muted-foreground">No saved allow rules.</p>
      )}
      <ul className="divide-y">
        {rules.map(rule => (
          <li
            key={rule.id}
            className="flex items-start justify-between gap-2 py-2"
          >
            <div className="min-w-0 space-y-1">
              <Badge size="xs">
                {rule.scope === 'session' ? 'Session' : 'Project'}
              </Badge>
              <p className="break-all font-mono text-xs">{rule.pattern}</p>
              <p className="break-all text-xs text-muted-foreground">
                {rule.directory}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={removing !== null}
              aria-label={'Remove ' + rule.pattern}
              onClick={() => void remove(rule.id)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {failure && <StatusMessage tone="error">{failure}</StatusMessage>}
    </section>
  );
}
