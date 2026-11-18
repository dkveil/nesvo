import type { ComponentProps } from 'react';
import { ImageOff, X } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { IconButton } from '@/shared/ui/icon-button';
import { Spinner } from '@/shared/ui/spinner';
import { Hint } from '@/shared/ui/tooltip';

type AttachmentChipProps = ComponentProps<'div'> & {
  name: string;
  src?: string | null;
  status?: 'ready' | 'uploading' | 'failed';
  detail?: string;
  size?: 'sm' | 'md';
  onOpen?: () => void;
  onRemove?: () => void;
};

export function AttachmentChip({
  name,
  src,
  status = 'ready',
  detail,
  size = 'sm',
  onOpen,
  onRemove,
  className,
  ...props
}: AttachmentChipProps) {
  const description = [name, detail].filter(Boolean).join(' · ');
  const preview = src ? (
    <img
      src={src}
      alt=""
      draggable={false}
      className={cn(
        'size-full object-cover transition-opacity duration-base',
        status === 'uploading' && 'opacity-50',
      )}
    />
  ) : (
    <ImageOff aria-hidden="true" className="size-4 text-muted-foreground" />
  );
  return (
    <div
      data-slot="attachment-chip"
      data-status={status}
      className={cn(
        'group/attachment relative shrink-0',
        size === 'sm' && 'size-12',
        size === 'md' && 'size-20',
        className,
      )}
      {...props}
    >
      <Hint label={description}>
        {onOpen && status !== 'uploading' ? (
          <button
            type="button"
            aria-label={`Open ${description}`}
            aria-haspopup="dialog"
            onClick={onOpen}
            className={cn(
              'focus-ring press flex size-full items-center justify-center overflow-hidden rounded-control border bg-muted transition-[border-color,scale] duration-fast ease-out enabled:hover:border-input',
              status === 'failed' && 'border-error-foreground',
            )}
          >
            {preview}
          </button>
        ) : (
          <div
            role="img"
            aria-label={description}
            className={cn(
              'flex size-full items-center justify-center overflow-hidden rounded-control border bg-muted',
              status === 'failed' && 'border-error-foreground',
            )}
          >
            {preview}
          </div>
        )}
      </Hint>
      {status === 'uploading' && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner size="md" label={`Uploading ${name}`} />
        </span>
      )}
      {onRemove && (
        <IconButton
          label={`Remove ${name}`}
          size={16}
          shape="round"
          tooltip={false}
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 border bg-card text-foreground"
        >
          <X />
        </IconButton>
      )}
    </div>
  );
}

export type { AttachmentChipProps };
