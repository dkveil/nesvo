import type { ComponentProps, ReactNode } from 'react';
import { Plus, type LucideIcon } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

type AddTileProps = Omit<ComponentProps<'button'>, 'title' | 'children'> & {
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
};

export function AddTile({
  title,
  description,
  icon: Icon = Plus,
  type = 'button',
  className,
  ...props
}: AddTileProps) {
  return (
    <button
      type={type}
      data-slot="add-tile"
      className={cn(
        'focus-ring flex min-h-14 items-center gap-3 rounded-overlay border border-dashed border-input bg-card/40 py-2 pr-3 pl-2 text-left text-muted-foreground transition-[border-color,color,background-color] duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-50 enabled:hover:border-foreground/40 enabled:hover:bg-card enabled:hover:text-foreground data-preview-hover:border-foreground/40 data-preview-hover:bg-card data-preview-hover:text-foreground',
        className,
      )}
      {...props}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-surface border border-dashed border-current/40">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-ui font-medium">{title}</span>
        {description && (
          <span className="block text-2xs leading-4">{description}</span>
        )}
      </span>
    </button>
  );
}
