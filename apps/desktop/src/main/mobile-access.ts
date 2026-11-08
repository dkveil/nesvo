import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopSessionSchema } from '@nesvo/contracts';
import {
  createMobileGateway,
  type MobileGatewayOptions,
  type MobileGatewayWorkspace,
} from '@nesvo/host/mobile';
import type { ComputerManager } from './computer-manager';

async function networkOptions(): Promise<MobileGatewayOptions['network']> {
  const rawPort = process.env.NESVO_MOBILE_PORT ?? '48371';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port > 65535)
    throw new Error('The phone access port must be between 0 and 65535.');
  const certPath = process.env.NESVO_MOBILE_TLS_CERT;
  const keyPath = process.env.NESVO_MOBILE_TLS_KEY;
  if (!!certPath !== !!keyPath)
    throw new Error('Phone access needs both a TLS certificate and its key.');
  let tls: { cert: string; key: string } | undefined;
  if (certPath && keyPath) {
    try {
      const paths = [certPath, keyPath];
      for (const path of paths) {
        const metadata = await stat(path);
        if (!metadata.isFile() || metadata.size > 1024 * 1024)
          throw new Error('Invalid TLS file.');
      }
      const [cert, key] = await Promise.all(
        paths.map(path => readFile(path, 'utf8')),
      );
      tls = { cert: cert!, key: key! };
    } catch {
      throw new Error('The phone access TLS files could not be read.');
    }
  }
  return {
    host: process.env.NESVO_MOBILE_BIND ?? '127.0.0.1',
    port,
    ...(process.env.NESVO_MOBILE_PUBLIC_URL
      ? { publicUrl: process.env.NESVO_MOBILE_PUBLIC_URL }
      : {}),
    ...(tls ? { tls } : {}),
    trustedProxy: process.env.NESVO_MOBILE_TRUSTED_PROXY === '1',
  };
}

export function mobileAccess(directory: string, computers: ComputerManager) {
  let gateway: ReturnType<typeof createMobileGateway> | undefined;
  let closing = false;
  const workspace: MobileGatewayWorkspace = {
    listComputers: async () => computers.listComputers(),
    listSessions: async hostId => computers.listSessions(hostId),
    sendMessage: async (input, hostId) =>
      desktopSessionSchema.parse(
        await computers.execute('send-message', input, hostId),
      ),
    stopRun: async (input, hostId) =>
      desktopSessionSchema.parse(
        await computers.execute('stop-run', input, hostId),
      ),
    respondApproval: async (input, hostId) =>
      desktopSessionSchema.parse(
        await computers.execute('respond-approval', input, hostId),
      ),
    decideDelegation: async (input, hostId) =>
      desktopSessionSchema.parse(
        await computers.execute('decide-delegation', input, hostId),
      ),
    subscribe: listener => computers.subscribe(listener),
  };
  const get = () => {
    if (closing) return Promise.reject(new Error('Nesvo is closing.'));
    if (!gateway) {
      gateway = networkOptions()
        .then(network =>
          createMobileGateway({
            directory: join(directory, 'mobile'),
            workspace,
            network,
          }),
        )
        .catch(error => {
          gateway = undefined;
          throw error;
        });
    }
    return gateway;
  };
  return {
    status: async () => (await get()).status(),
    enable: async () => (await get()).start(),
    disable: async () => (await get()).stop(),
    pair: async () => (await get()).createPairing(),
    revoke: async (deviceId: string) => (await get()).revoke(deviceId),
    close: async () => {
      closing = true;
      if (gateway) await (await gateway).stop();
    },
  };
}
