import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  externalInboxMcpLookupSchema,
  externalInboxMcpPostSchema,
} from '@nesvo/contracts';
import { readFrames } from './daemon-channel';
import { externalInboxFrameLimit } from './external-inbox-endpoint';
import {
  createInboxClient,
  InboxClientError,
  inboxDecisionExitCode,
  waitForInboxDecision,
} from './external-inbox-client';

const protocols = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const requestId = z.union([z.string().max(128), z.number().int()]);
const requestSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: requestId.optional(),
  method: z.string().max(100),
  params: z.record(z.string(), z.unknown()).optional(),
});

const tools = [
  {
    name: 'inbox_post',
    description:
      'Post an item for a human decision. Optionally wait for the decision.',
    inputSchema: z.toJSONSchema(externalInboxMcpPostSchema, { io: 'input' }),
    annotations: { idempotentHint: false },
  },
  {
    name: 'inbox_status',
    description:
      'Read the status and decision of an item posted by this device.',
    inputSchema: z.toJSONSchema(externalInboxMcpLookupSchema),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'inbox_cancel',
    description: 'Withdraw a pending item posted by this device.',
    inputSchema: z.toJSONSchema(externalInboxMcpLookupSchema),
    annotations: { idempotentHint: true },
  },
];

async function callTool(name: string, args: unknown, signal: AbortSignal) {
  if (name === 'inbox_post') {
    const { computer, wait, timeout, idempotencyKey, ...fields } =
      externalInboxMcpPostSchema.parse(args);
    const client = await createInboxClient(process.env, computer);
    const item = await client(
      {
        operation: 'post',
        item: { ...fields, idempotencyKey: idempotencyKey ?? randomUUID() },
      },
      signal,
    );
    if (!wait) return item;
    const decision = await waitForInboxDecision(
      client,
      item,
      timeout ?? 300,
      signal,
    );
    return { ...decision, exitCode: inboxDecisionExitCode(decision) };
  }
  const { id, computer } = externalInboxMcpLookupSchema.parse(args);
  const client = await createInboxClient(process.env, computer);
  return client(
    { operation: name === 'inbox_cancel' ? 'cancel' : 'status', itemId: id },
    signal,
  );
}

export function serveInboxMcp() {
  let state: 'new' | 'initializing' | 'ready' = 'new';
  const active = new Map<z.infer<typeof requestId>, AbortController>();
  const send = (id: z.infer<typeof requestId> | null, payload: object) =>
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\n',
    );
  const error = (
    id: z.infer<typeof requestId> | null,
    code: number,
    message: string,
  ) => send(id, { error: { code, message } });
  const stop = () => {
    for (const controller of active.values()) controller.abort();
    active.clear();
  };
  process.stdin.once('end', stop);
  process.stdout.once('error', () => {
    stop();
    process.stdin.destroy();
  });
  readFrames(
    process.stdin,
    externalInboxFrameLimit,
    raw => {
      const parsed = requestSchema.safeParse(raw);
      if (!parsed.success) return void error(null, -32600, 'Invalid Request');
      const { id, method, params } = parsed.data;
      if (id === undefined) {
        if (method === 'notifications/initialized' && state === 'initializing')
          state = 'ready';
        if (method === 'notifications/cancelled') {
          const cancelled = requestId.safeParse(params?.requestId);
          if (cancelled.success) active.get(cancelled.data)?.abort();
        }
        return;
      }
      if (
        method === 'initialize' &&
        state === 'new' &&
        typeof params?.protocolVersion === 'string'
      ) {
        state = 'initializing';
        const version =
          protocols.find(protocol => protocol === params.protocolVersion) ??
          protocols[0];
        return void send(id, {
          result: {
            protocolVersion: version,
            capabilities: { tools: {} },
            serverInfo: { name: 'nesvo', version: '0.0.1' },
          },
        });
      }
      if (method === 'ping') return void send(id, { result: {} });
      if (state !== 'ready')
        return void error(id, -32000, 'Server is not initialized.');
      if (method === 'tools/list') return void send(id, { result: { tools } });
      if (method !== 'tools/call')
        return void error(id, -32601, 'Method not found');
      const name = params?.name;
      if (typeof name !== 'string' || !tools.some(tool => tool.name === name))
        return void error(id, -32602, 'Unknown tool.');
      if (active.has(id) || active.size >= 8)
        return void error(
          id,
          -32000,
          'Too many active requests or duplicate ID.',
        );
      const controller = new AbortController();
      active.set(id, controller);
      const finish = (value: object, isError = false) => {
        active.delete(id);
        if (!controller.signal.aborted)
          send(id, {
            result: {
              content: [{ type: 'text', text: JSON.stringify(value) }],
              structuredContent: value,
              isError,
            },
          });
      };
      void callTool(name, params?.arguments, controller.signal).then(
        value => finish(value),
        issue =>
          finish(
            {
              code:
                issue instanceof InboxClientError
                  ? issue.code
                  : 'invalid-request',
              message:
                issue instanceof InboxClientError
                  ? issue.message
                  : 'The Inbox tool arguments are invalid.',
            },
            true,
          ),
      );
    },
    () => {
      error(null, -32700, 'Invalid JSON frame');
      stop();
      process.stdin.destroy();
    },
  );
  process.stdin.resume();
}
