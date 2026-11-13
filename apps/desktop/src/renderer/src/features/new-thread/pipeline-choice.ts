import type { DefinitionCatalog } from '@nesvo/contracts';
import type { Provider } from '@/entities/session';

export type PipelineChoice = {
  pipelineName: string;
  specPath: string;
  specTitle: string | null;
  isolation: boolean;
  gateProvider: Provider;
  gateModel: string;
};

const samePath = (left: string, right: string) =>
  left.replace(/\\/g, '/').toLowerCase() ===
  right.replace(/\\/g, '/').toLowerCase();

export function pipelineIssues(
  catalog: DefinitionCatalog,
  pipelineName: string,
  specPath: string,
) {
  const pipeline = catalog.pipelines.find(item => item.name === pipelineName);
  const paths = [
    pipeline?.source.path,
    ...(pipeline?.steps.map(step => step.source.path) ?? []),
    specPath.trim() || undefined,
  ].filter((path): path is string => !!path);
  return catalog.issues.filter(
    issue =>
      paths.some(path => samePath(path, issue.path)) ||
      issue.message.includes(`"${pipelineName}"`),
  );
}
