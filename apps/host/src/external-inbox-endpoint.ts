import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const externalInboxFrameLimit = 32 * 1024;

export function externalInboxEndpoint(computerId: string) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\nesvo-inbox-${computerId}`
    : join(tmpdir(), `nesvo-inbox-${process.getuid?.()}`, `${computerId}.sock`);
}
