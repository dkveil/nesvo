import type { DefinitionCatalog } from '@nesvo/contracts';
import type { Provider, ProviderStates } from '@/entities/session';

export type WorkflowChoice = {
  workflowName: string;
  specPath: string;
  specTitle: string | null;
  isolation: boolean;
  gateProvider: Provider;
  gateModel: string;
  gateEdited: boolean;
};

export const otherProvider = (provider: Provider): Provider =>
  provider === 'Codex' ? 'Claude Code' : 'Codex';

export const gateModels = (statuses: ProviderStates, provider: Provider) => {
  const models = statuses[provider].status?.models ?? [];
  return models.length > 0
    ? models.map(model => ({ id: model.id, label: model.label }))
    : [{ id: 'default', label: 'Default' }];
};

export function resolveGate(
  choice: WorkflowChoice | null,
  authorProvider: Provider,
  statuses: ProviderStates,
) {
  const provider = choice?.gateEdited
    ? choice.gateProvider
    : otherProvider(authorProvider);
  const models = gateModels(statuses, provider);
  const model =
    choice?.gateEdited && models.some(item => item.id === choice.gateModel)
      ? choice.gateModel
      : models[0]!.id;
  return { provider, model, models };
}

const samePath = (left: string, right: string) =>
  left.replace(/\\/g, '/').toLowerCase() ===
  right.replace(/\\/g, '/').toLowerCase();

export function workflowIssues(
  catalog: DefinitionCatalog,
  workflowName: string,
  specPath: string,
) {
  const workflow = catalog.workflows.find(item => item.name === workflowName);
  const paths = [
    workflow?.source.path,
    ...(workflow?.steps.map(step => step.source.path) ?? []),
    specPath.trim() || undefined,
  ].filter((path): path is string => !!path);
  return catalog.issues.filter(
    issue =>
      paths.some(path => samePath(path, issue.path)) ||
      issue.message.includes(`"${workflowName}"`),
  );
}
