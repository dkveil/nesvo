import {
  GATE_RULES_PER_STEP,
  type DefinitionIssue,
  type ResolvedGateRule,
  type ResolvedStep,
} from '@nesvo/contracts';
import {
  readRuleEntryFolder,
  type RuleEntryRoot,
  type StoredRuleEntry,
} from './rule-entry-files';

export const activeGateRule = (rule: ResolvedGateRule) =>
  rule.status === 'active' && rule.enforcedBy === 'none';

export const gateRuleMatches = (
  rule: ResolvedGateRule,
  step: string,
  workflow?: string,
) =>
  rule.scope.steps?.includes(step) &&
  (!workflow ||
    !rule.scope.workflows ||
    rule.scope.workflows.includes(workflow));

export const resolvedGateRule = (
  stored: StoredRuleEntry,
): ResolvedGateRule => ({
  ...stored.entry,
  type: 'gate-rule',
  source: {
    scope: stored.root.scope,
    path: stored.path,
    contentHash: stored.hash,
  },
});

export const mergeGateRules = (stored: readonly StoredRuleEntry[]) =>
  [
    ...new Map(
      stored.map(item => [item.entry.id, resolvedGateRule(item)]),
    ).values(),
  ].sort((left, right) => left.id.localeCompare(right.id, 'en'));

export const gateRuleLimitMessage = (step: string) =>
  `Step "${step}" has more than ${GATE_RULES_PER_STEP} active gate rules. Update an existing gate rule.`;

export const readGateRules = (
  roots: readonly RuleEntryRoot[],
  steps: ReadonlyMap<string, ResolvedStep>,
  issues: DefinitionIssue[],
) => {
  const stored: StoredRuleEntry[] = [];
  for (const root of roots) {
    const read = readRuleEntryFolder('gate-rule', root);
    stored.push(...read.entries);
    for (const message of read.issues)
      issues.push({
        path: root.root,
        line: null,
        severity: 'error',
        message: message.slice(0, 800),
      });
  }
  const invalidSteps = new Set<string>();
  const rules = mergeGateRules(stored);
  for (const rule of rules) {
    for (const name of rule.scope.steps ?? []) {
      const step = steps.get(name);
      if (step?.type === 'agent') continue;
      if (step) invalidSteps.add(name);
      issues.push({
        path: rule.source.path,
        line: null,
        severity: step ? 'error' : 'warning',
        message: step
          ? `Gate rule "${rule.id}" must target an agent step. "${name}" is ${step.type}.`
          : `Gate rule "${rule.id}" targets missing step "${name}".`,
      });
    }
  }
  return { rules, invalidSteps };
};
