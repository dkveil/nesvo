import { cn } from '@/shared/lib/cn';
import { Input, type InputProps } from './input';
import { MiddleTruncatedText } from './middle-truncated-text';

type Props = Omit<InputProps, 'defaultValue' | 'value' | 'variant'> & {
  value: string;
  containerClassName?: string;
};

export function PathInput({
  value,
  className,
  containerClassName,
  size = 'sm',
  title,
  ...props
}: Props) {
  return (
    <div className={cn('group/path relative min-w-0', containerClassName)}>
      <Input
        {...props}
        size={size}
        value={value}
        title={title ?? (value || undefined)}
        className={cn(
          value && 'text-transparent focus:text-foreground',
          className,
        )}
      />
      {value && (
        <MiddleTruncatedText
          aria-hidden="true"
          value={value}
          path
          className={cn(
            'pointer-events-none absolute inset-y-0 right-0 left-0 items-center text-ui text-foreground group-focus-within/path:invisible',
            size === 'sm' ? 'px-2' : size === 'md' ? 'px-2.5' : 'px-3 text-sm',
            props.disabled && 'opacity-50',
            className?.includes('font-mono') && 'font-mono',
          )}
        />
      )}
    </div>
  );
}
