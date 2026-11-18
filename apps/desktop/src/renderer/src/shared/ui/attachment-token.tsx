import type { ComponentProps, ReactNode } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { FileTypeIcon } from '@/shared/ui/file-type-icon';
import { Spinner } from '@/shared/ui/spinner';

type AttachmentTokenProps = Omit<ComponentProps<'span'>, 'children'> & {
  name: string;
  kind?: 'image' | 'file';
  detail?: string;
  src?: string | null;
  status?: 'ready' | 'uploading' | 'failed';
  onOpen?: () => void;
  menu?: ReactNode;
};

const tokenClasses =
  'inline-flex h-5 max-w-60 min-w-0 items-center gap-1 rounded-control bg-muted px-1 align-text-bottom text-xs leading-4 select-none';
const interactiveClasses =
  'focus-ring press transition-[background-color,scale] duration-fast ease-out enabled:hover:bg-accent data-[state=open]:bg-accent';

export function AttachmentToken({
  name,
  kind = 'image',
  detail,
  src,
  status = 'ready',
  onOpen,
  menu,
  className,
  ...props
}: AttachmentTokenProps) {
  const description = [name, detail].filter(Boolean).join(', ');
  const content = (
    <>
      {status === 'uploading' ? (
        <Spinner />
      ) : kind === 'file' ? (
        <FileTypeIcon name={name} className="size-3.5" />
      ) : src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          className="size-3.5 shrink-0 rounded-sm object-cover"
        />
      ) : (
        <ImageIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      )}
      <span
        className={cn(
          'min-w-0 truncate font-medium text-foreground',
          status === 'failed' && 'text-error-foreground',
        )}
      >
        {name}
      </span>
      {detail && (
        <span className="shrink-0 text-2xs text-muted-foreground">
          {detail}
        </span>
      )}
    </>
  );
  if (menu && status !== 'uploading')
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-slot="attachment-token"
            data-status={status}
            data-kind={kind}
            aria-label={`File actions for ${description}`}
            className={cn(tokenClasses, interactiveClasses, className)}
            {...(props as ComponentProps<'button'>)}
          >
            {content}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">{menu}</DropdownMenuContent>
      </DropdownMenu>
    );
  if (onOpen && status !== 'uploading')
    return (
      <button
        type="button"
        data-slot="attachment-token"
        data-status={status}
        data-kind={kind}
        aria-label={`Open ${description}`}
        aria-haspopup="dialog"
        onClick={onOpen}
        className={cn(tokenClasses, interactiveClasses, className)}
        {...(props as ComponentProps<'button'>)}
      >
        {content}
      </button>
    );
  return (
    <span
      data-slot="attachment-token"
      data-status={status}
      data-kind={kind}
      role="img"
      aria-label={`${kind === 'file' ? 'File' : 'Image'} ${description}`}
      className={cn(tokenClasses, className)}
      {...props}
    >
      {content}
    </span>
  );
}

export type { AttachmentTokenProps };
