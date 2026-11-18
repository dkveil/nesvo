import type { AutomationValues } from './automation-form';

export function automationEditorTitle(editing: boolean): string {
  return editing ? 'Edit automation' : 'New automation';
}

export function automationEditorDescription(values: AutomationValues): string {
  if (values.workflow)
    return 'Runs a workflow on a schedule. Each run is a workflow run with its result in the Inbox.';
  if (values.reviewMode)
    return 'Starts an agent review for each new or updated pull request. Draft reviews reach the Inbox and are never published automatically.';
  return 'Runs a read-only prompt on a schedule. Each run is a session with its result in the Inbox.';
}
