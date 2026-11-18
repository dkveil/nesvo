import type { WorkflowShareBundle } from '@nesvo/contracts/workflow-share';

export const createBundle = (
  overrides: Partial<WorkflowShareBundle> = {},
): WorkflowShareBundle => ({
  version: 1,
  name: 'release',
  description: 'Lint and test before a release.',
  workflow: {
    fileName: 'release.md',
    content:
      '---\nname: release\nsteps: [lint, review]\n---\nRelease checks.\n',
  },
  steps: [
    {
      fileName: 'review.md',
      content:
        '---\nname: review\ntype: agent\nphase: pre-done\n---\nReview the diff.\n',
    },
    {
      fileName: 'lint.md',
      content:
        '---\nname: lint\ntype: command\nphase: pre-done\n---\nbun run lint && echo "<done>"\n',
    },
  ],
  createdWith: { app: 'nesvo', version: '0.1.0' },
  ...overrides,
});
