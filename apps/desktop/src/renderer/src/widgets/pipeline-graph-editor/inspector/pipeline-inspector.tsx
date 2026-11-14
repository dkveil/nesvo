import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Textarea } from '@/shared/ui/textarea';
import type { PipelineInspectorProps } from './index';

export function PipelineInspectorPlaceholder({
  name,
  description,
  body,
  mode,
  onChange,
}: PipelineInspectorProps) {
  const fields = { name, description, body };
  return (
    <div className="space-y-3 p-3">
      <div className="space-y-1">
        <Label htmlFor="pipeline-inspector-name" className="text-2xs">
          Name
        </Label>
        <Input
          id="pipeline-inspector-name"
          value={name}
          readOnly={mode === 'edit'}
          onChange={event => onChange({ ...fields, name: event.target.value })}
          className="h-8 text-xs md:text-xs"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="pipeline-inspector-description" className="text-2xs">
          Description
        </Label>
        <Textarea
          id="pipeline-inspector-description"
          value={description}
          rows={3}
          onChange={event =>
            onChange({ ...fields, description: event.target.value })
          }
          className="text-xs md:text-xs"
        />
      </div>
    </div>
  );
}
