import { z } from 'zod';

export const claudeCommandLimits = {
  entries: 500,
  name: 256,
  description: 1000,
  argumentHint: 256,
  detail: 800,
} as const;

export const listClaudeCommandsSchema = z.strictObject({
  sessionId: z.uuid(),
});

export const claudeCommandSchema = z.strictObject({
  name: z.string().min(1).max(claudeCommandLimits.name),
  description: z.string().max(claudeCommandLimits.description),
  argumentHint: z.string().max(claudeCommandLimits.argumentHint).nullable(),
});

export const claudeCommandListSchema = z.strictObject({
  sessionId: z.uuid(),
  status: z.enum(['ready', 'unavailable']),
  detail: z.string().max(claudeCommandLimits.detail).nullable(),
  commands: z.array(claudeCommandSchema).max(claudeCommandLimits.entries),
  projectCommands: z.boolean(),
  checkedAt: z.iso.datetime(),
});

const managedCommandReasons: Record<string, string> = {
  compact: 'Use Compact conversation in Nesvo, so the compaction is recorded.',
  clear:
    'Start a new session or fork this one; clearing would detach the recorded conversation.',
  model: 'Choose the model in the composer.',
  effort: 'Choose the effort in the composer.',
  fast: 'Choose the model and effort in the composer.',
  rename: 'Rename the session in Nesvo.',
  resume: 'Nesvo resumes the recorded conversation itself.',
  continue: 'Nesvo resumes the recorded conversation itself.',
  exit: 'Use Stop to end a turn.',
  quit: 'Use Stop to end a turn.',
  login: 'Sign in with Claude Code in a terminal.',
  logout: 'Sign out with Claude Code in a terminal.',
  cost: 'Nesvo shows the cost of this session.',
  usage: 'Nesvo shows the provider limits in the usage rail.',
  'usage-credits': 'Nesvo shows the provider limits in the usage rail.',
  'extra-usage': 'Nesvo shows the provider limits in the usage rail.',
};

const terminalCommands = new Set([
  'add-dir',
  'agents',
  'auto-mode-setup',
  'autocompact',
  'bug',
  'chrome',
  'color',
  'config',
  'design-consent',
  'design-revoke',
  'doctor',
  'export',
  'feedback',
  'focus',
  'heapdump',
  'help',
  'hooks',
  'ide',
  'import',
  'insights',
  'install-github-app',
  'keybindings',
  'list-agents',
  'mcp',
  'memory',
  'mobile',
  'output-style',
  'permissions',
  'plugin',
  'plugins',
  'privacy-settings',
  'release-notes',
  'reload-plugins',
  'reload-skills',
  'remote-control',
  'rewind',
  'settings',
  'skill-doctor',
  'status',
  'statusline',
  'tasks',
  'team-onboarding',
  'terminal-setup',
  'theme',
  'todos',
  'ultrareview',
  'upgrade',
  'vim',
  'workflow-launch-exec',
]);

const typedClaudeCommandPattern = /^\/([\w.:-]+)(?=\s|$)/;

export const typedClaudeCommand = (text: string): string | null =>
  typedClaudeCommandPattern.exec(text.trimStart())?.[1]?.toLowerCase() ?? null;

export const claudeCommandRefusal = (name: string): string | null => {
  const command = name.toLowerCase();
  if (command.startsWith('_'))
    return `/${command} is internal to Claude Code and cannot be sent from Nesvo.`;
  const managed = managedCommandReasons[command];
  if (managed) return `/${command} is not sent to Claude Code. ${managed}`;
  if (terminalCommands.has(command))
    return `/${command} opens an interactive Claude Code screen. Run it in a terminal.`;
  return null;
};

export type ListClaudeCommandsInput = z.infer<typeof listClaudeCommandsSchema>;
export type ClaudeCommand = z.infer<typeof claudeCommandSchema>;
export type ClaudeCommandList = z.infer<typeof claudeCommandListSchema>;
