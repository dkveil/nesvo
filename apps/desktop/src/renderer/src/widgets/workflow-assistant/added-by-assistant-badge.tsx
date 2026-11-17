import { Badge } from '@/shared/ui/badge';
import { Hint } from '@/shared/ui/tooltip';

export function AddedByAssistantBadge() {
  return (
    <Hint label="Added by the assistant">
      <Badge data-added-by-assistant tone="info" appearance="outline" size="xs">
        Assistant
      </Badge>
    </Hint>
  );
}
