import type { ComponentProps, ReactNode } from 'react';
import { ImageOff, X } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { fileExtension } from '@/shared/lib/file-category';
import { FileTypeIcon } from '@/shared/ui/file-type-icon';
import { IconButton } from '@/shared/ui/icon-button';
import { Spinner } from '@/shared/ui/spinner';
import { Hint } from '@/shared/ui/tooltip';

type AttachmentChipProps = ComponentProps<'div'> & {
  name: string;
  kind?: 'image' | 'file';
  src?: string | null;
  status?: 'ready' | 'uploading' | 'failed';
  detail?: string;
  size?: 'sm' | 'md';
  onOpen?: () => void;
  menu?: ReactNode;
  onRemove?: () => void;
};

const tileClasses =
  'flex size-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-control border bg-muted';

export function AttachmentChip({
  name,
  kind = 'image',
  src,
  status = 'ready',
  detail,
  size = 'sm',
  onOpen,
  menu,
  onRemove,
  className,
  ...props
}: AttachmentChipProps) {
  const description = [name, detail].filter(Boolean).join(' · ');
  const extension = fileExtension(name);
  const preview =
    kind === 'file' ? (
      <>
        <FileTypeIcon
          name={name}
          className={cn(size === 'sm' ? 'size-4' : 'size-6')}
        />
        {extension && (
          <span
            className={cn(
              'max-w-full truncate px-1 font-medium text-muted-foreground uppercase',
              size === 'sm' ? 'text-micro' : 'text-2xs',
              status === 'uploading' && 'opacity-50',
            )}
          >
            {extension}
          </span>
        )}
      </>
    ) : src ? (
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
  const interactive = status !== 'uploading' && (onOpen || menu);
  const buttonClasses = cn(
    tileClasses,
    'focus-ring press transition-[border-color,scale] duration-fast ease-out enabled:hover:border-input data-[state=open]:border-input',
    status === 'failed' && 'border-error-foreground',
  );
  return (
    <div
      data-slot="attachment-chip"
      data-status={status}
      data-kind={kind}
      className={cn(
        'group/attachment relative shrink-0',
        size === 'sm' && 'size-12',
        size === 'md' && 'size-20',
        className,
      )}
      {...props}
    >
      {interactive && menu ? (
        <DropdownMenu>
          <Hint label={description}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`File actions for ${description}`}
                className={buttonClasses}
              >
                {preview}
              </button>
            </DropdownMenuTrigger>
          </Hint>
          <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Hint label={description}>
          {interactive && onOpen ? (
            <button
              type="button"
              aria-label={`Open ${description}`}
              aria-haspopup="dialog"
              onClick={onOpen}
              className={buttonClasses}
            >
              {preview}
            </button>
          ) : (
            <div
              role="img"
              aria-label={description}
              className={cn(
                tileClasses,
                status === 'failed' && 'border-error-foreground',
              )}
            >
              {preview}
            </div>
          )}
        </Hint>
      )}
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
