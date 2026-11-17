import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/shared/ui/dialog';
import { EmptyState } from '@/shared/ui/empty-state';
import { IconButton } from '@/shared/ui/icon-button';
import { NavItem, NavList } from '@/shared/ui/nav-list';
import { SearchField } from '@/shared/ui/search-field';
import { SectionLabel } from '@/shared/ui/section-label';
import {
  matchesSettingsPage,
  settingsPages,
  type SettingsPage,
} from './settings-pages';

export type { SettingsPage } from './settings-pages';
export { AppearanceSettings } from './appearance-settings';
export { GeneralSettings } from './general-settings';

type Props = {
  page: SettingsPage;
  onPageChange: (page: SettingsPage) => void;
  onOpenChange: (open: boolean) => void;
  fallbackFocus?: RefObject<HTMLElement | null>;
  children: (
    page: SettingsPage,
    onBusyChange: (busy: boolean) => void,
  ) => ReactNode;
};

export function Settings({
  page,
  onPageChange,
  onOpenChange,
  fallbackFocus,
  children,
}: Props) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const search = useRef<HTMLInputElement>(null);
  const visible = settingsPages.filter(entry =>
    matchesSettingsPage(entry, query),
  );
  const groups = [...new Set(visible.map(entry => entry.group))];
  const current = settingsPages.find(entry => entry.id === page)!;
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!busy) onOpenChange(open);
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby="settings-description"
        onCloseAutoFocus={event => {
          const target = returnFocus?.isConnected
            ? returnFocus
            : fallbackFocus?.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
        onEscapeKeyDown={event => {
          if (query && document.activeElement === search.current) {
            event.preventDefault();
            setQuery('');
          }
        }}
        onKeyDown={event => {
          if (
            event.key === '/' &&
            !(event.target instanceof HTMLInputElement) &&
            !(event.target instanceof HTMLTextAreaElement)
          ) {
            event.preventDefault();
            search.current?.focus();
          }
        }}
        className="flex h-[min(50rem,calc(100dvh-2rem))] w-[min(66.5rem,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden bg-background p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription id="settings-description" className="sr-only">
          Nesvo settings for this desktop.
        </DialogDescription>
        <div className="flex w-44 shrink-0 flex-col border-r bg-card p-2 md:w-52">
          <SearchField
            ref={search}
            aria-label="Search settings"
            placeholder="Search"
            shortcut="/"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && visible[0] && !busy) {
                event.preventDefault();
                onPageChange(visible[0].id);
              }
            }}
            containerClassName="mb-1.5"
          />
          <NavList label="Settings sections">
            {groups.map(group => (
              <div key={group || 'main'} className="flex flex-col gap-0.5">
                {group && (
                  <SectionLabel as="p" className="mt-2">
                    {group}
                  </SectionLabel>
                )}
                {visible
                  .filter(entry => entry.group === group)
                  .map(entry => (
                    <NavItem
                      key={entry.id}
                      icon={<entry.icon aria-hidden="true" />}
                      selected={entry.id === page}
                      disabled={busy && entry.id !== page}
                      onClick={() => onPageChange(entry.id)}
                    >
                      {entry.label}
                    </NavItem>
                  ))}
              </div>
            ))}
            {visible.length === 0 && (
              <EmptyState size="sm" title="No matching settings" />
            )}
          </NavList>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-4">
            <nav aria-label="Settings breadcrumb" className="min-w-0 flex-1">
              <ol className="flex min-w-0 items-center gap-2 text-ui">
                <li className="text-muted-foreground">Settings</li>
                <li aria-hidden="true" className="text-muted-foreground/60">
                  /
                </li>
                <li aria-current="page" className="truncate font-semibold">
                  {current.label}
                </li>
              </ol>
            </nav>
            <DialogClose asChild>
              <IconButton
                label="Close settings"
                tooltip={false}
                disabled={busy}
              >
                <X />
              </IconButton>
            </DialogClose>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <section
              aria-label={current.label}
              className={cn(
                'mx-auto w-full px-6 py-7',
                current.wide ? 'max-w-6xl' : 'max-w-[44rem]',
              )}
            >
              {children(page, setBusy)}
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
