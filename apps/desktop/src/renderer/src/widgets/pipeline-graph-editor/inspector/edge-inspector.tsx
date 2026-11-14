import { Button } from '@/shared/ui/button';
import type { EdgeInspectorProps } from './index';

export function EdgeInspectorPlaceholder({
  edge,
  onDelete,
}: EdgeInspectorProps) {
  return (
    <div className="space-y-3 p-3 text-xs">
      <p className="font-mono">
        {edge.from} → {edge.to} on {edge.when}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onDelete}>
        Remove connection
      </Button>
    </div>
  );
}
