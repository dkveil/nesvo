import { createConnection } from 'node:net';
import {
  hostConnectSchema,
  hostConnectionSchema,
  hostMessageSchema,
  hostRequestSchema,
} from '@nesvo/contracts';
import {
  privateSocketPath,
  readFrames,
  requestFrameLimit,
  responseFrameLimit,
  sendFrame,
} from './daemon-channel';

export async function connectDaemon(
  runtimeDirectory: string,
  expectedInstanceId?: string,
) {
  const handshake = hostConnectSchema.parse({
    type: 'connect',
    protocolVersion: 1,
    expectedInstanceId,
  });
  const socket = createConnection(await privateSocketPath(runtimeDirectory));
  let resolveCompleted!: () => void;
  let rejectCompleted!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  let connected = false;
  let inputEnded = false;
  let detachInput: (() => void) | undefined;
  const fail = (error: Error) => {
    socket.destroy();
    rejectCompleted(error);
  };
  const end = () => {
    inputEnded = true;
    socket.end();
  };
  const resume = () => socket.resume();
  const outputError = () => fail(new Error('The client output closed.'));
  const timeout = setTimeout(
    () => fail(new Error('The host did not answer.')),
    10_000,
  );
  const detachOutput = readFrames(
    socket,
    responseFrameLimit,
    value => {
      if (socket.destroyed) return;
      if (!connected) {
        const result = hostConnectionSchema.safeParse(value);
        if (!result.success || result.data.type === 'connection-error') {
          fail(
            new Error(
              result.success && result.data.type === 'connection-error'
                ? result.data.code
                : 'Invalid host handshake.',
            ),
          );
          return;
        }
        if (
          expectedInstanceId &&
          result.data.health.instanceId !== expectedInstanceId
        ) {
          fail(new Error('The host identity changed.'));
          return;
        }
        connected = true;
        clearTimeout(timeout);
        detachInput = readFrames(
          process.stdin,
          requestFrameLimit,
          request => {
            const parsed = hostRequestSchema.safeParse(request);
            if (!parsed.success) {
              fail(new Error('Invalid client request.'));
              return;
            }
            sendFrame(socket, parsed.data);
          },
          () => fail(new Error('Invalid client frame.')),
        );
        process.stdin.once('end', end);
        process.stdin.once('error', fail);
        if (process.stdin.readableEnded) end();
        else process.stdin.resume();
      } else if (!hostMessageSchema.safeParse(value).success) {
        fail(new Error('Invalid host response.'));
        return;
      }
      if (!process.stdout.write(JSON.stringify(value) + '\n')) socket.pause();
    },
    () => fail(new Error('Invalid host frame.')),
  );
  socket.once('connect', () => sendFrame(socket, handshake));
  socket.once('error', fail);
  socket.once('close', () => {
    if (!connected) fail(new Error('The host closed before connecting.'));
    else if (inputEnded) resolveCompleted();
    else
      fail(
        new Error(
          'The host connection was lost. Refresh its state before retrying work.',
        ),
      );
  });
  process.stdout.on('drain', resume);
  process.stdout.once('error', outputError);
  try {
    await completed;
  } finally {
    clearTimeout(timeout);
    detachInput?.();
    detachOutput();
    process.stdin.off('end', end);
    process.stdin.off('error', fail);
    process.stdin.pause();
    process.stdout.off('drain', resume);
    process.stdout.off('error', outputError);
    socket.destroy();
  }
}
