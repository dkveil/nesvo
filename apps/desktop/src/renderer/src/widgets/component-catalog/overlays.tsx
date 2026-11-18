import { useState } from 'react';
import {
  Bot,
  ChevronDown,
  Copy,
  FolderInput,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Trash2,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import { Chip } from '@/shared/ui/chip';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import {
  Dialog,
  DialogCancel,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/shared/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { IconButton } from '@/shared/ui/icon-button';
import { KeyCombo } from '@/shared/ui/kbd';
import { Combobox, Listbox, type ListboxOption } from '@/shared/ui/listbox';
import {
  menuItem,
  menuItemDestructive,
  menuLabel,
  menuSeparator,
  menuShortcut,
  menuSurface,
} from '@/shared/ui/menu-styles';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/shared/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';
import { CatalogSection, Specimen, StateCaption } from './specimen';

const MODEL_OPTIONS: ListboxOption<string>[] = [
  {
    value: 'large',
    label: 'Sample large model',
    description: 'Slower, more thorough',
    group: 'Provider A',
  },
  {
    value: 'small',
    label: 'Sample small model',
    description: 'Faster replies',
    group: 'Provider A',
  },
  { value: 'default', label: 'Sample default', group: 'Provider B' },
  {
    value: 'locked',
    label: 'Unavailable sample',
    group: 'Provider B',
    disabled: true,
  },
];

function StaticMenu() {
  return (
    <div
      className={cn(menuSurface, 'w-56')}
      data-state="open"
      role="presentation"
    >
      <div className={menuLabel}>Sample session</div>
      <div className={menuItem} data-highlighted="">
        <Pencil />
        Rename
        <span className={menuShortcut}>F2</span>
      </div>
      <div className={menuItem}>
        <FolderInput />
        Move to group
      </div>
      <div className={menuItem} data-disabled="">
        <Copy />
        Duplicate (disabled)
      </div>
      <div className={menuSeparator} />
      <div className={cn(menuItem, menuItemDestructive)}>
        <Trash2 />
        Delete session
      </div>
    </div>
  );
}

function LiveMenu() {
  const [wrap, setWrap] = useState(true);
  const [density, setDensity] = useState('compact');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Open sample menu">
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Sample menu</DropdownMenuLabel>
        <DropdownMenuItem>
          <Pencil />
          Rename
          <DropdownMenuShortcut>F2</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuCheckboxItem
          checked={wrap}
          onCheckedChange={value => setWrap(value === true)}
        >
          Wrap lines
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={density} onValueChange={setDensity}>
          <DropdownMenuRadioItem value="compact">Compact</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="comfortable">
            Comfortable
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <FolderInput />
            Move to
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            <DropdownMenuItem>Sample group</DropdownMenuItem>
            <DropdownMenuItem>Ungrouped</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem variant="destructive">
          <Trash2 />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PickerSpecimens() {
  const [model, setModel] = useState('large');
  const [preview, setPreview] = useState<string | null>(null);
  const label =
    MODEL_OPTIONS.find(option => option.value === model)?.label ?? 'Model';
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <StateCaption label="Listbox · searchable, keyboard: ↑ ↓ Home End Enter">
        <div className="h-64 w-72 overflow-hidden rounded-surface border bg-popover">
          <Listbox
            label="Models"
            searchable
            options={MODEL_OPTIONS}
            value={model}
            onSelect={setModel}
          />
        </div>
      </StateCaption>
      <StateCaption label="Listbox · highlighted option reported beside it">
        <div className="flex h-40 w-80 overflow-hidden rounded-surface border bg-popover">
          <Listbox
            label="Models (preview)"
            options={MODEL_OPTIONS}
            value={model}
            onSelect={setModel}
            onActiveChange={setPreview}
            className="flex-1"
          />
          <p className="w-28 shrink-0 border-l p-3 text-2xs text-muted-foreground">
            {MODEL_OPTIONS.find(option => option.value === preview)?.label ??
              'None'}
          </p>
        </div>
      </StateCaption>
      <StateCaption label="Combobox · Chip trigger">
        <Combobox
          label="Models"
          options={MODEL_OPTIONS}
          value={model}
          onSelect={setModel}
          trigger={
            <Chip icon={<Bot />}>
              <span>{label}</span>
              <ChevronDown />
            </Chip>
          }
        />
      </StateCaption>
    </div>
  );
}

const SAMPLE_CONFIRM_DELAY_MS = 900;

function ConfirmSpecimens() {
  const [open, setOpen] = useState<'destructive' | 'default' | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        aria-haspopup="dialog"
        onClick={() => setOpen('destructive')}
      >
        Remove sample computer
      </Button>
      <Button
        variant="outline"
        aria-haspopup="dialog"
        onClick={() => setOpen('default')}
      >
        Confirm sample action
      </Button>
      <ConfirmDialog
        open={open === 'destructive'}
        onOpenChange={next => setOpen(next ? 'destructive' : null)}
        title="Remove sample computer?"
        description="Nesvo forgets this computer. Work on it keeps running."
        confirmLabel="Remove computer"
        pendingLabel="Removing…"
        onConfirm={() =>
          new Promise(resolve =>
            window.setTimeout(resolve, SAMPLE_CONFIRM_DELAY_MS),
          )
        }
      />
      <ConfirmDialog
        open={open === 'default'}
        onOpenChange={next => setOpen(next ? 'default' : null)}
        tone="default"
        title="Start the sample run now?"
        description="The run starts outside its schedule."
        confirmLabel="Run now"
        onConfirm={() => undefined}
      />
    </div>
  );
}

export function OverlaysSection() {
  return (
    <CatalogSection
      id="overlays"
      title="Overlays"
      description="Tooltips, popovers, menus, pickers, dialogs and sheets. Menus, Select and Listbox share one item spec: 28px, 13px text, control radius, accent highlight."
    >
      <Specimen title="Tooltip" source="shared/ui/tooltip.tsx">
        <div className="flex flex-wrap items-center gap-x-24 gap-y-6 pt-9 pb-9">
          <Tooltip open>
            <TooltipTrigger asChild>
              <Button variant="outline">Label tooltip</Button>
            </TooltipTrigger>
            <TooltipContent side="top" hideWhenDetached>
              Copy path
            </TooltipContent>
          </Tooltip>
          <Tooltip open>
            <TooltipTrigger asChild>
              <IconButton label="Toggle sidebar" tooltip={false}>
                <PanelLeft />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent side="bottom" shortcut="Ctrl B" hideWhenDetached>
              Toggle sidebar
            </TooltipContent>
          </Tooltip>
          <Tooltip open>
            <TooltipTrigger asChild>
              <Button variant="ghost">Panel tooltip</Button>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              variant="panel"
              className="w-56"
              hideWhenDetached
            >
              Panel tooltips hold a short explanation, such as when a sample
              limit resets.
            </TooltipContent>
          </Tooltip>
        </div>
        <p className="text-2xs text-muted-foreground">
          Hover any IconButton for its label · <KeyCombo keys="Tab" /> focus
          shows it, programmatic focus does not
        </p>
      </Specimen>
      <Specimen title="Popover" source="surface glass · solid · card">
        <div className="flex flex-wrap items-center gap-2">
          {(['glass', 'solid', 'card'] as const).map(surface => (
            <Popover key={surface}>
              <PopoverTrigger asChild>
                <Button variant="outline">{surface}</Button>
              </PopoverTrigger>
              <PopoverContent surface={surface} size="sm" align="start">
                <p className="text-ui font-medium">Sample {surface} popover</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Size presets replace hand-written width and max-height
                  formulas.
                </p>
              </PopoverContent>
            </Popover>
          ))}
        </div>
      </Specimen>
      <Specimen title="DropdownMenu" source="shared/ui/dropdown-menu.tsx">
        <div className="flex flex-wrap items-start gap-6">
          <StateCaption label="static preview · highlighted · disabled · destructive">
            <StaticMenu />
          </StateCaption>
          <StateCaption label="live · checkbox, radio, submenu">
            <LiveMenu />
          </StateCaption>
        </div>
      </Specimen>
      <Specimen title="Listbox and Combobox" source="shared/ui/listbox.tsx">
        <PickerSpecimens />
      </Specimen>
      <Specimen title="ConfirmDialog" source="shared/ui/confirm-dialog.tsx">
        <ConfirmSpecimens />
      </Specimen>
      <Specimen title="Dialog and Sheet" source="dialog.tsx · sheet.tsx">
        <div className="flex flex-wrap items-center gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Open dialog</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>Delete sample group?</DialogTitle>
                <DialogDescription>
                  Sessions move to the parent group. Nothing is deleted.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <DialogCancel />
                </DialogClose>
                <DialogClose asChild>
                  <Button variant="destructive" size="lg">
                    Delete group
                  </Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Open top dialog</Button>
            </DialogTrigger>
            <DialogContent
              placement="top"
              showCloseButton={false}
              className="gap-0 overflow-hidden p-0 sm:max-w-xl"
            >
              <DialogTitle className="sr-only">Sample palette</DialogTitle>
              <DialogDescription className="px-4 py-3">
                placement=&quot;top&quot; keeps a palette anchored while its
                results change.
              </DialogDescription>
            </DialogContent>
          </Dialog>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">Open sheet</Button>
            </SheetTrigger>
            <SheetContent className="sm:max-w-md">
              <SheetHeader>
                <SheetTitle>Sample sheet</SheetTitle>
                <SheetDescription>
                  Sheets share the dialog overlay and a bordered header.
                </SheetDescription>
              </SheetHeader>
              <div className="flex-1 px-5 py-4 text-xs text-muted-foreground">
                Body content.
              </div>
              <SheetFooter>
                <Button variant="ghost" size="md">
                  Cancel
                </Button>
                <Button size="md">Save</Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        </div>
      </Specimen>
    </CatalogSection>
  );
}
