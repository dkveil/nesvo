import type { ResolvedWorkflow } from '@nesvo/contracts';
import { configurationHash } from '../workflows/configuration-changes';

export function profileWorkflowIdentity(
  workflow: ResolvedWorkflow,
  spec: ResolvedWorkflow['source'],
) {
  if (workflow.steps.some(step => !['human', 'probe'].includes(step.type)))
    throw new Error(
      'This workflow contains steps without a reviewed direct execution path for profile automations.',
    );
  return configurationHash(
    JSON.stringify([
      spec,
      workflow.source,
      workflow.steps.map(step => step.source),
    ]),
  );
}
