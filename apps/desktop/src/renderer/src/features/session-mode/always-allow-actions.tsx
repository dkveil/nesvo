import type { AllowPattern, AllowScope } from '@nesvo/contracts';
import { Button } from '@/shared/ui/button';

export function AlwaysAllowActions({
  pattern,
  enabled,
  onAllow,
}: {
  pattern: AllowPattern;
  enabled: boolean;
  onAllow: (scope: AllowScope) => void;
}) {
  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={!enabled}
        title={pattern.pattern}
        onClick={() => onAllow('session')}
      >
        Always allow in this session
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={!enabled}
        title={pattern.pattern}
        onClick={() => onAllow('project')}
      >
        Always allow in this project
      </Button>
    </>
  );
}
