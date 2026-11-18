import type { DecisionRoute, InboxRuleEntry } from '@nesvo/contracts';

export const routeLabels: Record<DecisionRoute, string> = {
  inbox: 'Inbox',
  parent: 'Parent conversation',
  both: 'Inbox and parent',
};

const actionLabels = {
  hold: 'waits for your decision',
  notify: 'adds an Inbox item',
  ask: 'asks you a question',
} as const;

export const statusTone = {
  unsupported: 'block text-warning-foreground',
} as const;

export const ruleSummary = (entry: InboxRuleEntry) => {
  const rule = entry.rule;
  if (!rule) return 'This rule has errors and does not apply.';
  const when =
    rule.trigger === 'command'
      ? `Before a command matching ${rule.pattern}`
      : rule.trigger === 'mcp-tool'
        ? `Before an MCP tool matching ${rule.pattern}`
        : rule.trigger === 'pull-request'
          ? `Before pull request ${rule.actions?.join(', ')}`
          : rule.trigger === 'workflow-step'
            ? `When a workflow reaches ${[rule.step, rule.phase].filter(Boolean).join(' in ')}`
            : rule.trigger === 'ci-checks'
              ? `When checks turn ${rule.status}`
              : rule.trigger === 'files-changed'
                ? `When files matching ${rule.glob} changed`
                : rule.trigger === 'run-cost'
                  ? `When a run costs more than $${rule.above_usd}`
                  : `When ${rule.trigger.replace('-', ' ')}`;
  const route = rule.route ? ` · ${routeLabels[rule.route]}` : '';
  return `${when}, Nesvo ${actionLabels[rule.action]}${route}.`;
};
