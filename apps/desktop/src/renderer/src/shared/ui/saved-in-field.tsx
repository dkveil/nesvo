import type { ComponentProps } from 'react';
import { definitionScopeSchema, type DefinitionScope } from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';
import { savedInHint, savedInLabels } from '@/shared/lib/saved-in';
import { Field } from './field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select';

type Props = Pick<
  ComponentProps<typeof Field>,
  'id' | 'layout' | 'className'
> & {
  scope: DefinitionScope;
  onChange?: (scope: DefinitionScope) => void;
  disabled?: boolean;
  projectDisabled?: boolean;
  projectPath?: string;
  size?: ComponentProps<typeof SelectTrigger>['size'];
  triggerClassName?: string;
};

export function SavedInField({
  id,
  layout,
  className,
  scope,
  onChange,
  disabled,
  projectDisabled,
  projectPath,
  size,
  triggerClassName,
}: Props) {
  const hint = savedInHint(scope, projectPath);
  const inline = layout === 'inline';
  const field = (
    <Field
      id={id}
      label="Saved in"
      layout={layout}
      className={className}
      hint={inline ? undefined : hint}
    >
      <Select
        value={scope}
        disabled={disabled || !onChange}
        onValueChange={value => onChange?.(definitionScopeSchema.parse(value))}
      >
        <SelectTrigger
          id={id}
          size={size}
          className={cn('w-full', triggerClassName)}
          aria-describedby={`${id}-hint`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="project" disabled={projectDisabled}>
            {savedInLabels.project}
          </SelectItem>
          <SelectItem value="global">{savedInLabels.global}</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  );
  return inline ? (
    <div className="space-y-1">
      {field}
      <p
        id={`${id}-hint`}
        className="text-2xs leading-4 text-subtle-foreground"
      >
        {hint}
      </p>
    </div>
  ) : (
    field
  );
}
