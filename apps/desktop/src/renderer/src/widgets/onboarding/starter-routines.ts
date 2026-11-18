import type { ReviewerProfile, SaveScheduledJobInput } from '@nesvo/contracts';
import type { Provider } from '@/entities/session';
import {
  newAutomationValues,
  REVIEW_CHECK_COMMAND,
  toSaveInput,
} from '@/features/edit-automation';

export type StarterJob = Omit<SaveScheduledJobInput, 'expectedRevision'>;

export const MORNING_SUMMARY_PROMPT =
  'Summarize the work in this folder since yesterday morning: the commits, branches and changed files, anything left unfinished, and the first task worth picking up today. Do not change any files.';

const MORNING_CHECK_COMMAND = JSON.stringify([
  'git',
  'log',
  '--since=yesterday',
  '--oneline',
]);

export function morningSummaryJob({
  hostId,
  provider,
  directory,
  askFirst,
}: {
  hostId: string;
  provider: Provider;
  directory: string;
  askFirst: boolean;
}): StarterJob | string {
  return toSaveInput(
    {
      ...newAutomationValues(hostId, provider, 'default'),
      name: 'Morning summary',
      prompt: MORNING_SUMMARY_PROMPT,
      directory,
      time: '08:30',
      active: false,
      checkEnabled: askFirst,
      checkCommand: MORNING_CHECK_COMMAND,
      dailyRunCap: '1',
      askFirst: true,
    },
    '',
  );
}

export function pullRequestReviewJob({
  hostId,
  profile,
  directory,
  repository,
}: {
  hostId: string;
  profile: ReviewerProfile;
  directory: string;
  repository: string;
}): StarterJob | string {
  return toSaveInput(
    {
      ...newAutomationValues(hostId, profile.provider, profile.model),
      name: `Review pull requests in ${repository}`.slice(0, 80),
      directory,
      scheduleKind: 'interval',
      minutes: '60',
      active: false,
      reviewMode: true,
      reviewProfileId: profile.id,
      checkEnabled: true,
      checkCommand: REVIEW_CHECK_COMMAND,
      askFirst: true,
    },
    profile.effort ?? '',
  );
}

export const PRE_PUSH_WORKFLOW = 'pre-push-gates';

export const prePushDefinitions: {
  kind: 'step' | 'workflow';
  name: string;
  document: string;
}[] = [
  {
    kind: 'step',
    name: 'pre-push-lint',
    document: `---
name: pre-push-lint
type: command
phase: pre-push
timeout: 10m
---
npm run lint --if-present
`,
  },
  {
    kind: 'step',
    name: 'pre-push-probe',
    document: `---
name: pre-push-probe
type: probe
phase: pre-push
probe: all
---
Reads the current diff for secrets, personal data, test changes and size.
`,
  },
  {
    kind: 'step',
    name: 'pre-push-review',
    document: `---
name: pre-push-review
type: agent
phase: pre-push
timeout: 20m
retries: 2
idempotent: true
on_fail: fix
---
Review the change that is about to be pushed. Check correctness, missing tests and every probe finding. Fail this step with the corrections that are required before pushing; the author fixes them and the review runs again.
`,
  },
  {
    kind: 'step',
    name: 'pre-push-ci',
    document: `---
name: pre-push-ci
type: wait-ci
phase: pre-push
timeout: 45m
poll_interval: 30s
---
Waits for the checks of the session's pull request.
`,
  },
  {
    kind: 'workflow',
    name: PRE_PUSH_WORKFLOW,
    document: `---
name: ${PRE_PUSH_WORKFLOW}
description: Lint, probe the diff, review until it is clean, then wait for pull request checks.
steps: [pre-push-lint, pre-push-probe, pre-push-review, pre-push-ci]
---
An example added from Getting started. Change the lint command to match this project.
`,
  },
];
