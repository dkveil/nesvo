import { cn } from 'cn';
import { edgeWhenLabels } from '@/entities/pipeline-graph';
import { Button } from '@/shared/ui/button';
import type { EdgeInspectorProps, EdgeWhen } from './index';

const options: EdgeWhen[] = ['success', 'failure', 'any'];

export function EdgeInspectorPlaceholder({
  edge,
  sourceType,
  onChange,
  onDelete,
}: EdgeInspectorProps) {
  return (
    <div className="space-y-3 p-3 text-xs">
      <p className="font-mono [overflow-wrap:anywhere]">
        {edge.from} → {edge.to}
      </p>
      <div role="group" aria-label="Condition" className="flex gap-1">
        {options.map(option => {
          const blocked = sourceType === 'human' && option === 'failure';
          return (
            <Button
              key={option}
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={edge.when === option}
              disabled={blocked}
              title={
                blocked
                  ? 'Human decisions are not routed on failure'
                  : undefined
              }
              className={cn(
                'h-7 flex-1',
                edge.when === option && 'bg-highlight text-foreground',
              )}
              onClick={() => onChange(option)}
            >
              {edgeWhenLabels[option]}
            </Button>
          );
        })}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onDelete}>
        Remove connection
      </Button>
    </div>
  );
}
