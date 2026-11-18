import { shell } from 'electron';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  opensAsProgram,
  type AttachmentLocation,
  type OpenAttachmentInput,
} from '@nesvo/contracts';

const isInside = (parent: string, child: string) => {
  const path = relative(resolve(parent), resolve(child));
  return !!path && !path.startsWith('..') && !isAbsolute(path);
};

export const openAttachmentFile = async (
  hostDirectory: string,
  location: AttachmentLocation,
  action: OpenAttachmentInput['action'],
) => {
  if (!isInside(join(hostDirectory, 'attachments', 'sessions'), location.path))
    throw new Error('The attachment is not stored in this session.');
  if (action === 'reveal') {
    shell.showItemInFolder(location.path);
    return;
  }
  if (opensAsProgram(location.path))
    throw new Error(
      `${location.name} could run as a program, so Nesvo does not open it. Use Show in folder instead.`,
    );
  const failure = await shell.openPath(location.path);
  if (failure)
    throw new Error(`${location.name} could not be opened. ${failure}`);
};
