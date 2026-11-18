import type { TrackedPullRequestList } from '@nesvo/contracts';
import { ChevronDown, ListFilter } from 'lucide-react';
import { Chip } from '@/shared/ui/chip';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';

type RepositoryFilterProps = {
  lists: TrackedPullRequestList[];
  excluded: string[];
  onChange: (excluded: string[]) => void;
};

const countLabel = (list: TrackedPullRequestList) =>
  list.status === 'error'
    ? 'Failed'
    : `${list.items.length}${list.truncated ? '+' : ''}`;

export function RepositoryFilter({
  lists,
  excluded,
  onChange,
}: RepositoryFilterProps) {
  const hidden = new Set(excluded);
  const included = lists.filter(
    list => !hidden.has(list.repository.toLowerCase()),
  ).length;
  const toggle = (repository: string, checked: boolean) => {
    const key = repository.toLowerCase();
    onChange(
      checked
        ? excluded.filter(item => item !== key)
        : [...new Set([...excluded, key])],
    );
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Chip
          aria-label="Filter repositories"
          selected={included < lists.length}
          icon={<ListFilter />}
        >
          <span>
            {included === lists.length
              ? 'All repositories'
              : `${included} of ${lists.length} repositories`}
          </span>
          <ChevronDown />
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Show pull requests from</DropdownMenuLabel>
        {lists.map(list => (
          <DropdownMenuCheckboxItem
            key={list.trackedId}
            checked={!hidden.has(list.repository.toLowerCase())}
            onSelect={event => event.preventDefault()}
            onCheckedChange={checked =>
              toggle(list.repository, checked === true)
            }
          >
            <span className="min-w-0 flex-1 truncate">{list.repository}</span>
            <DropdownMenuShortcut
              className={
                list.status === 'error' ? 'text-error-foreground' : undefined
              }
            >
              {countLabel(list)}
            </DropdownMenuShortcut>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={excluded.length === 0}
          onSelect={() => onChange([])}
        >
          Show all repositories
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
