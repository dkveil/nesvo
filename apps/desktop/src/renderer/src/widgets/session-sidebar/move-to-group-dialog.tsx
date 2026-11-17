import { useState } from 'react';
import { Check, FolderPlus, Inbox } from 'lucide-react';
import type { SessionGroup } from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Input } from '@/shared/ui/input';
import { groupDepth, groupPath, orderedGroups } from './session-tree';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  groups: SessionGroup[];
  currentId: string | null;
  rootLabel: string;
  isAllowed: (group: SessionGroup) => boolean;
  onMove: (groupId: string | null) => void;
  onCreate?: (name: string) => void;
};

const optionClass =
  'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none hover:bg-accent focus-visible:bg-accent disabled:cursor-not-allowed disabled:opacity-50';

export function MoveToGroupDialog({
  open,
  onOpenChange,
  title,
  groups,
  currentId,
  rootLabel,
  isAllowed,
  onMove,
  onCreate,
}: Props) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const options = orderedGroups(groups).filter(
    group =>
      !needle || groupPath(group, groups).toLocaleLowerCase().includes(needle),
  );
  const choose = (groupId: string | null) => {
    onOpenChange(false);
    onMove(groupId);
  };
  const create = () => {
    const name = query.trim();
    if (!name || !onCreate) return;
    onOpenChange(false);
    onCreate(name.slice(0, 80));
  };
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next) setQuery('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="gap-3 sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription className="text-xs">
            {onCreate
              ? 'Search for a group or type a name to create one.'
              : 'Search for a group.'}
          </DialogDescription>
        </DialogHeader>
        <Input
          size="lg"
          autoFocus
          aria-label="Search groups"
          placeholder="Search groups"
          value={query}
          maxLength={80}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const [first] = options.filter(isAllowed);
            if (first) choose(first.id);
            else create();
          }}
        />
        <div
          role="listbox"
          aria-label="Groups"
          className="-mx-1 max-h-72 overflow-y-auto px-1"
        >
          {!needle && (
            <button
              type="button"
              role="option"
              aria-selected={currentId === null}
              className={optionClass}
              onClick={() => choose(null)}
            >
              <Inbox className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{rootLabel}</span>
              {currentId === null && <Check className="size-3.5" />}
            </button>
          )}
          {options.map(group => (
            <button
              key={group.id}
              type="button"
              role="option"
              aria-selected={currentId === group.id}
              disabled={!isAllowed(group)}
              className={optionClass}
              style={{
                paddingLeft: needle
                  ? undefined
                  : `${0.5 + (groupDepth(group, groups) - 1) * 0.875}rem`,
              }}
              onClick={() => choose(group.id)}
            >
              <span className="min-w-0 flex-1 truncate">
                {needle ? groupPath(group, groups) : group.name}
              </span>
              {currentId === group.id && <Check className="size-3.5" />}
            </button>
          ))}
          {onCreate && needle && (
            <button
              type="button"
              className={cn(optionClass, 'text-muted-foreground')}
              onClick={create}
            >
              <FolderPlus className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">
                New group “{query.trim()}”
              </span>
            </button>
          )}
          {!onCreate && needle && options.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No matching groups.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
