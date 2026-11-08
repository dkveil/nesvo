import { fetch } from 'expo/fetch';
import { randomUUID } from 'expo-crypto';
import { z } from 'zod';
import {
  mobileSnapshotSchema,
  mobilePairResponseSchema,
  mobileCommandResponseSchema,
  mobileServerMessageSchema,
  type MobileCommand,
  type MobileSnapshot,
  type MobileServerMessage,
} from '@nesvo/contracts';
import { gatewayAddress, pairingLink, type Connection } from './connections';

const maximumBytes = 8 * 1024 * 1024;
const healthSchema = z.strictObject({
  serverId: z.uuid(),
  protocolVersion: z.literal(1),
});

export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function failure(value: unknown, status: number): GatewayError {
  const error = z
    .object({ code: z.string(), message: z.string().max(2000).optional() })
    .safeParse(value);
  const code = error.success
    ? error.data.code
    : status === 401 || status === 403
      ? 'unauthorized'
      : 'unavailable';
  const messages: Record<string, string> = {
    revoked: 'This device was revoked. Pair it again from the desktop.',
    unauthorized:
      'This connection is no longer authorized. Pair this device again.',
    'server-mismatch':
      'The gateway identity changed. Check the pairing address before trying again.',
    'protocol-mismatch':
      'This gateway uses an incompatible version. Update Nesvo on both devices.',
    'too-large': 'The gateway history is too large for this mobile connection.',
    busy: 'The gateway is busy. Refresh its state before retrying.',
    'invalid-request':
      'The request is no longer valid. Refresh the conversation before retrying.',
  };
  return new GatewayError(
    code,
    messages[code] ??
      (error.success && error.data.message
        ? error.data.message
        : 'The gateway is unavailable. Check the connection and retry.'),
  );
}

async function request(
  baseUrl: string,
  path: string,
  token?: string,
  body?: unknown,
  signal?: AbortSignal,
) {
  gatewayAddress(baseUrl);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 15000);
  try {
    if (signal?.aborted) controller.abort();
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (response.url && new URL(response.url).origin !== baseUrl)
      throw new GatewayError(
        'server-mismatch',
        'The gateway redirected this request. Check its address.',
      );
    const reader = response.body?.getReader();
    if (!reader)
      throw new GatewayError(
        'unavailable',
        'The gateway returned an empty response.',
      );
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new GatewayError(
          'too-large',
          'The gateway response exceeded the mobile limit.',
        );
      }
      chunks.push(value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(buffer));
    if (!response.ok) throw failure(value, response.status);
    return value;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError(
      'offline',
      'Could not reach the gateway. Your draft is kept; no command will be resent automatically.',
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function pairDevice(link: string, name: string) {
  const target = pairingLink(link);
  const health = healthSchema.parse(await request(target.baseUrl, '/health'));
  if (health.serverId !== target.serverId)
    throw new GatewayError(
      'server-mismatch',
      'The pairing address points to a different gateway.',
    );
  const paired = mobilePairResponseSchema.parse(
    await request(target.baseUrl, '/v1/pair', undefined, {
      serverId: target.serverId,
      secret: target.secret,
      name: name.trim() || 'Mobile device',
    }),
  );
  if (paired.serverId !== target.serverId)
    throw new GatewayError(
      'server-mismatch',
      'The pairing response came from a different gateway.',
    );
  return {
    id: randomUUID(),
    baseUrl: target.baseUrl,
    name: name.trim() || 'Mobile device',
    ...paired,
  } satisfies Connection;
}

export async function snapshot(
  connection: Connection,
  signal?: AbortSignal,
): Promise<MobileSnapshot> {
  const value = mobileSnapshotSchema.parse(
    await request(
      connection.baseUrl,
      '/v1/snapshot',
      connection.token,
      undefined,
      signal,
    ),
  );
  if (value.serverId !== connection.serverId)
    throw new GatewayError(
      'server-mismatch',
      'The gateway identity changed. Pair this connection again.',
    );
  return value;
}

export async function command(connection: Connection, value: MobileCommand) {
  const result = mobileCommandResponseSchema.parse(
    await request(connection.baseUrl, '/v1/command', connection.token, value),
  );
  if (result.type === 'error') throw failure(result, 400);
  if (
    result.id !== value.id ||
    result.session.hostId !== value.hostId ||
    result.session.id !== value.input.sessionId
  )
    throw new GatewayError(
      'server-mismatch',
      'The command response did not match its computer. Refresh the conversation.',
    );
  return result.session;
}

export function openEvents(
  connection: Connection,
  onMessage: (message: MobileServerMessage) => void,
  onFailure: (error: GatewayError) => void,
  onClose: () => void,
) {
  const baseUrl = gatewayAddress(connection.baseUrl);
  const controller = new AbortController();
  let disposed = false;
  let cancelReader: (() => Promise<unknown>) | undefined;
  const timeout = setTimeout(() => controller.abort(), 15000);
  let idleTimeout: ReturnType<typeof setTimeout> | undefined;
  const received = () => {
    if (idleTimeout) clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => controller.abort(), 45000);
  };
  const run = async () => {
    try {
      const response = await fetch(`${baseUrl}/v1/events`, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: {
          Accept: 'application/x-ndjson',
          Authorization: `Bearer ${connection.token}`,
          'X-Nesvo-Server-Id': connection.serverId,
        },
        signal: controller.signal,
      });
      if (disposed) return;
      if (response.url && new URL(response.url).origin !== baseUrl)
        throw new GatewayError(
          'server-mismatch',
          'The gateway redirected the event stream. Check its address.',
        );
      if (!response.ok) {
        const reader = response.body?.getReader();
        if (!reader) throw failure(null, response.status);
        cancelReader = () => reader.cancel();
        let size = 0;
        const pieces: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maximumBytes)
            throw new GatewayError(
              'too-large',
              'The gateway error response exceeded the mobile limit.',
            );
          pieces.push(value);
        }
        const body = new Uint8Array(size);
        let offset = 0;
        for (const piece of pieces) {
          body.set(piece, offset);
          offset += piece.byteLength;
        }
        let value: unknown = null;
        try {
          value = JSON.parse(new TextDecoder().decode(body));
        } catch {
          value = null;
        }
        throw failure(value, response.status);
      }
      if (
        response.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase() !== 'application/x-ndjson'
      )
        throw new GatewayError(
          'protocol-mismatch',
          'This gateway does not support the mobile event stream.',
        );
      const reader = response.body?.getReader();
      if (!reader)
        throw new GatewayError(
          'unavailable',
          'The gateway returned an empty event stream.',
        );
      cancelReader = () => reader.cancel();
      let parts: Uint8Array[] = [];
      let bytes = 0;
      let authenticated = false;
      while (!disposed) {
        const { done, value } = await reader.read();
        if (done) break;
        received();
        let start = 0;
        while (start < value.byteLength && !disposed) {
          const newline = value.indexOf(10, start);
          const end = newline < 0 ? value.byteLength : newline;
          const part = value.subarray(start, end);
          bytes += part.byteLength;
          if (bytes > maximumBytes)
            throw new GatewayError(
              'too-large',
              'An event exceeded the mobile history limit.',
            );
          if (part.byteLength) parts.push(part);
          if (newline < 0) break;
          if (bytes > 0) {
            const body = new Uint8Array(bytes);
            let offset = 0;
            for (const piece of parts) {
              body.set(piece, offset);
              offset += piece.byteLength;
            }
            let message: MobileServerMessage;
            try {
              message = mobileServerMessageSchema.parse(
                JSON.parse(new TextDecoder().decode(body)),
              );
            } catch {
              throw new GatewayError(
                'protocol-mismatch',
                'The gateway returned an invalid event. Reconnect to refresh its state.',
              );
            }
            parts = [];
            bytes = 0;
            if (message.type === 'error') throw failure(message, 401);
            if (!authenticated) {
              if (message.type !== 'snapshot')
                throw new GatewayError(
                  'protocol-mismatch',
                  'The event stream did not start with a snapshot.',
                );
              if (message.serverId !== connection.serverId)
                throw new GatewayError(
                  'server-mismatch',
                  'The gateway identity changed. Pair this connection again.',
                );
              authenticated = true;
              clearTimeout(timeout);
            }
            onMessage(message);
          }
          start = newline + 1;
        }
      }
    } catch (error) {
      if (!disposed)
        onFailure(
          error instanceof GatewayError
            ? error
            : new GatewayError(
                'offline',
                'Connection lost. Work on the computer may still be running.',
              ),
        );
    } finally {
      clearTimeout(timeout);
      if (idleTimeout) clearTimeout(idleTimeout);
      controller.abort();
      await cancelReader?.().catch(() => undefined);
      if (!disposed) onClose();
    }
  };
  void run();
  return () => {
    disposed = true;
    clearTimeout(timeout);
    if (idleTimeout) clearTimeout(idleTimeout);
    controller.abort();
    void cancelReader?.().catch(() => undefined);
  };
}
