import { useState, type Dispatch, type SetStateAction } from 'react';
import {
  GitPullRequest,
  Sunrise,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { Computer, DesktopApi, HostCapability } from '@nesvo/contracts';
import {
  errorDetail,
  providers,
  providerUsable,
  type ProviderStates,
} from '@/entities/session';
import { useTrackedRepositories } from '@/entities/tracked-repository';
import { useReviewProfiles } from '@/features/edit-automation';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Field } from '@/shared/ui/field';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { CodeReviewSettings } from '@/widgets/code-review-settings';
import { TrackedRepositoriesSettings } from '@/widgets/tracked-repositories-settings';
import { SettingsRow } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';
import {
  morningSummaryJob,
  prePushDefinitions,
  pullRequestReviewJob,
  type StarterJob,
} from './starter-routines';

type Props = {
  api: DesktopApi;
  computer: Computer | undefined;
  statuses: ProviderStates;
  defaultFolder: string | null;
  outcomes: RoutineOutcomes;
  setOutcomes: Dispatch<SetStateAction<RoutineOutcomes>>;
  onChooseComputer: () => void;
  onSetupAgents: () => void;
};

type Outcome =
  | { status: 'pending' | 'error'; message: string }
  | { status: 'added'; message: string; name: string };

type RoutineId = 'morning' | 'review' | 'workflow';
export type RoutineOutcomes = Partial<Record<RoutineId, Outcome>>;
type RoutineAction = { label: string; run: () => void };

type RoutineRowProps = {
  title: string;
  summary: string;
  outcome: Outcome | undefined;
  icon: LucideIcon;
  state: string;
  action: RoutineAction | null;
};

function RoutineRow({
  title,
  summary,
  outcome,
  icon: Icon,
  state,
  action,
}: RoutineRowProps) {
  const pending = outcome?.status === 'pending';
  const added = outcome?.status === 'added';

  return (
    <SettingsRow
      className="gap-3 py-3"
      title={
        <span className="flex items-center gap-2">
          <Icon
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          {title}
        </span>
      }
      description={
        <div className="space-y-0.5 pl-6">
          <p>{summary}</p>
          <StatusMessage
            tone={
              added
                ? 'success'
                : pending
                  ? 'loading'
                  : outcome?.status === 'error'
                    ? 'error'
                    : 'info'
            }
          >
            {outcome?.message || state}
          </StatusMessage>
        </div>
      }
    >
      {action && !added && !pending && (
        <Button variant="outline" onClick={action.run}>
          {action.label}
        </Button>
      )}
    </SettingsRow>
  );
}

export function RoutinesStep({
  api,
  computer,
  statuses,
  defaultFolder,
  outcomes,
  setOutcomes,
  onChooseComputer,
  onSetupAgents,
}: Props) {
  const hostId = computer?.id ?? 'local';
  const connected = computer?.status === 'connected';
  const capable = (capability: HostCapability) =>
    connected && !!computer?.capabilities.includes(capability);
  const [prerequisite, setPrerequisite] = useState<
    'repository' | 'reviewer' | null
  >(null);
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState(defaultFolder ?? '');
  const reviewsSupported =
    capable('pull-request-reviews') && capable('tracked-repositories');
  const profiles = useReviewProfiles(api, hostId, reviewsSupported);
  const tracked = useTrackedRepositories(api, hostId, reviewsSupported);
  const repository = tracked.repositories.find(item => item.directory);
  const profile = profiles.profiles[0];
  const provider = providers.find(item => providerUsable(statuses[item]));
  const record = (id: RoutineId, outcome: Outcome) =>
    setOutcomes(previous => ({ ...previous, [id]: outcome }));
  const run = async (
    id: RoutineId,
    name: string,
    operation: () => Promise<string>,
  ) => {
    if (outcomes[id]?.status === 'pending') return;
    record(id, { status: 'pending', message: 'Adding…' });
    try {
      record(id, { status: 'added', name, message: await operation() });
      return true;
    } catch (failure) {
      record(id, { status: 'error', message: errorDetail(failure) });
      return false;
    }
  };
  const saveJob = async (input: StarterJob | string) => {
    if (typeof input === 'string') throw new Error(input);
    await api.scheduledJobs.save(hostId, input, null);
    return 'Added · Paused';
  };
  const addWorkflow = async () => {
    const directory = target.trim();
    const catalog = await api.workflows.listDefinitions(hostId, { directory });
    const names = new Set(prePushDefinitions.map(item => item.name));
    const taken = [...catalog.steps, ...catalog.workflows].find(
      item => names.has(item.name) && item.source.scope === 'project',
    );
    if (taken)
      throw new Error(
        `“${taken.name}” already exists in ${catalog.roots.project ?? directory}. Nothing was written.`,
      );
    for (const definition of prePushDefinitions) {
      const result = await api.workflows.saveDefinition(hostId, {
        directory,
        scope: 'project',
        kind: definition.kind,
        name: definition.name,
        document: definition.document,
        expectedHash: null,
      });
      if ('type' in result && result.type === 'workflow-definition-conflict')
        throw new Error(
          `“${definition.name}” already exists at ${result.path}.`,
        );
      if ('type' in result)
        throw new Error(
          result.issues.map(issue => issue.message).join(' ') ||
            `“${definition.name}” was refused.`,
        );
    }
    return 'Added · Ready to assign';
  };
  const computerAction = { label: 'Open Computers', run: onChooseComputer };
  const folderAction = {
    label: 'Choose a default folder',
    run: onChooseComputer,
  };
  const setupAgents = { label: 'Set up agents', run: onSetupAgents };
  const morningAction = !connected
    ? computerAction
    : !capable('scheduled-jobs')
      ? null
      : !provider
        ? setupAgents
        : !defaultFolder
          ? folderAction
          : {
              label: 'Add',
              run: () =>
                void run('morning', 'Morning summary', () =>
                  saveJob(
                    morningSummaryJob({
                      hostId,
                      provider,
                      directory: defaultFolder,
                      askFirst: capable('scheduled-job-change-triggers'),
                    }),
                  ),
                ),
            };

  const reviewAction = !connected
    ? computerAction
    : !reviewsSupported ||
        !capable('scheduled-jobs') ||
        !capable('scheduled-job-change-triggers')
      ? null
      : !repository?.directory
        ? {
            label: 'Track a repository',
            run: () => setPrerequisite('repository'),
          }
        : !profile
          ? {
              label: 'Add a reviewer profile',
              run: () => setPrerequisite('reviewer'),
            }
          : {
              label: 'Add',
              run: () =>
                void run('review', 'Pull request review', () =>
                  saveJob(
                    pullRequestReviewJob({
                      hostId,
                      profile,
                      directory: repository.directory!,
                      repository: repository.repository,
                    }),
                  ),
                ),
            };

  const workflowAction = !connected
    ? computerAction
    : !capable('workflows')
      ? null
      : !defaultFolder
        ? folderAction
        : {
            label: 'Add…',
            run: () => {
              setTarget(defaultFolder);
              setConfirming(true);
            },
          };

  return (
    <div className="space-y-3">
      <div className="divide-y rounded-surface border bg-card">
        <RoutineRow
          title="Morning summary"
          icon={Sunrise}
          summary="Catch up on yesterday’s work on weekday mornings."
          state={
            morningAction?.label === 'Add'
              ? 'Paused when added'
              : 'Needs a connected host, a coding agent and a folder'
          }
          outcome={outcomes.morning}
          action={morningAction}
        />
        <RoutineRow
          title="Pull request review"
          icon={GitPullRequest}
          summary="Review new pull requests as they arrive in a tracked repository."
          state={
            reviewAction?.label === 'Add'
              ? 'Paused when added'
              : 'Needs a repository checkout and reviewer profile'
          }
          outcome={outcomes.review}
          action={reviewAction}
        />
        <RoutineRow
          title="Pre-push gates"
          icon={Workflow}
          summary="Run lint, inspect the diff, request review and wait for CI."
          state={
            workflowAction?.label === 'Add…'
              ? 'Unassigned when added'
              : 'Needs a project folder on a host with workflows'
          }
          outcome={outcomes.workflow}
          action={workflowAction}
        />
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Everything is optional and editable. Automations are added paused and
        workflows run only after you choose to use them.
      </p>
      {prerequisite && (
        <Dialog
          open
          onOpenChange={open => {
            if (!open) setPrerequisite(null);
          }}
        >
          <DialogContent className="max-h-[80dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {prerequisite === 'reviewer'
                  ? 'Reviewer profiles'
                  : 'Track a repository'}
              </DialogTitle>
              <DialogDescription>
                Set up pull request review on {computer?.name ?? 'Local'}.
              </DialogDescription>
            </DialogHeader>
            {prerequisite === 'reviewer' ? (
              <CodeReviewSettings computer={computer} api={api} />
            ) : (
              <TrackedRepositoriesSettings computer={computer} api={api} />
            )}
          </DialogContent>
        </Dialog>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        tone="default"
        title="Add the pre-push gates workflow?"
        description="Save one editable workflow and its four steps to .agents/workflows in the selected project."
        confirmLabel="Write files"
        pendingLabel="Writing…"
        onConfirm={() =>
          target && run('workflow', 'Pre-push gates', addWorkflow)
        }
      >
        <Field id="onboarding-workflow-folder" label="Project folder" as="span">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 break-all text-ui">{target}</p>
            <Button
              variant="outline"
              onClick={() => {
                void api.chooseDirectory().then(
                  directory => {
                    if (directory) setTarget(directory);
                  },
                  failure =>
                    record('workflow', {
                      status: 'error',
                      message: errorDetail(failure),
                    }),
                );
              }}
            >
              Choose folder
            </Button>
          </div>
        </Field>
      </ConfirmDialog>
    </div>
  );
}
