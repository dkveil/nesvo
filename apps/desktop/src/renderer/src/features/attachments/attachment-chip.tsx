import type { ComponentProps } from 'react';
import { FileText, Image as ImageIcon, X } from 'lucide-react';
import { cn } from 'cn';
import type { MessageAttachment } from '@nesvo/contracts';
import { Button } from '@/shared/ui/button';
import { formatBytes } from './paste-and-drop';

export type AttachmentChipProps = ComponentProps<'div'> & {
  attachment: MessageAttachment;
  thumbnail?: string | null;
  onOpen?: () => void;
  onRemove?: () => void;
};

export const AttachmentChip = ({
  attachment,
  thumbnail,
  onOpen,
  onRemove,
  className,
  ...props
}: AttachmentChipProps) => {
  const size = formatBytes(attachment.bytes);
  const Icon = attachment.kind === 'image' ? ImageIcon : FileText;
  return (
    <div
      data-attachment-id={attachment.id}
      className={cn(
        'inline-flex h-7 max-w-56 min-w-0 items-center gap-1 rounded-md border bg-secondary/60 pr-0.5 pl-1 text-xs',
        !onRemove && 'pr-1.5',
        className,
      )}
      {...props}
    >
      <button
        type="button"
        aria-label={`Open ${attachment.name}`}
        title={`${attachment.name} · ${size}`}
        disabled={!onOpen}
        onClick={onOpen}
        className="flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-0.5 transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none enabled:hover:text-foreground disabled:cursor-default"
      >
        {thumbnail ? (
          <img
            src={thumbnail}
            alt=""
            className="size-5 shrink-0 rounded-sm object-cover"
          />
        ) : (
          <Icon
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 truncate">{attachment.name}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {size}
        </span>
      </button>
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Remove ${attachment.name}`}
          onClick={onRemove}
          className="size-6 shrink-0 rounded-sm text-muted-foreground"
        >
          <X className="size-3" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
};
