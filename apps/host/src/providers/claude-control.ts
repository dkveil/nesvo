import { z } from 'zod';
import { SESSION_CONTROL_NAMESPACE } from '@nesvo/contracts';
import type {
  SessionControlHandler,
  SessionControlToolDefinition,
} from '../session-control/types';

const CONTROL_CALL_TIMEOUT_MS = 15 * 60_000;
const MCP_PROTOCOL_VERSION = '2025-06-18';
const TOOL_USE_META = 'claudecode/toolUseId';

export const claudeControlToolPrefix = `mcp__${SESSION_CONTROL_NAMESPACE}__`;

const mcpMessageSchema = z.looseObject({
  type: z.literal('control_request'),
  request_id: z.string().min(1).max(200),
  request: z.looseObject({
    subtype: z.literal('mcp_message'),
    server_name: z.string(),
    message: z.looseObject({
      jsonrpc: z.literal('2.0'),
      id: z.union([z.string().max(200), z.number().int()]).optional(),
      method: z.string().min(1).max(200),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
});

const toolCallSchema = z.looseObject({
  name: z.string().min(1).max(200),
  arguments: z.unknown().optional(),
  _meta: z
    .looseObject({ [TOOL_USE_META]: z.string().min(1).max(200).optional() })
    .optional(),
});

export const claudeControlInitialize = (
  tools: readonly SessionControlToolDefinition[],
) => ({
  sdkMcpServers: [SESSION_CONTROL_NAMESPACE],
  sdkMcpServerConfigs: {
    [SESSION_CONTROL_NAMESPACE]: {
      tools: tools.map(tool => ({
        name: tool.name,
        permission_policy: 'always_allow',
      })),
      timeout: CONTROL_CALL_TIMEOUT_MS,
      disableAutoBackground: true,
    },
  },
});

export const isClaudeControlServer = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.some(
    server =>
      !!server &&
      typeof server === 'object' &&
      (server as Record<string, unknown>).name === SESSION_CONTROL_NAMESPACE &&
      (server as Record<string, unknown>).status === 'connected' &&
      (server as Record<string, unknown>).source === 'sdk',
  );

export const claudeControlToolNames = (
  tools: readonly SessionControlToolDefinition[],
) => new Set(tools.map(tool => `${claudeControlToolPrefix}${tool.name}`));

export const withoutControlServer = <T>(
  servers: Record<string, T>,
): Record<string, T> =>
  Object.fromEntries(
    Object.entries(servers).filter(
      ([name]) => name !== SESSION_CONTROL_NAMESPACE,
    ),
  );

export const isClaudeMcpMessage = (value: Record<string, unknown>) => {
  const request = value.request;
  return (
    !!request &&
    typeof request === 'object' &&
    (request as Record<string, unknown>).subtype === 'mcp_message'
  );
};

export const createClaudeControlChannel = ({
  tools,
  call,
  write,
  onFailure,
}: {
  tools: readonly SessionControlToolDefinition[];
  call: SessionControlHandler;
  write: (frame: Record<string, unknown>) => void;
  onFailure: (message: string) => void;
}) => {
  const pending = new Map<string, AbortController>();
  let closed = false;
  const reply = (requestId: string, mcpResponse: Record<string, unknown>) => {
    if (closed) return;
    try {
      write({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: { mcp_response: mcpResponse },
        },
      });
    } catch {
      onFailure('Claude control answer could not be delivered.');
    }
  };
  const fail = (requestId: string, error: string) => {
    if (closed) return;
    try {
      write({
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error },
      });
    } catch {
      onFailure('Claude control answer could not be delivered.');
    }
  };
  const listed = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: !tool.mutation },
  }));
  const runTool = (
    requestId: string,
    id: string | number | undefined,
    params: Record<string, unknown> | undefined,
  ) => {
    const parsed = toolCallSchema.safeParse(params);
    const callId = parsed.data?._meta?.[TOOL_USE_META];
    if (!parsed.success || !callId) {
      reply(requestId, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            { type: 'text', text: 'Nesvo could not read this tool call.' },
          ],
          isError: true,
        },
      });
      return;
    }
    const controller = new AbortController();
    pending.set(requestId, controller);
    void call(
      { tool: parsed.data.name, input: parsed.data.arguments ?? {}, callId },
      controller.signal,
    )
      .catch(() => ({ text: 'The Nesvo tool failed.', ok: false }))
      .then(result => {
        if (pending.get(requestId) !== controller) return;
        pending.delete(requestId);
        if (controller.signal.aborted) return;
        reply(requestId, {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: result.text }],
            ...(result.ok ? {} : { isError: true }),
          },
        });
      });
  };
  return {
    pending: () => pending.size,
    handle: (value: Record<string, unknown>) => {
      const parsed = mcpMessageSchema.safeParse(value);
      if (!parsed.success) {
        if (typeof value.request_id === 'string')
          fail(value.request_id, 'Nesvo could not read this MCP message.');
        return;
      }
      const { request_id: requestId, request } = parsed.data;
      if (request.server_name !== SESSION_CONTROL_NAMESPACE) {
        fail(requestId, 'Nesvo does not host this MCP server.');
        return;
      }
      const { id, method, params } = request.message;
      if (id === undefined) {
        reply(requestId, { jsonrpc: '2.0', result: {} });
        return;
      }
      if (method === 'initialize') {
        reply(requestId, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion:
              typeof params?.protocolVersion === 'string'
                ? params.protocolVersion
                : MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SESSION_CONTROL_NAMESPACE, version: '1.0.0' },
          },
        });
        return;
      }
      if (method === 'tools/list') {
        reply(requestId, { jsonrpc: '2.0', id, result: { tools: listed } });
        return;
      }
      if (method === 'tools/call') {
        runTool(requestId, id, params);
        return;
      }
      reply(requestId, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' },
      });
    },
    cancel: (requestId: string) => {
      const controller = pending.get(requestId);
      if (!controller) return false;
      pending.delete(requestId);
      controller.abort();
      return true;
    },
    close: () => {
      closed = true;
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    },
  };
};

export type ClaudeControlChannel = ReturnType<
  typeof createClaudeControlChannel
>;
