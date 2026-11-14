import type { StartInspectorProps } from './index';

export function StartInspectorPlaceholder({
  pipelineName,
  automations,
}: StartInspectorProps) {
  return (
    <div className="space-y-2 p-3 text-xs text-muted-foreground">
      <p>New thread starts {pipelineName || 'this pipeline'} manually.</p>
      <p>
        {automations.length === 0
          ? 'No automation starts this pipeline.'
          : `${automations.length} automation${automations.length === 1 ? '' : 's'} start this pipeline.`}
      </p>
    </div>
  );
}
