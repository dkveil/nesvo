import type { WorkflowShareError } from '@nesvo/contracts/workflow-share';

export const API_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
} as const;

export const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...API_HEADERS, ...headers },
  });

export const errorResponse = (
  status: number,
  error: WorkflowShareError,
  headers: Record<string, string> = {},
): Response => jsonResponse(status, error, headers);
