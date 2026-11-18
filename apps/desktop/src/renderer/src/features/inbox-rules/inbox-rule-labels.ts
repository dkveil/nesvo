import type { HostedInboxItem } from './use-inbox-items';

const triggerLabels: Record<HostedInboxItem['trigger'], string> = {
  command: 'Before a command',
  'pull-request': 'Before a pull request action',
  'mcp-tool': 'Before an MCP tool call',
  'plan-ready': 'Plan ready',
  'stage-report': 'Stage report',
  'stage-question': 'Question',
  'workflow-step': 'Workflow step',
  'session-finished': 'Session finished',
  'ci-checks': 'Pull request checks',
  'files-changed': 'Files changed',
  'run-cost': 'Run cost',
};

const statusLabels: Record<HostedInboxItem['status'], string> = {
  pending: 'Waiting for you',
  approved: 'Approved',
  declined: 'Declined',
  answered: 'Answered',
  dismissed: 'Dismissed',
  interrupted: 'Interrupted',
};

export const inboxRuleMeta = (item: HostedInboxItem) =>
  `Inbox rule ${item.rule.name} · ${triggerLabels[item.trigger]} · ${statusLabels[item.status]}`;
