import type {
  InboxRule,
  InboxRuleEnforcement,
  InboxRuleTrigger,
  Provider,
  SessionMode,
} from '@nesvo/contracts';

type Enforcement = Pick<InboxRuleEnforcement, 'status' | 'detail'>;

const providerModes: Record<Provider, SessionMode[]> = {
  'Claude Code': ['read-only', 'accept-edits', 'auto'],
  Codex: ['read-only', 'supervised'],
};

const hostDetected: Enforcement = {
  status: 'enforced',
  detail: 'Nesvo detects this on the host for every session kind.',
};

const commandEnforcement = (
  provider: Provider,
  mode: SessionMode,
): Enforcement => {
  if (provider === 'Claude Code')
    return mode === 'auto'
      ? {
          status: 'enforced',
          detail:
            'Matching commands ask through the host permission prompt, also in Auto. A CLI without the host prompt channel cannot hold them.',
        }
      : {
          status: 'unreachable',
          detail:
            mode === 'read-only'
              ? 'Plan has no shell, so the command cannot run.'
              : 'Accept edits has no shell, so the command cannot run.',
        };
  return mode === 'supervised'
    ? {
        status: 'enforced',
        detail:
          'Commands Codex asks to approve are held. Commands its untrusted policy treats as safe read-only commands run without a request.',
      }
    : {
        status: 'unsupported',
        detail:
          'Codex runs commands in its read-only sandbox without a request; writes and network access are blocked there.',
      };
};

const mcpEnforcement = (
  provider: Provider,
  mode: SessionMode,
): Enforcement => {
  if (provider === 'Claude Code')
    return {
      status: 'enforced',
      detail:
        'Matching MCP tool calls ask through the host permission prompt in every mode.',
    };
  return mode === 'read-only'
    ? {
        status: 'enforced',
        detail:
          'Held when the app-server supports MCP tool approvals; otherwise MCP is isolated in Read-only.',
      }
    : {
        status: 'unsupported',
        detail:
          'Codex does not ask before MCP tool calls in Workspace edits, so they cannot be held.',
      };
};

export const enforcementFor = (
  trigger: InboxRuleTrigger,
  provider: Provider,
  mode: SessionMode,
): Enforcement => {
  if (trigger === 'command') return commandEnforcement(provider, mode);
  if (trigger === 'mcp-tool') return mcpEnforcement(provider, mode);
  if (trigger === 'pull-request') {
    const command = commandEnforcement(provider, mode);
    return command.status === 'enforced'
      ? command
      : {
          status: command.status,
          detail: `Pull request actions in the Nesvo pull request surface are held. For gh commands: ${command.detail}`,
        };
  }
  return hostDetected;
};

export const ruleEnforcement = (rule: InboxRule): InboxRuleEnforcement[] =>
  (Object.keys(providerModes) as Provider[])
    .filter(provider => !rule.providers || rule.providers.includes(provider))
    .flatMap(provider => {
      const grouped = new Map<string, InboxRuleEnforcement>();
      for (const mode of providerModes[provider]) {
        if (rule.modes && !rule.modes.includes(mode)) continue;
        const found = enforcementFor(rule.trigger, provider, mode);
        const key = `${found.status}:${found.detail}`;
        const entry = grouped.get(key);
        if (entry) entry.modes.push(mode);
        else
          grouped.set(key, {
            provider,
            modes: [mode],
            status: found.status,
            detail: found.detail,
          });
      }
      return [...grouped.values()];
    });

export const claudeAskRule = (pattern: string) => {
  const trimmed = pattern.trim().replace(/\s+/g, ' ');
  const prefix = /^[^*?]+\*$/.test(trimmed) ? trimmed.slice(0, -1).trim() : null;
  return prefix ? `Bash(${prefix}:*)` : `Bash(${trimmed})`;
};
