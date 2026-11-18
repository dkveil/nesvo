import { shell } from 'electron';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  opensInViewer,
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
  if (!opensInViewer(location.path))
    throw new Error(
      `Nesvo opens only documents, images and media. Use Show in folder for ${location.name}.`,
    );
  const failure = await shell.openPath(location.path);
  if (failure)
    throw new Error(`${location.name} could not be opened. ${failure}`);
};
