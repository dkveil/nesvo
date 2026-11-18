import { useState, type RefObject } from 'react';
import type {
  Computer,
  DesktopApi,
  SaveScheduledJobInput,
} from '@nesvo/contracts';
import type { ScheduledJob } from '@/entities/scheduled-job';
import {
  errorDetail,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import { useTrackedRepositories } from '@/entities/tracked-repository';
import {
  modelEfforts,
  resolveEffort,
} from '@/features/new-thread/reasoning-effort';
import {
  automationValues,
  SKILL_PROMPT_MESSAGE,
  toSaveInput,
  validateAutomation,
  type AutomationField,
  type AutomationValues,
} from './automation-form';
import { useReviewProfiles } from './use-review-profiles';

type SaveInput = Omit<SaveScheduledJobInput, 'expectedRevision'>;

export type AutomationEditorProps = {
  initial: AutomationValues;
  job: ScheduledJob | null;
  editing: boolean;
  computers: Computer[];
  statuses: (hostId: string) => ProviderStates;
  onRefreshProvider: (provider: Provider, hostId: string) => void;
  onManageComputers: () => void;
  onSave: (
    hostId: string,
    input: SaveInput,
    expectedRevision: number | null,
  ) => Promise<ScheduledJob>;
  onRecover: (hostId: string, id: string) => Promise<ScheduledJob | undefined>;
  onSaved: (job: ScheduledJob) => void;
  onClose: () => void;
  reviewApi?: (
    hostId: string,
  ) => Pick<DesktopApi, 'readCodeReviewSettings' | 'listTrackedRepositories'>;
};

const fieldOrder: AutomationField[] = [
  'name',
  'prompt',
  'review',
  'workspace',
  'browser',
  'model',
  'minutes',
  'time',
  'timeZone',
  'checkCommand',
  'dailyRunCap',
  'timeoutMinutes',
];

export function useAutomationEditor(
  {
    initial,
    job,
    editing,
    computers,
    statuses,
    onRefreshProvider,
    onManageComputers,
    onSave,
    onRecover,
    onSaved,
    onClose,
    reviewApi,
  }: AutomationEditorProps,
  form: RefObject<HTMLFormElement | null>,
) {
  const [values, setValues] = useState(initial);
  const [baseRevision, setBaseRevision] = useState(job?.revision ?? null);
  const [touched, setTouched] = useState<AutomationField[]>([]);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const computer = computers.find(item => item.id === values.hostId);
  const connected = computer?.status === 'connected';
  const supportsRituals =
    !!computer?.capabilities.includes('automation-rituals');
  const supportsCheck = !!computer?.capabilities.includes(
    'scheduled-job-change-triggers',
  );
  const supportsReviews =
    !!reviewApi && !!computer?.capabilities.includes('pull-request-reviews');
  const reviewProfiles = useReviewProfiles(
    supportsReviews && reviewApi ? reviewApi(values.hostId) : null,
    values.hostId,
    supportsReviews && connected && values.reviewMode,
  );
  const trackedRepositories = useTrackedRepositories(
    supportsReviews && reviewApi ? reviewApi(values.hostId) : null,
    values.hostId,
    supportsReviews &&
      connected &&
      values.reviewMode &&
      !!computer?.capabilities.includes('tracked-repositories'),
  );
  const reviewProfile = reviewProfiles.profiles.find(
    profile => profile.id === values.reviewProfileId,
  );
  const providerStates = statuses(values.hostId);
  const providerState = providerStates[values.provider];
  const models = providerState.status?.models ?? [];
  const modelListed = models.some(option => option.id === values.model);
  const model =
    editing || models.length === 0 || modelListed
      ? values.model
      : (models[0]?.id ?? '');
  const catalogReady = !!providerState.status && modelListed;
  const effort =
    values.provider !== 'Codex'
      ? ''
      : catalogReady
        ? resolveEffort(modelEfforts(providerState, model), values.effort)
        : values.effort;
  const catalogNotice =
    !providerState.status || providerState.loading
      ? `${values.provider} has not reported its models on ${computer?.name ?? 'this computer'} yet. The chosen model and effort are kept.`
      : models.length > 0 && !modelListed
        ? `${values.provider} no longer reports this model. Choose another one or runs may fail.`
        : '';
  const resolved =
    values.reviewMode && reviewProfile
      ? {
          ...values,
          provider: reviewProfile.provider,
          model: reviewProfile.model,
          effort: reviewProfile.effort ?? '',
        }
      : { ...values, model, effort };
  const errors = validateAutomation(resolved);
  const visible = (field: AutomationField) =>
    attempted ||
    touched.includes(field) ||
    (field === 'prompt' && errors.prompt === SKILL_PROMPT_MESSAGE)
      ? errors[field]
      : undefined;
  const blockedReason =
    editing && !job
      ? 'This automation was deleted on its computer.'
      : !computer
        ? 'Choose a computer that supports automations.'
        : !connected
          ? `${computer.name} is offline. Connect it to save this automation.`
          : values.checkEnabled && !supportsCheck
            ? 'Update this computer’s Nesvo host to use automation change checks.'
            : (values.writable || values.redCi || values.browser) &&
                !supportsRituals
              ? 'Update this computer’s Nesvo host to use worktrees, browser workflows or CI triggers.'
              : '';
  const locationHints = [
    values.hostId === 'local' ? 'Runs only while Nesvo is open.' : '',
    values.workflow
      ? 'A workflow automation stays in the project of its workflow.'
      : editing
        ? 'An automation stays on the computer it was created on.'
        : '',
  ].filter(Boolean);
  const touch = (field: AutomationField) =>
    setTouched(previous =>
      previous.includes(field) ? previous : [...previous, field],
    );
  const change = (patch: Partial<AutomationValues>) =>
    setValues(previous => ({ ...previous, ...patch }));
  const reload = () => {
    if (!job) return;
    setValues(automationValues(job));
    setBaseRevision(job.revision);
    setStale(false);
    setError('');
  };
  const save = async () => {
    if (pending || blockedReason) return;
    setAttempted(true);
    const invalid = fieldOrder.find(field => errors[field]);
    if (invalid) {
      form.current
        ?.querySelector<HTMLElement>(`[data-field="${invalid}"]`)
        ?.focus();
      return;
    }
    const input = toSaveInput(resolved, resolved.effort);
    if (typeof input === 'string') {
      setError(input);
      return;
    }
    setPending(true);
    setError('');
    setStale(false);
    try {
      onSaved(await onSave(values.hostId, input, baseRevision));
    } catch (failure) {
      const detail = errorDetail(failure);
      if (/changed elsewhere/i.test(detail)) {
        setStale(true);
        return;
      }
      if (!editing && /already exists/i.test(detail)) {
        const recovered = await onRecover(values.hostId, values.id).catch(
          () => undefined,
        );
        if (recovered) {
          onSaved(recovered);
          return;
        }
      }
      setError(`Could not save the automation. ${detail}`);
    } finally {
      setPending(false);
    }
  };
  return {
    values,
    editing,
    computers,
    computer,
    pending,
    error,
    stale,
    blockedReason,
    errors,
    visible,
    touch,
    change,
    reload,
    save,
    close: onClose,
    manageComputers: onManageComputers,
    refreshProvider: (provider: Provider) =>
      onRefreshProvider(provider, values.hostId),
    locationOpen,
    setLocationOpen,
    locationHints,
    supportsCheck,
    supportsRituals,
    supportsReviews,
    reviewProfiles,
    trackedRepositories,
    providerStates,
    model,
    effort,
    catalogNotice,
  };
}

export type AutomationEditorState = ReturnType<typeof useAutomationEditor>;
