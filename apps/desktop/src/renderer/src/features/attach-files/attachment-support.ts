import type { AttachmentKind, HostCapability } from '@nesvo/contracts';
import type { Provider, ProviderState } from '@/entities/session';

export type KindSupport =
  { enabled: true } | { enabled: false; reason: string };

export type AttachmentSupport = Record<AttachmentKind, KindSupport> & {
  enabled: boolean;
  reason: string;
};

type AttachmentSupportParams = {
  provider: Provider;
  model: string;
  modelLabel: string;
  state: ProviderState | undefined;
  capabilities: readonly HostCapability[];
};

const supported = { enabled: true } as const;
const unsupported = (reason: string): KindSupport => ({
  enabled: false,
  reason,
});

const imageSupport = ({
  provider,
  model,
  modelLabel,
  state,
  capabilities,
}: AttachmentSupportParams): KindSupport => {
  if (!capabilities.includes('message-attachments'))
    return unsupported(
      'This computer runs an older Nesvo host that cannot receive attachments. Update the host to attach files.',
    );
  const status = state?.status;
  if (!status || status.status !== 'ready')
    return unsupported(`${provider} is not ready on this computer.`);
  if (status.images.status === 'unsupported')
    return unsupported(status.images.reason);
  if (status.images.status === 'per-model') {
    const entry = status.models.find(option => option.id === model);
    if (!entry || !('images' in entry) || !entry.images)
      return unsupported(
        `${modelLabel} does not accept images. Choose another model to attach images.`,
      );
  }
  return supported;
};

const fileSupport = ({
  provider,
  state,
  capabilities,
}: AttachmentSupportParams): KindSupport => {
  if (!capabilities.includes('file-attachments'))
    return unsupported(
      'This computer runs an older Nesvo host that accepts only images. Update the host to attach other files.',
    );
  if (state?.status?.status !== 'ready')
    return unsupported(`${provider} is not ready on this computer.`);
  return supported;
};

const pdfSupport = (params: AttachmentSupportParams): KindSupport => {
  const file = fileSupport(params);
  if (!file.enabled || params.provider === 'Codex') return file;
  const status = params.state?.status;
  return status?.status === 'ready' && status.images.status === 'unsupported'
    ? unsupported(
        'This Claude Code version cannot receive PDF files. Update the CLI to attach them.',
      )
    : supported;
};

export const attachmentSupport = (
  params: AttachmentSupportParams,
): AttachmentSupport => {
  const kinds = {
    image: imageSupport(params),
    pdf: pdfSupport(params),
    file: fileSupport(params),
  };
  const blocked = Object.values(kinds).find(kind => !kind.enabled);
  const enabled = Object.values(kinds).some(kind => kind.enabled);
  return {
    ...kinds,
    enabled,
    reason: !enabled && blocked && !blocked.enabled ? blocked.reason : '',
  };
};
