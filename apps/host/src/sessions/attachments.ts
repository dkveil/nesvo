import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageAttachment } from '@nesvo/contracts';
import type { ProviderAttachment } from '../providers/attachments';

export function attachmentPath(
  directory: string,
  sessionId: string,
  id: string,
): string {
  return join(directory, 'attachments', sessionId, id);
}

export function providerAttachments(
  directory: string,
  sessionId: string,
  attachments: ReadonlyArray<MessageAttachment> = [],
): ProviderAttachment[] {
  if (
    !attachments.length ||
    !existsSync(join(directory, 'attachments', sessionId))
  )
    return [];
  return attachments.map(attachment => ({
    kind: attachment.kind,
    name: attachment.name,
    mediaType: attachment.mediaType,
    path: attachmentPath(directory, sessionId, attachment.id),
  }));
}
