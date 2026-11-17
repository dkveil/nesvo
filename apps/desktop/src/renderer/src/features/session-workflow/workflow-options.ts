import type { DefinitionCatalog, Session } from '@nesvo/contracts';

export type AssignedWorkflow = NonNullable<Session['workflow']>;
export type WorkflowRoot = AssignedWorkflow['root'];

export const rootLabels: Record<WorkflowRoot, string> = {
  project: 'Project',
  global: 'Global',
};

export const workflowRoots: WorkflowRoot[] = ['project', 'global'];

export const sameWorkflow = (
  left: AssignedWorkflow | null,
  right: AssignedWorkflow | null,
) => left?.name === right?.name && left?.root === right?.root;

export const workflowsInRoot = (
  catalog: DefinitionCatalog,
  root: WorkflowRoot,
) => catalog.workflows.filter(workflow => workflow.source.scope === root);

export const assignedWorkflowListed = (
  catalog: DefinitionCatalog,
  assigned: AssignedWorkflow,
) =>
  workflowsInRoot(catalog, assigned.root).some(
    workflow => workflow.name === assigned.name,
  );
