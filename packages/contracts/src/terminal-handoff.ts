import { z } from 'zod';
import { providerSchema, type Provider } from './sessions';

export const providerThreadIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const setSessionTerminalSchema = z.strictObject({
  sessionId: z.uuid(),
  attached: z.boolean(),
});

export const openSessionTerminalSchema = z.strictObject({
  sessionId: z.uuid(),
});

export const terminalResumeSchema = z.strictObject({
  provider: providerSchema,
  directory: z.string().min(1).max(4096),
  executable: z.enum(['claude', 'codex']),
  args: z.array(z.string().min(1).max(200)).min(2).max(3),
  commandLine: z.string().min(1).max(5000),
});

export type SetSessionTerminalInput = z.infer<typeof setSessionTerminalSchema>;
export type OpenSessionTerminalInput = z.infer<
  typeof openSessionTerminalSchema
>;
export type TerminalResume = z.infer<typeof terminalResumeSchema>;

const posixQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function terminalResume(
  provider: Provider,
  threadId: string | null,
  directory: string,
): TerminalResume | null {
  if (!threadId || !providerThreadIdPattern.test(threadId) || !directory)
    return null;
  const executable = provider === 'Claude Code' ? 'claude' : 'codex';
  const args =
    provider === 'Claude Code' ? ['--resume', threadId] : ['resume', threadId];
  return {
    provider,
    directory,
    executable,
    args,
    commandLine: `cd ${posixQuote(directory)} && ${executable} ${args.join(' ')}`,
  };
}
