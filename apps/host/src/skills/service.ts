import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { skillCatalogSchema, type Session } from '@nesvo/contracts';
import { inspectCodexSkills } from '../providers/codex';
import { inspectClaudeSkills } from './claude';

export async function discoverSessionSkills(
  session: Session,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const directory = resolve(session.directory);
  const stat = await lstat(directory);
  const canonical = await realpath(directory);
  const samePath =
    process.platform === 'win32'
      ? directory.toLowerCase() === canonical.toLowerCase()
      : directory === canonical;
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath)
    throw new Error('The session directory changed or is unavailable.');
  signal.throwIfAborted();
  const discovery = await (session.provider === 'Codex'
    ? inspectCodexSkills(directory, signal)
    : inspectClaudeSkills(directory, signal));
  return skillCatalogSchema.parse({ ...discovery, sessionId: session.id });
}
