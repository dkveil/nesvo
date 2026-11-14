import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Textarea } from '@/shared/ui/textarea';
import type { StepInspectorProps } from './index';

export function StepInspectorPlaceholder({
  step,
  mode,
  onChange,
}: StepInspectorProps) {
  return (
    <div className="space-y-3 p-3">
      <div className="space-y-1">
        <Label htmlFor="step-inspector-name" className="text-2xs">
          Name
        </Label>
        <Input
          id="step-inspector-name"
          value={step.name}
          readOnly={mode === 'edit'}
          onChange={event => onChange({ ...step, name: event.target.value })}
          className="h-8 text-xs md:text-xs"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="step-inspector-body" className="text-2xs">
          Instructions
        </Label>
        <Textarea
          id="step-inspector-body"
          value={step.body}
          rows={8}
          onChange={event => onChange({ ...step, body: event.target.value })}
          className="font-mono text-xs md:text-xs"
        />
      </div>
    </div>
  );
}
