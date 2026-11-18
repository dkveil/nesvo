import type { DesktopApi } from '@nesvo/contracts';
import { useCodeReviewSettings } from '@/features/code-review';

export function useReviewProfiles(
  api: Pick<DesktopApi, 'readCodeReviewSettings'> | null,
  hostId: string,
  enabled: boolean,
) {
  const settings = useCodeReviewSettings(api, hostId, enabled);
  return {
    profiles: settings.settings?.profiles ?? [],
    status: settings.status,
    error: settings.error,
  };
}
