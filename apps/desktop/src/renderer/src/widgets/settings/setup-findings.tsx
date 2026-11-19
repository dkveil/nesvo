import { useState } from 'react';
import {
  setupGroups,
  type Computer,
  type SetupFinding,
  type SetupScan,
} from '@nesvo/contracts';
import { Button } from '@/shared/ui/button';
import { Disclosure } from '@/shared/ui/disclosure';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { PanelBody } from '@/shared/ui/panel';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import {
  SidePanel,
  SidePanelFooter,
  SidePanelHeader,
} from '@/shared/ui/side-panel';
import { StatusMessage } from '@/shared/ui/status-message';
import { useSetupDetection } from './use-setup-detection';
import { SetupAssistant } from './setup-assistant';
import type { ProviderStates } from '@/entities/session';

const readiness: Record<SetupFinding['readiness'], string> = {
  observed: 'Observed',
  partial: 'Partial evidence',
  'not-checked': 'Not checked',
  unavailable: 'Unavailable',
  withheld: 'Withheld',
};

export function SetupFindings({
  computer,
  onboarding = false,
  openImport,
  onCompleteScan,
  statuses,
  directory,
}: {
  computer?: Computer;
  onboarding?: boolean;
  openImport?: () => void;
  onCompleteScan?: (scan: SetupScan) => void;
  statuses?: ProviderStates;
  directory?: string;
}) {
  const detection = useSetupDetection(computer, {
    trigger: onboarding ? 'onboarding' : 'manual',
  });
  const { scan } = detection;
  const [showAll, setShowAll] = useState(false);
  const [panel, setPanel] = useState<string | 'changed' | null>(null);
  const [assistant, setAssistant] = useState(false);
  const panelRows =
    scan?.findings.filter(row =>
      panel === 'changed' ? scan.changes.includes(row.id) : row.id === panel,
    ) ?? [];
  const rows =
    scan?.findings.filter(
      row =>
        showAll ||
        !scan.reviewedRevision ||
        scan.changes.includes(row.id) ||
        row.readiness === 'withheld',
    ) ?? [];
  const groupRows = (group: SetupFinding['group']) =>
    rows.filter(row => row.group === group);

  return (
    <div className="relative flex min-w-0 gap-4">
      <div className="min-w-0 flex-1 space-y-3">
        <SettingsSection
          title="Detected setup"
          action={
            <div className="flex flex-wrap gap-1.5">
              {computer?.capabilities.includes('setup-assistant-v1') && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!detection.online || !scan}
                  onClick={() => {
                    setPanel(null);
                    setAssistant(true);
                  }}
                >
                  Ask about setup
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !detection.online || !detection.supported || detection.busy
                }
                onClick={() => void detection.refresh()}
              >
                Detect again
              </Button>
            </div>
          }
        >
          {!detection.online && (
            <StatusMessage>
              {scan
                ? 'Offline snapshot'
                : 'Connect to see this computer’s setup.'}
            </StatusMessage>
          )}
          {detection.online && !detection.supported && (
            <StatusMessage>
              Update this computer’s Nesvo host to detect setup.
            </StatusMessage>
          )}
          {detection.error && (
            <StatusMessage tone="error">{detection.error}</StatusMessage>
          )}
          {!scan &&
            detection.online &&
            detection.supported &&
            !detection.error && (
              <StatusMessage tone="loading">
                Checking this computer…
              </StatusMessage>
            )}
          {scan && (
            <>
              <SettingsRow
                title="Last scan"
                description={new Date(scan.scannedAt).toLocaleString()}
              >
                {scan.reviewedRevision && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowAll(!showAll)}
                  >
                    {showAll ? 'Show unreviewed setup' : 'Show current setup'}
                  </Button>
                )}
              </SettingsRow>
              {scan.changes.length > 0 && (
                <InlineNotice tone="warning">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span>
                      Setup changed · {scan.changes.length}{' '}
                      {scan.changes.length === 1 ? 'finding' : 'findings'}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPanel('changed')}
                    >
                      Review changes
                    </Button>
                  </div>
                </InlineNotice>
              )}
              {setupGroups.map(group => {
                const items = groupRows(group);
                if (!items.length) return null;
                return (
                  <Disclosure
                    key={group}
                    title={group}
                    defaultOpen={
                      group === 'Providers' || group === 'Agent configuration'
                    }
                  >
                    {items.map(item => (
                      <SettingsRow
                        key={item.id}
                        title={item.label}
                        description={`${item.source} · ${item.description}`}
                      >
                        {item.action === 'review' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setPanel(item.id)}
                          >
                            Review
                          </Button>
                        ) : item.action === 'import' && openImport ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={openImport}
                          >
                            Open import
                          </Button>
                        ) : (
                          <StatusMessage>
                            {readiness[item.readiness]}
                          </StatusMessage>
                        )}
                      </SettingsRow>
                    ))}
                  </Disclosure>
                );
              })}
              {scan.reviewedRevision === null && (
                <SettingsRow title="Review this scan">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!detection.online || detection.busy}
                    onClick={() => {
                      if (onCompleteScan) onCompleteScan(scan);
                      else void detection.acknowledge();
                    }}
                  >
                    Mark reviewed
                  </Button>
                </SettingsRow>
              )}
            </>
          )}
        </SettingsSection>
      </div>
      {assistant && computer && (
        <SetupAssistant
          computer={computer}
          statuses={statuses}
          directory={directory}
          close={() => setAssistant(false)}
        />
      )}
      {panel && scan && !assistant && (
        <SidePanel
          kind="details"
          resizeLabel="Resize setup review"
          focusOnOpen
          onEscape={() => setPanel(null)}
        >
          <SidePanelHeader
            titleBar={false}
            title={panel === 'changed' ? 'Setup changed' : 'Setup finding'}
            closeLabel="Close setup review"
            onClose={() => setPanel(null)}
          />
          <PanelBody className="space-y-2 p-3">
            {panelRows.map(row => (
              <SettingsRow
                key={row.id}
                title={row.label}
                description={
                  <>
                    <p>{row.description}</p>
                    <p className="mt-1">
                      {row.source} · {readiness[row.readiness]}
                    </p>
                  </>
                }
              />
            ))}
          </PanelBody>
          {panel === 'changed' && (
            <SidePanelFooter label="Setup review actions">
              <Button
                size="sm"
                variant="outline"
                disabled={!detection.online || detection.busy}
                onClick={() => {
                  void detection.acknowledge();
                  setPanel(null);
                }}
              >
                Mark reviewed
              </Button>
            </SidePanelFooter>
          )}
        </SidePanel>
      )}
    </div>
  );
}

export function NewSessionSetupFinding({
  computer,
  directory,
  onReview,
}: {
  computer?: Computer;
  directory: string;
  onReview: () => void;
}) {
  const { scan } = useSetupDetection(
    computer,
    { trigger: 'first-open', directory },
    !!directory,
  );
  if (!scan?.directory) return null;
  const withheld = scan.findings.filter(
    item => item.readiness === 'withheld',
  ).length;
  return (
    <SettingsRow
      title="Repository setup"
      description={
        withheld
          ? `${withheld} setup ${withheld === 1 ? 'item needs' : 'items need'} review on this computer.`
          : 'Local checkout metadata found.'
      }
    >
      <Button size="sm" variant="ghost" onClick={onReview}>
        View setup
      </Button>
    </SettingsRow>
  );
}
