import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import {
  configurationFrameLimit,
  configurationRequestSchema,
  configurationResultSchema,
  type ConfigurationCommand,
  type ConfigurationResult,
  externalInboxReplySchema,
  externalInboxRequestSchema,
  externalInboxTokenSchema,
  hostConnectionSchema,
  sshComputerInputSchema,
  type ExternalInboxRequest,
  type ExternalInboxResult,
  type HostCapability,
} from '@nesvo/contracts';
import { readFrames, responseFrameLimit, sendFrame } from './daemon-channel';
import {
  configurationEndpoint,
  externalInboxEndpoint,
  externalInboxFrameLimit,
} from './external-inbox-endpoint';
import { spawnSshBridge } from './ssh-transport';

type Command = ExternalInboxRequest['command'];
type Channel = {
  envPrefix: 'NESVO_INBOX' | 'NESVO_CONFIG';
  frameLimit: number;
  endpoint: (instance: string) => string;
  capability: HostCapability;
  method: string;
  response: string;
};
const inboxChannel: Channel = {
  envPrefix: 'NESVO_INBOX',
  frameLimit: externalInboxFrameLimit,
  endpoint: externalInboxEndpoint,
  capability: 'external-inbox',
  method: 'external-inbox',
  response: 'external-inbox-result',
};
const configurationChannel: Channel = {
  envPrefix: 'NESVO_CONFIG',
  frameLimit: configurationFrameLimit,
  endpoint: configurationEndpoint,
  capability: 'configuration',
  method: 'configuration',
  response: 'configuration-result',
};
export type InboxClient = (
  command: Command,
  signal?: AbortSignal,
) => Promise<ExternalInboxResult>;

export class InboxClientError extends Error {
  constructor(
    message: string,
    readonly code = 'invalid-request',
  ) {
    super(message);
  }
}

const unavailable = () =>
  new InboxClientError(
    'Could not reach the selected Nesvo host.',
    'unavailable',
  );

export async function readSmallInboxFile(
  path: string,
  limit: number,
  privateFile = false,
) {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error('Expected a regular file.');
  const file = await open(
    path,
    constants.O_RDONLY |
      (process.platform === 'win32'
        ? 0
        : constants.O_NOFOLLOW | constants.O_NONBLOCK),
  );
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.size > limit ||
      (privateFile &&
        process.platform !== 'win32' &&
        (opened.uid !== process.getuid?.() || opened.mode & 0o077))
    )
      throw new Error('Invalid file.');
    const content = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < content.length) {
      const { bytesRead } = await file.read(
        content,
        length,
        content.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error('File is too long.');
    return new TextDecoder('utf-8', { fatal: true }).decode(
      content.subarray(0, length),
    );
  } finally {
    await file.close();
  }
}

const configSchema = z.strictObject({
  token: externalInboxTokenSchema.optional(),
  ssh: sshComputerInputSchema.optional(),
});

export async function createInboxClient(
  env: NodeJS.ProcessEnv,
  computer?: string,
): Promise<InboxClient> {
  const send = await createDeviceTransport(inboxChannel, env, computer);
  return async (command, signal) => {
    const reply = externalInboxReplySchema.safeParse(
      await send(command, signal),
    );
    if (!reply.success) throw unavailable();
    if (!reply.data.ok)
      throw new InboxClientError(reply.data.message, reply.data.code);
    return reply.data.item;
  };
}

export async function createConfigurationClient(
  env: NodeJS.ProcessEnv,
  computer?: string,
) {
  const send = await createDeviceTransport(configurationChannel, env, computer);
  return async (
    command: ConfigurationCommand,
    signal?: AbortSignal,
  ): Promise<ConfigurationResult> => {
    const reply = configurationResultSchema.safeParse(
      await send(command, signal),
    );
    if (!reply.success) throw unavailable();
    return reply.data;
  };
}

async function createDeviceTransport(
  channel: Channel,
  env: NodeJS.ProcessEnv,
  computer?: string,
) {
  const get = (suffix: string) => env[`${channel.envPrefix}_${suffix}`];
  const configPath = get('CONFIG');
  const ssh = get('SSH');
  let config: z.infer<typeof configSchema> = {};
  let remote: z.infer<typeof sshComputerInputSchema> | undefined;
  try {
    if (configPath)
      config = configSchema.parse(
        JSON.parse(await readSmallInboxFile(configPath, 24 * 1024, true)),
      );
    remote = ssh ? sshComputerInputSchema.parse(JSON.parse(ssh)) : config.ssh;
  } catch {
    throw new InboxClientError('The client configuration could not be read.');
  }
  const parsed = externalInboxTokenSchema.safeParse(
    get('TOKEN') ?? config.token,
  );
  if (!parsed.success)
    throw new InboxClientError(
      `Set ${channel.envPrefix}_TOKEN or supply a private ${channel.envPrefix}_CONFIG file.`,
      'unauthorized',
    );
  const token = parsed.data;
  const computerId = token.slice(0, 36);
  const selected = computer ?? get('COMPUTER');
  if (selected && selected !== computerId && (selected !== 'local' || remote))
    throw new InboxClientError(
      'The token belongs to a different computer.',
      'unauthorized',
    );
  return async (command: unknown, signal?: AbortSignal) => {
    const request = (
      channel === inboxChannel
        ? externalInboxRequestSchema
        : configurationRequestSchema
    ).safeParse({ token, command });
    if (
      !request.success ||
      Buffer.byteLength(JSON.stringify(request.data)) > channel.frameLimit
    )
      throw new InboxClientError(
        'The request is invalid or exceeds its size limit.',
      );
    const timeout = AbortSignal.timeout(remote ? 25_000 : 10_000);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return remote
      ? sendRemote(channel, remote, computerId, request.data, deadline, env)
      : sendLocal(channel, computerId, request.data, deadline);
  };
}

function sendLocal(
  channel: Channel,
  computerId: string,
  request: unknown,
  signal: AbortSignal,
) {
  return new Promise<unknown>((resolve, reject) => {
    if (signal.aborted) return reject(unavailable());
    const socket = createConnection(channel.endpoint(computerId));
    const fail = () => {
      socket.destroy();
      reject(unavailable());
    };
    signal.addEventListener('abort', fail, { once: true });
    const detach = readFrames(
      socket,
      channel.frameLimit,
      reply => {
        resolve(reply);
        socket.destroy();
      },
      fail,
    );
    socket.once('connect', () => sendFrame(socket, request));
    socket.on('error', fail);
    socket.once('close', () => {
      detach();
      signal.removeEventListener('abort', fail);
      reject(unavailable());
    });
  });
}

function sendRemote(
  channel: Channel,
  target: z.infer<typeof sshComputerInputSchema>,
  computerId: string,
  input: unknown,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
) {
  return new Promise<unknown>((resolve, reject) => {
    if (signal.aborted) return reject(unavailable());
    const sshEnv = { ...env };
    delete sshEnv.NESVO_INBOX_TOKEN;
    delete sshEnv.NESVO_CONFIG_TOKEN;
    const child = spawnSshBridge(target, computerId, sshEnv);
    const id = randomUUID();
    let greeted = false;
    const fail = () => {
      child.kill();
      reject(unavailable());
    };
    signal.addEventListener('abort', fail, { once: true });
    const detach = readFrames(
      child.stdout,
      responseFrameLimit,
      value => {
        if (!greeted) {
          const handshake = hostConnectionSchema.safeParse(value);
          if (
            !handshake.success ||
            handshake.data.type !== 'connected' ||
            handshake.data.health.instanceId !== computerId ||
            !handshake.data.health.capabilities?.includes(channel.capability)
          ) {
            fail();
            return;
          }
          greeted = true;
          child.stdin.write(
            JSON.stringify({ id, method: channel.method, input }) + '\n',
          );
          return;
        }
        if (
          !value ||
          typeof value !== 'object' ||
          !('id' in value) ||
          value.id !== id
        )
          return;
        if (
          !('type' in value) ||
          value.type !== channel.response ||
          !('result' in value)
        ) {
          fail();
          return;
        }
        resolve(value.result);
        child.stdin.end();
        child.kill();
      },
      fail,
    );
    child.stdin.on('error', fail);
    child.stderr.resume();
    child.once('error', fail);
    child.once('close', () => {
      signal.removeEventListener('abort', fail);
      detach();
      reject(unavailable());
    });
  });
}

export async function waitForInboxDecision(
  client: InboxClient,
  item: ExternalInboxResult,
  seconds: number,
  signal?: AbortSignal,
) {
  const timer = AbortSignal.timeout(seconds * 1000);
  const deadline = signal ? AbortSignal.any([signal, timer]) : timer;
  try {
    while (item.status === 'pending') {
      await sleep(400, undefined, { signal: deadline });
      item = await client({ operation: 'status', itemId: item.id }, deadline);
    }
  } catch (error) {
    if (!timer.aborted || signal?.aborted) throw error;
  }
  return item;
}

export function inboxDecisionExitCode(item: ExternalInboxResult) {
  if (item.status === 'pending') return 2;
  if (item.status === 'cancelled') return 3;
  return item.actionIndex === 0 ? 0 : 1;
}
