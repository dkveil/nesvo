import {
  parseGitHubRepository,
  type TrackedRepository,
} from '@nesvo/contracts';

export type PullRequestSource =
  | { kind: 'all' }
  | { kind: 'tracked'; tracked: TrackedRepository }
  | { kind: 'folder' }
  | { kind: 'repository'; repository: string }
  | { kind: 'pending' }
  | { kind: 'none' };

export const ALL_TRACKED_KEY = 'all';
export const FOLDER_KEY = 'folder';
export const trackedKey = (id: string) => `tracked:${id}`;
export const repositoryKey = (repository: string) => `repository:${repository}`;

type ResolveSourceParams = {
  key: string | null;
  tracked: TrackedRepository[];
  trackedReady: boolean;
  directory: string;
};

const defaultSource = ({
  tracked,
  trackedReady,
  directory,
}: Omit<ResolveSourceParams, 'key'>): PullRequestSource => {
  if (!trackedReady) return { kind: 'pending' };
  if (tracked.length > 1) return { kind: 'all' };
  if (tracked[0]) return { kind: 'tracked', tracked: tracked[0] };
  return directory ? { kind: 'folder' } : { kind: 'none' };
};

export const resolveSource = ({
  key,
  tracked,
  trackedReady,
  directory,
}: ResolveSourceParams): PullRequestSource => {
  const fallback = () => defaultSource({ tracked, trackedReady, directory });
  if (!key) return fallback();
  if (key === FOLDER_KEY) return directory ? { kind: 'folder' } : fallback();
  if (key.startsWith('repository:')) {
    const repository = parseGitHubRepository(key.slice('repository:'.length));
    return repository ? { kind: 'repository', repository } : fallback();
  }
  if (!trackedReady) return { kind: 'pending' };
  if (key === ALL_TRACKED_KEY)
    return tracked.length ? { kind: 'all' } : fallback();
  const match = tracked.find(item => trackedKey(item.id) === key);
  return match ? { kind: 'tracked', tracked: match } : fallback();
};

export const sourceKeyOf = (source: PullRequestSource): string | null => {
  switch (source.kind) {
    case 'all':
      return ALL_TRACKED_KEY;
    case 'tracked':
      return trackedKey(source.tracked.id);
    case 'folder':
      return FOLDER_KEY;
    case 'repository':
      return repositoryKey(source.repository);
    default:
      return null;
  }
};

const NOT_A_REPOSITORY =
  /not a git repository|no git remotes|none of the git remotes|unable to determine|could not determine (?:the )?(?:base )?repo/i;

export const isNotRepositoryError = (message: string) =>
  NOT_A_REPOSITORY.test(message);
