import type { Computer, SetupScan } from '@nesvo/contracts';
import { providers, type ProviderStates } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { MiddleTruncatedText } from '@/shared/ui/middle-truncated-text';
import { StatusMessage } from '@/shared/ui/status-message';
import { SetupProfileSettings } from '@/widgets/settings/setup-profile-settings';
import { SetupActivation } from './setup-activation';

type Props = {
  computers: Computer[];
  statuses: ProviderStates;
  folder: string | null;
  routines: string[];
  setup?: SetupScan | null;
  error?: string;
  approvalCount: number;
  approvalsOpen: boolean;
  onReviewApprovals: () => void;
  onReviewSetup: () => void;
};

const summaryRow =
  'grid grid-cols-[minmax(0,1fr)_minmax(0,1.65fr)] items-center gap-4 px-3';

export function FinishStep({
  computers,
  statuses,
  folder,
  routines,
  setup,
  error,
  approvalCount,
  approvalsOpen,
  onReviewApprovals,
  onReviewSetup,
}: Props) {
  const local = computers.find(computer => computer.id === 'local');
  const detected = providers.filter(provider => {
    const status = statuses[provider].status?.status;
    return (
      status === 'ready' ||
      status === 'unauthenticated' ||
      status === 'unsupported'
    );
  });
  const summary = [
    {
      label: 'Agents detected',
      value:
        detected.join(', ') ||
        (providers.some(provider => statuses[provider].loading)
          ? 'Checking…'
          : 'None detected'),
    },
    {
      label: 'Computers',
      value: computers.map(computer => computer.name).join(', ') || 'Local',
    },
    {
      label: 'Local default folder',
      value: folder ?? 'Isolated folder',
      path: folder,
    },
    {
      label: 'Routines added',
      value: routines.join(', ') || 'None added',
    },
    ...(setup
      ? [
          {
            label: 'Setup skipped',
            value: String(
              setup.choices?.filter(item => item.choice === 'skip').length ?? 0,
            ),
          },
        ]
      : []),
  ];
  return (
    <div className="space-y-4 text-center">
      <header className="space-y-3">
        <h1
          id="onboarding-title"
          className="text-display font-semibold tracking-tight"
        >
          This is how Nesvo will work
        </h1>
      </header>
      <dl className="mx-auto max-w-lg divide-y text-left">
        {summary.map(({ label, value, path }) => (
          <div key={label} className={`${summaryRow} py-2`}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="min-w-0 text-right text-ui">
              {path ? (
                <MiddleTruncatedText
                  path
                  value={path}
                  className="justify-end"
                />
              ) : (
                <p className="truncate" title={value}>
                  {value}
                </p>
              )}
            </dd>
          </div>
        ))}
        {approvalCount > 0 && (
          <div className={`${summaryRow} py-1`}>
            <dt className="text-xs text-muted-foreground">
              {approvalCount} local{' '}
              {approvalCount === 1 ? 'approval' : 'approvals'} to review
            </dt>
            <dd className="flex justify-end">
              <Button
                size="xs"
                variant="ghost"
                aria-controls={
                  approvalsOpen ? 'onboarding-local-approvals' : undefined
                }
                aria-expanded={approvalsOpen}
                onClick={onReviewApprovals}
              >
                Review
              </Button>
            </dd>
          </div>
        )}
      </dl>
      {error && (
        <div className="mx-auto flex max-w-lg flex-wrap items-center justify-center gap-2">
          <StatusMessage tone="error">{error}</StatusMessage>
          <Button size="xs" variant="outline" onClick={onReviewSetup}>
            Review setup again
          </Button>
        </div>
      )}
      {local?.status === 'connected' &&
        local.capabilities.includes('setup-profile-v1') && (
          <SetupActivation key={local.instanceId} computer={local} />
        )}
      <div className="flex justify-center">
        <SetupProfileSettings computer={local} saveOnly />
      </div>
    </div>
  );
}
