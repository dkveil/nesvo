import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { ChevronRight, Search, X } from 'lucide-react';
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
export { AboutSettings } from './about-settings';
export { AppearanceSettings } from './appearance-settings';
export { DataSettings } from './data-settings';
export { DefaultsSettings } from './defaults-settings';
export { NotificationsSettings } from './notifications-settings';
export { SharingSettings } from './sharing-settings';
export { GeneralSettings } from './general-settings';
export { KeyboardShortcutsSettings } from './keyboard-shortcuts-settings';

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
  const groups = [...new Set(settingsPages.map(entry => entry.group))];
  const searching = query.trim().length > 0 && !busy;
  const selectPage = (next: SettingsPage) => {
    setQuery('');
    onPageChange(next);
  };
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
        className="flex h-[min(54rem,calc(100dvh-2rem))] w-[min(72rem,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden bg-background p-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription id="settings-description" className="sr-only">
          Nesvo settings for this desktop.
        </DialogDescription>
        <div className="flex w-44 shrink-0 flex-col border-r p-2 md:w-52">
          <SearchField
            ref={search}
            aria-label="Search settings"
            placeholder="Search"
            shortcut="/"
            value={query}
            disabled={busy}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && visible[0] && !busy) {
                event.preventDefault();
                selectPage(visible[0].id);
              }
            }}
            containerClassName="mb-1.5"
          />
          <NavList
            label="Settings sections"
            className="min-h-0 flex-1 overflow-y-auto py-1 [scrollbar-gutter:stable]"
          >
            {groups.map(group => (
              <div key={group || 'main'} className="flex shrink-0 flex-col">
                {group && (
                  <SectionLabel as="p" className="mt-1">
                    {group}
                  </SectionLabel>
                )}
                {settingsPages
                  .filter(entry => entry.group === group)
                  .map(entry => (
                    <NavItem
                      key={entry.id}
                      tone="flat"
                      icon={<entry.icon aria-hidden="true" />}
                      selected={!searching && entry.id === page}
                      disabled={busy && entry.id !== page}
                      onClick={() => selectPage(entry.id)}
                    >
                      {entry.label}
                    </NavItem>
                  ))}
              </div>
            ))}
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
                <li aria-current="page" className="truncate font-medium">
                  {searching ? 'Search results' : current.label}
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
          <div
            hidden={searching}
            key={page}
            className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
          >
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
          <div
            hidden={!searching}
            className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
          >
            <section
              aria-label="Settings search results"
              className="mx-auto w-full max-w-[44rem] px-6 py-7"
            >
              {visible.length ? (
                <NavList
                  label="Matching settings"
                  className="divide-y rounded-none"
                >
                  {visible.map(entry => (
                    <NavItem
                      key={entry.id}
                      size="md"
                      icon={<entry.icon aria-hidden="true" />}
                      trailing={<ChevronRight aria-hidden="true" />}
                      onClick={() => selectPage(entry.id)}
                    >
                      {entry.label}
                    </NavItem>
                  ))}
                </NavList>
              ) : (
                <EmptyState
                  size="sm"
                  icon={Search}
                  title="No matching settings"
                  description="Try a page name or another keyword."
                />
              )}
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
