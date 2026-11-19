import {
  createContext,
  useContext,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { ArrowUp } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { IconButton } from '@/shared/ui/icon-button';
import { Spinner } from '@/shared/ui/spinner';

type ComposerVariant = 'default' | 'compact';

const ComposerVariantContext = createContext<ComposerVariant>('default');

type ComposerProps = ComponentProps<'div'> & { variant?: ComposerVariant };

export function Composer({
  variant = 'default',
  className,
  ...props
}: ComposerProps) {
  return (
    <ComposerVariantContext.Provider value={variant}>
      <div
        data-slot="composer"
        data-variant={variant}
        className={cn(
          'glass-composer relative border transition-colors duration-base focus-within:border-input',
          variant === 'default' && 'rounded-composer px-3 pt-3 pb-2',
          variant === 'compact' && 'rounded-overlay px-3 pt-2.5 pb-2',
          className,
        )}
        {...props}
      />
    </ComposerVariantContext.Provider>
  );
}

export function ComposerInput({
  className,
  rows = 1,
  ...props
}: ComponentProps<'textarea'>) {
  const variant = useContext(ComposerVariantContext);
  return (
    <textarea
      data-slot="composer-input"
      rows={rows}
      className={cn(
        'block field-sizing-content w-full resize-none bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'default' && 'max-h-48 min-h-11 px-1 text-ui leading-5',
        variant === 'compact' && 'max-h-60 min-h-10 px-0.5 text-ui',
        className,
      )}
      {...props}
    />
  );
}

type ComposerToolbarProps = {
  start?: ReactNode;
  end?: ReactNode;
  className?: string;
  containerClassName?: string;
};

export function ComposerToolbar({
  start,
  end,
  className,
  containerClassName,
}: ComposerToolbarProps) {
  const variant = useContext(ComposerVariantContext);
  return (
    <div
      data-slot="composer-toolbar"
      className={cn(
        'flex min-w-0 items-center justify-between gap-3',
        variant === 'default' ? 'pt-1' : 'mt-1.5',
        containerClassName,
      )}
    >
      <div
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1 text-2xs text-muted-foreground',
          className,
        )}
      >
        {start}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{end}</div>
    </div>
  );
}

type ComposerSendProps = Omit<
  ComponentProps<typeof IconButton>,
  'label' | 'appearance' | 'shape'
> & {
  label?: string;
  pending?: boolean;
};

export function ComposerSend({
  label = 'Send message',
  pending = false,
  type = 'submit',
  children,
  ...props
}: ComposerSendProps) {
  return (
    <IconButton
      type={type}
      label={pending ? 'Sending' : label}
      appearance="send"
      shape="round"
      size={28}
      {...props}
    >
      {pending ? (
        <Spinner className="size-4 text-current" />
      ) : (
        (children ?? <ArrowUp />)
      )}
    </IconButton>
  );
}
