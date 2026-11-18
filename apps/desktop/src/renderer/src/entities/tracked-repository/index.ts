import type { Computer, DesktopApi } from '@nesvo/contracts';

export {
  setTrackedRepositories,
  useTrackedRepositories,
  type TrackedRepositoriesState,
} from './use-tracked-repositories';

export type TrackedRepositoryApi = Pick<
  DesktopApi,
  | 'listTrackedRepositories'
  | 'addTrackedRepository'
  | 'removeTrackedRepository'
  | 'reorderTrackedRepositories'
  | 'suggestTrackedRepositories'
  | 'listTrackedPullRequests'
>;

export function trackedRepositoriesUnavailableReason(
  computer: Computer | undefined,
) {
  if (!computer) return 'Choose a computer to track repositories.';
  if (computer.status !== 'connected')
    return `${computer.name} is offline. Connect it to manage its tracked repositories.`;
  if (!computer.capabilities.includes('tracked-repositories'))
    return 'Update this computer’s Nesvo host and reconnect to track repositories.';
  return '';
}
