import type { DefinitionScope } from '@nesvo/contracts';

export const savedInLabels = {
  project: 'This project',
  global: 'Global',
} satisfies Record<DefinitionScope, string>;

export const savedInHint = (
  scope: DefinitionScope,
  projectPath = '.agents/workflows',
) =>
  scope === 'project'
    ? `Saved in the repository (${projectPath}), shared with everyone who uses it`
    : 'Saved in your Nesvo configuration on this computer, available in every project';
