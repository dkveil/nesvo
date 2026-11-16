import type { WorkflowAssistantDocument } from '@nesvo/contracts';

export type AssistantView = 'editor' | 'workflows' | 'automations';

export type AssistantContext = {
  view: AssistantView;
  workflowName: string | null;
  document: WorkflowAssistantDocument | null;
  selection: string[];
};

export const assistantArea = (context: AssistantContext) =>
  context.view === 'workflows' ? '' : context.view;

export const assistantSubject = (context: AssistantContext) => {
  if (context.view === 'automations') return 'Automations';
  if (context.workflowName) return context.workflowName;
  return 'Workflows';
};

export const assistantIntro = (context: AssistantContext) => {
  if (context.view === 'automations')
    return 'Describe when something should run. The assistant can create a workflow and the automation that schedules it.';
  if (context.workflowName)
    return `Describe a change to ${context.workflowName}. Steps and connections appear on the canvas as the assistant works.`;
  return 'Describe a workflow to build or a question about the ones you have. New workflows appear in the list as the assistant works.';
};

export const assistantSuggestions = (context: AssistantContext): string[] => {
  if (context.view === 'automations')
    return [
      'Run the quick checks every weekday at 09:00',
      'Create a nightly workflow that reviews the day’s commits',
      'Which automations run on this computer and when?',
    ];
  if (context.workflowName)
    return [
      'Add a lint check that runs before the tests',
      'Insert a human approval before anything is pushed',
      'Collect the logs when the tests fail',
      'Explain what this workflow does, step by step',
    ];
  return [
    'Create a release workflow: typecheck and tests in parallel, a review, then an approval',
    'Which workflows have no human gate before an external action?',
    'Add a quick-check workflow with lint and tests only',
  ];
};
