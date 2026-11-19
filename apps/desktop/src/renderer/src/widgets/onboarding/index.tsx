import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import {
  managerImportSources,
  type ManagerImportSource,
  type SetupScan,
} from '@nesvo/contracts';
import type { Provider } from '@/entities/session';
import { useDefaultSessionFolders } from '@/features/default-session-folder';
import {
  ManagerImportPicker,
  type DetectedImports,
} from '@/features/import-manager';
import { managerImportSummary } from '@/features/import-manager/summary';
import { Button } from '@/shared/ui/button';
import { Progress } from '@/shared/ui/progress';
import { SectionLabel } from '@/shared/ui/section-label';
import { ComputersStep } from './computers-step';
import { FinishStep } from './finish-step';
import { InboxStep } from './inbox-step';
import { ProvidersStep } from './providers-step';
import { RoutinesStep, type RoutineOutcomes } from './routines-step';
import { SetupProfileSettings } from '@/widgets/settings/setup-profile-settings';
import { SetupFindings } from '@/widgets/settings/setup-findings';
import { OnboardingStepLayout } from './step-layout';
import { useOnboardingComputers } from './use-onboarding-computers';
import { WelcomeStep } from './welcome-step';

type Props = {
  onStartSession: (provider: Provider | null) => void;
  onClose: () => void;
};

const steps = [
  { id: 'welcome' },
  {
    id: 'providers',
    title: 'Coding agents',
    description: 'Nesvo runs the agents you already have installed.',
  },
  {
    id: 'import',
    title: 'Import sessions',
    description: 'Select the sessions and groups to bring into Nesvo.',
  },
  {
    id: 'computers',
    title: 'Computers',
    description:
      'Choose where local sessions start or connect a server over SSH.',
  },
  {
    id: 'setup',
    title: 'Your setup',
    description: 'Review a profile and what Nesvo found on this computer.',
  },
  {
    id: 'inbox',
    title: 'Your Inbox',
    description: 'Choose what reaches you and when agents wait for you.',
  },
  {
    id: 'routines',
    title: 'Starter routines',
    description: 'Add editable templates for work you repeat.',
  },
  { id: 'finish' },
] as const;

export function Onboarding({ onStartSession, onClose }: Props) {
  const api = window.nesvo;
  const [stepId, setStepId] = useState<(typeof steps)[number]['id']>('welcome');
  const [editingComputer, setEditingComputer] = useState(false);
  const [detected, setDetected] = useState<DetectedImports>();
  const [importSource, setImportSource] = useState<ManagerImportSource>();
  const [checkingImports, setCheckingImports] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importCompleted, setImportCompleted] = useState(false);
  const [outcomes, setOutcomes] = useState<RoutineOutcomes>({});
  const [setupScan, setSetupScan] = useState<SetupScan | null>(null);
  const [setupImports, setSetupImports] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [setupError, setSetupError] = useState('');
  const { computers, local, error, statuses, checkProviders } =
    useOnboardingComputers(api);
  const defaultFolders = useDefaultSessionFolders(computers);
  const visibleSteps = steps.filter(
    step => step.id !== 'import' || Object.keys(detected ?? {}).length,
  );
  const index = visibleSteps.findIndex(step => step.id === stepId);
  const step = visibleSteps[index] ?? steps[0];
  const foundSource =
    importSource && detected?.[importSource]
      ? importSource
      : managerImportSources.find(source => detected?.[source]);
  const found = foundSource && detected?.[foundSource];
  const heading =
    step.id === 'import' &&
    foundSource &&
    found &&
    (found.groupCount || found.sessionCount)
      ? { ...step, title: managerImportSummary(foundSource, found, true) }
      : 'title' in step
        ? step
        : undefined;
  const last = step.id === 'finish';
  const folder = defaultFolders.folders.local ?? null;
  useEffect(() => {
    document.getElementById('onboarding-step')?.focus();
  }, [stepId]);

  const advance = async () => {
    if (stepId !== 'providers' || detected) {
      const next = visibleSteps[index + 1];
      if (next) setStepId(next.id);
      return;
    }
    if (
      local?.status !== 'connected' ||
      !local.capabilities.includes('manager-import')
    ) {
      setStepId('computers');
      return;
    }
    setCheckingImports(true);
    const replies = await Promise.allSettled(
      managerImportSources.map(source =>
        api.listManagerImport({ source, offset: 0 }, local.id),
      ),
    );
    const sources: DetectedImports = {};
    for (const [position, reply] of replies.entries()) {
      if (
        reply.status === 'fulfilled' &&
        (reply.value.groupCount ||
          reply.value.sessionCount ||
          reply.value.status === 'choose-root' ||
          reply.value.status === 'retry')
      )
        sources[managerImportSources[position]!] = reply.value;
    }
    setDetected(sources);
    setCheckingImports(false);
    setStepId(Object.keys(sources).length ? 'import' : 'computers');
  };

  const finish = async (action: () => void) => {
    if (finishing) return;
    if (!setupScan || !local || setupScan.instanceId !== local.instanceId) {
      action();
      return;
    }
    setFinishing(true);
    setSetupError('');
    try {
      const result = await api.setupDetection(
        {
          action: 'acknowledge',
          instanceId: setupScan.instanceId,
          revision: setupScan.revision,
          completed: true,
        },
        local.id,
      );
      if (!result.ok) {
        setSetupError(result.message);
        return;
      }
      action();
    } catch {
      setSetupError(
        'The reviewed setup could not be saved. Open Your setup to refresh it.',
      );
    } finally {
      setFinishing(false);
    }
  };

  return (
    <main
      aria-label="Getting started"
      className="flex h-dvh flex-col bg-background font-onboarding text-foreground"
    >
      <div className="drag-region h-10 shrink-0" />
      <div className="mx-auto my-auto flex max-h-[min(46rem,calc(100dvh-2.5rem))] min-h-0 w-full max-w-3xl flex-col">
        <header className="mx-auto w-full max-w-3xl shrink-0 space-y-2 px-10 pt-2">
          <div className="flex items-center justify-between gap-4">
            <SectionLabel as="p" className="px-0">
              Getting started
            </SectionLabel>
            <p className="text-2xs text-muted-foreground tabular-nums">
              Step {index + 1} of {visibleSteps.length}
            </p>
          </div>
          <Progress
            label="Getting started progress"
            value={((index + 1) / visibleSteps.length) * 100}
          />
        </header>
        <OnboardingStepLayout key={step.id} step={step.id} heading={heading}>
          {step.id === 'welcome' && <WelcomeStep />}
          {step.id === 'providers' && (
            <ProvidersStep
              statuses={statuses}
              computerName={local?.name ?? 'this computer'}
              onCheckAgain={checkProviders}
            />
          )}
          {step.id === 'import' && (
            <ManagerImportPicker
              api={api}
              computer={local}
              detected={detected}
              initialSource={foundSource}
              onBusyChange={setImporting}
              onImported={() => setImportCompleted(true)}
              onSourceChange={setImportSource}
            />
          )}
          {step.id === 'computers' && (
            <ComputersStep
              computers={computers}
              defaultFolders={defaultFolders}
              api={api}
              error={error}
              onEditingChange={setEditingComputer}
            />
          )}
          {step.id === 'setup' && (
            <div className="space-y-6">
              <SetupProfileSettings computer={local} onboarding />
              <SetupFindings
                computer={local}
                onboarding
                statuses={statuses}
                onCompleteScan={setSetupScan}
                openImport={
                  local?.capabilities.includes('manager-import')
                    ? () => setSetupImports(!setupImports)
                    : undefined
                }
              />
              {setupScan && (
                <p className="text-xs text-muted-foreground">
                  Scan selected for review at Finish.
                </p>
              )}
              {setupImports && (
                <ManagerImportPicker
                  api={api}
                  computer={local}
                  detected={detected}
                  initialSource={foundSource}
                  onBusyChange={setImporting}
                />
              )}
            </div>
          )}
          {step.id === 'inbox' && <InboxStep api={api} computer={local} />}
          {step.id === 'routines' && (
            <RoutinesStep
              api={api}
              computer={local}
              statuses={statuses}
              defaultFolder={folder}
              outcomes={outcomes}
              setOutcomes={setOutcomes}
              onCheckProviders={checkProviders}
              onChooseComputer={() => setStepId('computers')}
              onSetupAgents={() => setStepId('providers')}
            />
          )}
          {last && (
            <FinishStep
              computers={computers}
              statuses={statuses}
              folder={folder}
              routines={Object.values(outcomes).flatMap(item =>
                item.status === 'added' ? [item.name] : [],
              )}
              setup={setupScan}
              pending={finishing}
              error={setupError}
              onClose={() => void finish(onClose)}
              onStartSession={provider =>
                void finish(() => onStartSession(provider))
              }
            />
          )}
        </OnboardingStepLayout>
        <footer
          hidden={step.id === 'computers' && editingComputer}
          className="mx-auto w-full max-w-3xl shrink-0 px-10 pb-6"
        >
          <nav
            aria-label="Guide navigation"
            className="flex items-center justify-between gap-2 border-t pt-4"
          >
            <div className="flex gap-2">
              {index > 0 && (
                <Button
                  variant="ghost"
                  size="md"
                  disabled={checkingImports || importing}
                  onClick={() => setStepId(visibleSteps[index - 1]!.id)}
                >
                  <ArrowLeft />
                  Back
                </Button>
              )}
            </div>
            {!last && (
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="md"
                  onClick={onClose}
                  disabled={checkingImports || importing}
                >
                  Finish setup later
                </Button>
                {!['welcome', 'import'].includes(stepId) && (
                  <Button
                    variant="ghost"
                    size="md"
                    disabled={checkingImports || importing}
                    onClick={() => {
                      if (stepId === 'setup') {
                        setSetupScan(null);
                        setSetupImports(false);
                      }
                      if (stepId === 'providers') setStepId('computers');
                      else void advance();
                    }}
                  >
                    Skip this step
                  </Button>
                )}
                <Button
                  variant={
                    stepId === 'import' && !importCompleted
                      ? 'ghost'
                      : 'default'
                  }
                  size="md"
                  disabled={checkingImports || importing}
                  onClick={() => void advance()}
                >
                  {checkingImports
                    ? 'Checking for imports…'
                    : index === 0
                      ? 'Get started'
                      : stepId === 'import' && !importCompleted
                        ? 'Skip import'
                        : 'Continue'}
                  <ArrowRight />
                </Button>
              </div>
            )}
          </nav>
        </footer>
      </div>
    </main>
  );
}
