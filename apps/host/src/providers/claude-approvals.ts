import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Approval } from '@nesvo/contracts';

export const claudeApprovalTimeoutMs = 5 * 60_000;
const maxDetailLength = 100_000;

const permissionRequestSchema = z.looseObject({
  type: z.literal('control_request'),
  request_id: z.string().min(1).max(200),
  request: z.looseObject({
    subtype: z.literal('can_use_tool'),
    tool_name: z.string().min(1).max(200),
    input: z.record(z.string(), z.unknown()),
    tool_use_id: z.string().max(200).optional(),
    decision_reason: z.string().max(4000).optional(),
    blocked_path: z.string().max(4096).optional(),
  }),
});

const summarizedKeys: Record<string, string[]> = {
  Bash: ['command', 'description'],
  Write: ['file_path', 'content'],
  Edit: ['file_path', 'old_string', 'new_string'],
};

const fileTitles: Record<string, string> = {
  Edit: 'Edit file',
  MultiEdit: 'Edit file',
  Write: 'Write file',
  NotebookEdit: 'Edit notebook',
};

export type ClaudePermissionRequest = {
  requestId: string;
  toolUseId: string | null;
  input: Record<string, unknown>;
  approval: Approval & { fingerprint: string };
};

export type ClaudePermissionParse =
  | { status: 'request'; request: ClaudePermissionRequest }
  | { status: 'unreviewable'; requestId: string }
  | { status: 'invalid'; requestId: string | null };

function displayText(value: string): string {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
      '',
    );
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isSummarized(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const keys = summarizedKeys[toolName];
  return !!keys && Object.keys(input).every(key => keys.includes(key));
}

function presentation(
  toolName: string,
  input: Record<string, unknown>,
): Pick<Approval, 'kind' | 'title'> & { body: string } {
  const json = JSON.stringify(input, null, 2);
  const summarized = isSummarized(toolName, input);
  if (toolName === 'Bash')
    return {
      kind: 'command',
      title: 'Run command',
      body: (summarized && text(input.command)) || json,
    };
  const fileTitle = fileTitles[toolName];
  if (fileTitle) {
    const path = text(input.file_path) ?? text(input.notebook_path);
    const content = text(input.content);
    const before = text(input.old_string);
    const after = text(input.new_string);
    const body = !summarized
      ? json
      : path && toolName === 'Write' && content !== null
        ? `${path}\n\n${content}`
        : path && toolName === 'Edit' && before !== null && after !== null
          ? `${path}\n\nReplace:\n${before}\n\nWith:\n${after}`
          : json;
    return { kind: 'file-change', title: fileTitle, body };
  }
  if (toolName.startsWith('mcp__')) {
    const [server = '', ...tool] = toolName.slice('mcp__'.length).split('__');
    return {
      kind: 'tool',
      title: `Use MCP tool ${[server, tool.join('__')].filter(Boolean).join(' / ')}`,
      body: json,
    };
  }
  return { kind: 'tool', title: `Use ${toolName}`, body: json };
}

export function claudeInputFingerprint(
  toolName: string,
  input: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([toolName, input]))
    .digest('hex');
}

export function parseClaudePermissionRequest(
  frame: unknown,
  directory: string,
): ClaudePermissionParse {
  const parsed = permissionRequestSchema.safeParse(frame);
  if (!parsed.success) {
    const requestId =
      frame !== null &&
      typeof frame === 'object' &&
      'request_id' in frame &&
      typeof frame.request_id === 'string' &&
      frame.request_id.length <= 200
        ? frame.request_id
        : null;
    return { status: 'invalid', requestId };
  }
  const { request_id: requestId, request } = parsed.data;
  const shown = presentation(request.tool_name, request.input);
  const label =
    request.tool_name === 'Bash' && typeof request.input.command === 'string'
      ? displayText(request.input.command).trim().slice(0, 8192)
      : null;
  const detail = displayText(
    [
      request.decision_reason ? `Reason: ${request.decision_reason}` : '',
      request.blocked_path ? `Path: ${request.blocked_path}` : '',
      shown.body,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
  if (detail.length > maxDetailLength)
    return { status: 'unreviewable', requestId };
  return {
    status: 'request',
    request: {
      requestId,
      toolUseId: request.tool_use_id ?? null,
      input: request.input,
      approval: {
        id: requestId,
        kind: shown.kind,
        title: displayText(shown.title).slice(0, 500) || 'Use tool',
        detail,
        ...(label ? { label } : {}),
        directory,
        fingerprint: claudeInputFingerprint(request.tool_name, request.input),
      },
    },
  };
}

export function claudePermissionAnswer(
  requestId: string,
  answer:
    | { behavior: 'allow'; input: Record<string, unknown> }
    | { behavior: 'deny'; message: string },
): Record<string, unknown> {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response:
        answer.behavior === 'allow'
          ? {
              behavior: 'allow',
              updatedInput: answer.input,
              decisionClassification: 'user_temporary',
            }
          : {
              behavior: 'deny',
              message: answer.message,
              decisionClassification: 'user_reject',
            },
    },
  };
}

export function claudeControlError(
  requestId: string,
  error: string,
): Record<string, unknown> {
  return {
    type: 'control_response',
    response: { subtype: 'error', request_id: requestId, error },
  };
}
