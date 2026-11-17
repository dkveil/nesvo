import {
  ArrowUp,
  Bot,
  ChevronDown,
  Copy,
  Folder,
  ListEnd,
  MoreHorizontal,
  PanelLeft,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { Chip } from '@/shared/ui/chip';
import { IconButton } from '@/shared/ui/icon-button';
import { Spinner } from '@/shared/ui/spinner';
import {
  CatalogSection,
  Specimen,
  SpecimenRow,
  StateCaption,
} from './specimen';

const VARIANTS = [
  'default',
  'secondary',
  'outline',
  'ghost',
  'destructive',
  'link',
] as const;

const SIZES = ['xs', 'sm', 'md', 'lg'] as const;

const ICON_SIZES = [16, 20, 24, 28, 32] as const;

export function ActionsSection() {
  return (
    <CatalogSection
      id="actions"
      title="Actions"
      description="Button for labelled commands, IconButton for glyph-only commands with a built-in tooltip, Chip for compact composer and filter triggers."
    >
      <Specimen title="Button · variants" source="shared/ui/button.tsx">
        <SpecimenRow label="sm (default)">
          {VARIANTS.map(variant => (
            <Button key={variant} variant={variant}>
              {variant === 'destructive' ? 'Delete group' : 'Save changes'}
            </Button>
          ))}
        </SpecimenRow>
        <SpecimenRow label="with icon">
          <Button>
            <Plus />
            New session
          </Button>
          <Button variant="outline">
            <RefreshCw />
            Refresh
          </Button>
          <Button variant="ghost">
            <Copy />
            Copy path
          </Button>
        </SpecimenRow>
      </Specimen>
      <Specimen title="Button · sizes" source="xs 24 · sm 28 · md 32 · lg 36">
        {SIZES.map(size => (
          <SpecimenRow key={size} label={size}>
            <Button size={size}>Primary</Button>
            <Button size={size} variant="outline">
              Outline
            </Button>
            <Button size={size} variant="ghost">
              Ghost
            </Button>
          </SpecimenRow>
        ))}
      </Specimen>
      <Specimen
        title="Button · states"
        source="hover · focus · pressed · selected · disabled · loading"
      >
        {(['default', 'outline', 'ghost'] as const).map(variant => (
          <SpecimenRow key={variant} label={variant} className="gap-3">
            <StateCaption label="rest">
              <Button variant={variant}>Run check</Button>
            </StateCaption>
            <StateCaption label="hover">
              <Button variant={variant} data-preview-hover="">
                Run check
              </Button>
            </StateCaption>
            <StateCaption label="focus">
              <Button variant={variant} data-preview-focus="">
                Run check
              </Button>
            </StateCaption>
            <StateCaption label="pressed">
              <Button variant={variant} data-preview-active="">
                Run check
              </Button>
            </StateCaption>
            {variant === 'ghost' && (
              <StateCaption label="selected">
                <Button variant={variant} selected>
                  Run check
                </Button>
              </StateCaption>
            )}
            <StateCaption label="disabled">
              <Button variant={variant} disabled>
                Run check
              </Button>
            </StateCaption>
            <StateCaption label="loading">
              <Button variant={variant} disabled>
                <Spinner className="text-current" />
                Checking…
              </Button>
            </StateCaption>
          </SpecimenRow>
        ))}
      </Specimen>
      <Specimen title="IconButton" source="shared/ui/icon-button.tsx">
        <SpecimenRow label="sizes">
          {ICON_SIZES.map(size => (
            <StateCaption key={size} label={`${size}`}>
              <IconButton label={`More actions (${size}px)`} size={size}>
                <MoreHorizontal />
              </IconButton>
            </StateCaption>
          ))}
        </SpecimenRow>
        <SpecimenRow label="states" className="gap-4">
          <StateCaption label="rest">
            <IconButton label="Copy">
              <Copy />
            </IconButton>
          </StateCaption>
          <StateCaption label="hover">
            <IconButton label="Copy" data-preview-hover="">
              <Copy />
            </IconButton>
          </StateCaption>
          <StateCaption label="focus">
            <IconButton label="Copy" data-preview-focus="">
              <Copy />
            </IconButton>
          </StateCaption>
          <StateCaption label="pressed">
            <IconButton label="Toggle sidebar" pressed>
              <PanelLeft />
            </IconButton>
          </StateCaption>
          <StateCaption label="expanded">
            <IconButton label="Menu" aria-expanded>
              <MoreHorizontal />
            </IconButton>
          </StateCaption>
          <StateCaption label="disabled">
            <IconButton label="Copy" disabled>
              <Copy />
            </IconButton>
          </StateCaption>
        </SpecimenRow>
        <SpecimenRow label="tones" className="gap-4">
          <StateCaption label="default">
            <IconButton label="Refresh" data-preview-hover="">
              <RefreshCw />
            </IconButton>
          </StateCaption>
          <div className="rounded-control bg-sidebar p-1">
            <StateCaption label="sidebar">
              <IconButton
                label="New session"
                tone="sidebar"
                data-preview-hover=""
              >
                <Plus />
              </IconButton>
            </StateCaption>
          </div>
          <StateCaption label="danger">
            <IconButton label="Remove" tone="danger" data-preview-hover="">
              <Trash2 />
            </IconButton>
          </StateCaption>
          <StateCaption label="round">
            <IconButton label="Collapse" shape="round" data-preview-hover="">
              <ChevronDown />
            </IconButton>
          </StateCaption>
        </SpecimenRow>
        <SpecimenRow label="send" className="gap-4">
          <StateCaption label="ready">
            <IconButton label="Send message" appearance="send">
              <ArrowUp />
            </IconButton>
          </StateCaption>
          <StateCaption label="idle (disabled)">
            <IconButton label="Send message" appearance="send" disabled>
              <ArrowUp />
            </IconButton>
          </StateCaption>
          <StateCaption label="queue">
            <IconButton label="Queue message" appearance="send">
              <ListEnd />
            </IconButton>
          </StateCaption>
        </SpecimenRow>
      </Specimen>
      <Specimen title="Chip" source="shared/ui/chip.tsx">
        <SpecimenRow label="md (h-7)" className="gap-1">
          <Chip icon={<Bot />}>
            <span>Sample model</span>
            <ChevronDown />
          </Chip>
          <Chip icon={<Folder />} data-preview-hover="">
            <span>sample-project</span>
          </Chip>
          <Chip icon={<Folder />} data-preview-focus="">
            <span>focused</span>
          </Chip>
          <Chip selected>
            <span>Selected</span>
          </Chip>
          <Chip disabled>
            <span>Disabled</span>
          </Chip>
        </SpecimenRow>
        <SpecimenRow label="sm (h-6)" className="gap-1">
          <Chip size="sm" icon={<Folder />}>
            <span>a-very-long-folder-name-that-truncates-inside-the-chip</span>
          </Chip>
          <Chip size="sm" interactive={false} icon={<Bot />}>
            <span>Static chip</span>
          </Chip>
        </SpecimenRow>
      </Specimen>
    </CatalogSection>
  );
}
