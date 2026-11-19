import { join } from 'node:path';

export const externalInboxFrameLimit = 32 * 1024;

export function externalInboxEndpoint(computerId: string) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\nesvo-inbox-${computerId}`
    : join('/tmp', `nesvo-inbox-${process.getuid?.()}`, `${computerId}.sock`);
}

export function configurationEndpoint(computerId: string) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\nesvo-config-${computerId}`
    : join(
        '/tmp',
        `nesvo-inbox-${process.getuid?.()}`,
        `config-${computerId}.sock`,
      );
}
