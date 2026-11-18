import type { HostCapability } from '@nesvo/contracts';
import type { Provider, ProviderState } from '@/entities/session';

export type ImageSupport =
  { enabled: true } | { enabled: false; reason: string };

type ImageSupportParams = {
  provider: Provider;
  model: string;
  modelLabel: string;
  state: ProviderState | undefined;
  capabilities: readonly HostCapability[];
};

export const imageSupport = ({
  provider,
  model,
  modelLabel,
  state,
  capabilities,
}: ImageSupportParams): ImageSupport => {
  if (!capabilities.includes('message-attachments'))
    return {
      enabled: false,
      reason:
        'This computer runs an older Nesvo host that cannot receive images. Update the host to attach images.',
    };
  const status = state?.status;
  if (!status || status.status !== 'ready')
    return {
      enabled: false,
      reason: `${provider} is not ready on this computer.`,
    };
  if (status.images.status === 'unsupported')
    return { enabled: false, reason: status.images.reason };
  if (status.images.status === 'per-model') {
    const entry = status.models.find(option => option.id === model);
    if (!entry || !('images' in entry) || !entry.images)
      return {
        enabled: false,
        reason: `${modelLabel} does not accept images. Choose another model to attach images.`,
      };
  }
  return { enabled: true };
};
