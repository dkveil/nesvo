import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';

const credentialSchema = z.strictObject({
  id: z.uuid(),
  serverId: z.uuid(),
  deviceId: z.uuid(),
  baseUrl: z.string().max(512),
  name: z.string().min(1).max(80),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const indexSchema = z.array(z.uuid()).max(8);
const indexKey = 'nesvo.mobile.connections.v1';
const options = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
export type Connection = z.infer<typeof credentialSchema>;

export function gatewayAddress(value: string) {
  const url = new URL(value);
  if (
    value.length > 512 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '') ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
  )
    throw new Error('Use HTTPS, or http://127.0.0.1 for the Android emulator.');
  return url.origin;
}

export function pairingLink(value: string) {
  try {
    const link = new URL(value.trim());
    if (
      link.protocol !== 'nesvo:' ||
      link.hostname !== 'pair' ||
      link.search ||
      (link.pathname !== '' && link.pathname !== '/')
    )
      throw new Error();
    const fields = new URLSearchParams(link.hash.slice(1));
    if (
      [...fields.keys()].some(
        key => !['url', 'serverId', 'secret'].includes(key),
      ) ||
      ['url', 'serverId', 'secret'].some(key => fields.getAll(key).length !== 1)
    )
      throw new Error();
    return {
      baseUrl: gatewayAddress(fields.get('url') ?? ''),
      serverId: z.uuid().parse(fields.get('serverId')),
      secret: z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .parse(fields.get('secret')),
    };
  } catch {
    throw new Error(
      'Paste a complete, unexpired Nesvo pairing link. External connections require HTTPS.',
    );
  }
}

export async function loadConnections() {
  const saved = await SecureStore.getItemAsync(indexKey);
  const ids = indexSchema.parse(saved ? JSON.parse(saved) : []);
  const values = await Promise.all(
    ids.map(async id => {
      const item = await SecureStore.getItemAsync(
        `nesvo.mobile.connection.${id}`,
      );
      if (!item) return null;
      const connection = credentialSchema.parse(JSON.parse(item));
      gatewayAddress(connection.baseUrl);
      return connection;
    }),
  );
  return values.filter((value): value is Connection => value !== null);
}

export async function saveConnection(
  connection: Connection,
  existing: Connection[],
) {
  credentialSchema.parse(connection);
  gatewayAddress(connection.baseUrl);
  const ids = [...new Set([...existing.map(item => item.id), connection.id])];
  if (ids.length > 8)
    throw new Error(
      'Up to eight connections can be saved. Forget an old connection first.',
    );
  await SecureStore.setItemAsync(
    `nesvo.mobile.connection.${connection.id}`,
    JSON.stringify(connection),
    options,
  );
  await SecureStore.setItemAsync(indexKey, JSON.stringify(ids), options);
}

export async function forgetConnection(id: string, existing: Connection[]) {
  await SecureStore.setItemAsync(
    indexKey,
    JSON.stringify(
      existing.filter(item => item.id !== id).map(item => item.id),
    ),
    options,
  );
  await SecureStore.deleteItemAsync(`nesvo.mobile.connection.${id}`);
}
