import { useState } from 'react';
import { FolderPlus, Inbox } from 'lucide-react';
import type { SessionGroup } from '@nesvo/contracts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Listbox, type ListboxOption } from '@/shared/ui/listbox';
import { groupPath, orderedGroups } from './session-tree';

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

const ROOT_OPTION = 'root';
const CREATE_OPTION = 'create';
const GROUP_NAME_MAX_LENGTH = 80;

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
  const name = query.trim().slice(0, GROUP_NAME_MAX_LENGTH);
  const options: ListboxOption<string>[] = [
    { value: ROOT_OPTION, label: rootLabel, icon: <Inbox /> },
    ...orderedGroups(groups).map(group => ({
      value: group.id,
      label: groupPath(group, groups),
      disabled: !isAllowed(group),
    })),
    ...(onCreate && name
      ? [
          {
            value: CREATE_OPTION,
            label: `New group “${name}”`,
            icon: <FolderPlus />,
          },
        ]
      : []),
  ];
  const choose = (value: string) => {
    onOpenChange(false);
    if (value === CREATE_OPTION) onCreate?.(name);
    else onMove(value === ROOT_OPTION ? null : value);
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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {onCreate
              ? 'Search for a group or type a name to create one.'
              : 'Search for a group.'}
          </DialogDescription>
        </DialogHeader>
        <Listbox
          label="Groups"
          searchable
          searchPlaceholder="Search groups"
          emptyText="No matching groups."
          autoFocus
          options={options}
          value={currentId ?? ROOT_OPTION}
          query={query}
          onQueryChange={setQuery}
          onSelect={choose}
          className="max-h-80 rounded-surface border"
        />
      </DialogContent>
    </Dialog>
  );
}
