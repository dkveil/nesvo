import { useState } from 'react';
import {
  parseGitHubRepository,
  type TrackedRepository,
} from '@nesvo/contracts';
import {
  ChevronDown,
  FolderGit2,
  GitPullRequest,
  Layers,
  Plus,
} from 'lucide-react';
import { directoryLabel } from '@/entities/session';
import { Chip } from '@/shared/ui/chip';
import { Combobox, type ListboxOption } from '@/shared/ui/listbox';
import {
  ALL_TRACKED_KEY,
  FOLDER_KEY,
  repositoryKey,
  sourceKeyOf,
  trackedKey,
  type PullRequestSource,
} from './pull-request-source';

const TRACK_KEY = 'track';

type RepositorySourcePickerProps = {
  source: PullRequestSource;
  tracked: TrackedRepository[];
  directory: string;
  folderRepository: string | null;
  canTrack: boolean;
  onSelect: (key: string) => void;
  onTrack: () => void;
};

const sourceLabel = (
  source: PullRequestSource,
  directory: string,
  folderRepository: string | null,
) => {
  switch (source.kind) {
    case 'all':
      return 'All tracked';
    case 'tracked':
      return source.tracked.repository;
    case 'folder':
      return folderRepository ?? directoryLabel(directory);
    case 'repository':
      return source.repository;
    case 'pending':
      return 'Repositories';
    case 'none':
      return 'Choose a repository';
  }
};

export function RepositorySourcePicker({
  source,
  tracked,
  directory,
  folderRepository,
  canTrack,
  onSelect,
  onTrack,
}: RepositorySourcePickerProps) {
  const [query, setQuery] = useState('');
  const typed = parseGitHubRepository(query);
  const typedTracked = typed
    ? tracked.some(
        item => item.repository.toLowerCase() === typed.toLowerCase(),
      )
    : false;
  const options: ListboxOption<string>[] = [
    ...(tracked.length > 1
      ? [
          {
            value: ALL_TRACKED_KEY,
            label: 'All tracked',
            description: `${tracked.length} repositories`,
            icon: <Layers />,
            group: 'Tracked',
          },
        ]
      : []),
    ...tracked.map(item => ({
      value: trackedKey(item.id),
      label: item.repository,
      icon: <GitPullRequest />,
      group: 'Tracked',
    })),
    ...(directory
      ? [
          {
            value: FOLDER_KEY,
            label: directoryLabel(directory),
            description: directory,
            icon: <FolderGit2 />,
            group: 'Session folder',
          },
        ]
      : []),
    ...(typed && !typedTracked
      ? [
          {
            value: repositoryKey(typed),
            label: `Open ${typed}`,
            keywords: query,
            icon: <GitPullRequest />,
            group: 'Repository',
          },
        ]
      : []),
    ...(canTrack
      ? [
          {
            value: TRACK_KEY,
            label: 'Track a repository…',
            keywords: query,
            icon: <Plus />,
            group: 'Tracked repositories',
          },
        ]
      : []),
  ];
  return (
    <Combobox
      label="Repositories"
      searchLabel="Search repositories or type owner/name"
      searchPlaceholder="Search or type owner/name"
      options={options}
      value={sourceKeyOf(source)}
      query={query}
      onQueryChange={setQuery}
      size="md"
      onOpenChange={open => {
        if (!open) setQuery('');
      }}
      onSelect={value => {
        setQuery('');
        if (value === TRACK_KEY) onTrack();
        else onSelect(value);
      }}
      trigger={
        <Chip
          aria-label="Repository"
          icon={
            source.kind === 'all' ? (
              <Layers />
            ) : source.kind === 'folder' ? (
              <FolderGit2 />
            ) : (
              <GitPullRequest />
            )
          }
        >
          <span>{sourceLabel(source, directory, folderRepository)}</span>
          <ChevronDown />
        </Chip>
      }
    />
  );
}
