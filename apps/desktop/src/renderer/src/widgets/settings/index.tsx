import { useRef, useState, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/shared/ui/dialog';
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
  children: (page: SettingsPage) => ReactNode;
};

export function Settings({
  page,
  onPageChange,
  onOpenChange,
  children,
}: Props) {
  const [query, setQuery] = useState('');
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
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby="settings-description"
        onCloseAutoFocus={event => {
          if (!returnFocus?.isConnected) return;
          event.preventDefault();
          returnFocus.focus();
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
        <nav
          aria-label="Settings sections"
          className="flex w-44 shrink-0 flex-col gap-0.5 border-r bg-card p-2 md:w-52"
        >
          <div className="mb-1.5 flex h-8 items-center gap-2 rounded-md px-2 text-muted-foreground transition-colors duration-100 focus-within:bg-accent focus-within:ring-1 focus-within:ring-ring/70 focus-within:ring-inset hover:bg-accent">
            <Search className="size-3.5 shrink-0" aria-hidden="true" />
            <input
              ref={search}
              type="search"
              aria-label="Search settings"
              placeholder="Search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && visible[0]) {
                  event.preventDefault();
                  onPageChange(visible[0].id);
                }
                if (event.key === 'Escape' && query) {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery('');
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            />
            <kbd className="rounded-sm border px-1 font-sans text-2xs leading-4 text-muted-foreground">
              /
            </kbd>
          </div>
          {groups.map(group => (
            <div key={group || 'main'} className="flex flex-col gap-0.5">
              {group && (
                <p className="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">
                  {group}
                </p>
              )}
              {visible
                .filter(entry => entry.group === group)
                .map(entry => (
                  <button
                    key={entry.id}
                    type="button"
                    aria-current={entry.id === page ? 'page' : undefined}
                    onClick={() => onPageChange(entry.id)}
                    className={cn(
                      'flex h-7.5 items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground transition-colors duration-100 outline-none',
                      'hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
                      'aria-[current=page]:bg-highlight aria-[current=page]:font-medium aria-[current=page]:text-foreground',
                    )}
                  >
                    <entry.icon
                      className="size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="truncate">{entry.label}</span>
                  </button>
                ))}
            </div>
          ))}
          {visible.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No matching settings
            </p>
          )}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-4">
            <nav aria-label="Settings breadcrumb" className="min-w-0 flex-1">
              <ol className="flex min-w-0 items-center gap-2 text-[13px]">
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
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground hover:text-foreground"
                aria-label="Close settings"
              >
                <X className="size-4" />
              </Button>
            </DialogClose>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <section
              aria-label={current.label}
              className="mx-auto w-full max-w-[44rem] px-6 py-7"
            >
              {children(page)}
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
