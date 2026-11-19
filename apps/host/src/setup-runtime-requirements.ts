type Requirement = { capabilities: readonly string[]; description: string };

const requirements: Record<string, Requirement> = {
  worktrees: {
    capabilities: ['custom-worktree-providers'],
    description:
      'Requires the worktree provider inspection and ownership contract.',
  },
  recipes: {
    capabilities: ['worktree-recipes'],
    description:
      'Requires direct argv recipes and review of the complete setup and cleanup chain.',
  },
  repositoryTrust: {
    capabilities: ['repository-trust-rules'],
    description:
      'Requires canonical repository identity and reviewed definitions.',
  },
  integrations: {
    capabilities: ['readonly-integration-grants'],
    description:
      'Requires verified selective hook or MCP loading for the provider and account.',
  },
  externalMessages: {
    capabilities: ['external-session-messages', 'session-message-watchers'],
    description:
      'Requires a locally bound device, verified targets and separate approval to start a watcher.',
  },
  limits: {
    capabilities: ['provider-usage-gates'],
    description:
      'Requires verified account and quota-window evidence and the corresponding usage policy.',
  },
};

export function setupRuntimeRequirement(key: string): Requirement | undefined {
  return requirements[key.split('/')[0] ?? ''];
}
