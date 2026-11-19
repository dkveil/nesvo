import { useId, useState } from 'react';
import {
  setupGroups,
  type Computer,
  type SetupFinding,
  type SetupChoice,
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
import { Switch } from '@/shared/ui/switch';
import { MiddleTruncatedText } from '@/shared/ui/middle-truncated-text';
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
  const [draft, setDraft] = useState<Record<string, SetupChoice>>({});
  const canChoose =
    onboarding && computer?.capabilities.includes('setup-choices-v1');
  const choices =
    scan?.findings
      .filter(item => item.action === 'review')
      .map(item => {
        const local = draft[item.id];
        const saved = scan.choices?.find(choice => choice.id === item.id);
        return {
          id: item.id,
          revision: item.revision,
          choice:
            local?.revision === item.revision
              ? local.choice
              : (saved?.choice ?? 'skip'),
        } satisfies SetupChoice;
      }) ?? [];
  const diagnosticTitle = useId();
  const diagnostics =
    panel === 'diagnostics' ? detection.diagnostics : undefined;
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
              {computer?.capabilities.includes('setup-diagnostics-v1') && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!detection.online || detection.busy}
                  onClick={() => {
                    setAssistant(false);
                    setPanel('diagnostics');
                    void detection.previewDiagnostics();
                  }}
                >
                  Verify tools
                </Button>
              )}
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
                        {item.action === 'review' && canChoose ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                              {choices.find(choice => choice.id === item.id)
                                ?.choice === 'use'
                                ? 'Use'
                                : 'Skip'}
                            </span>
                            <Switch
                              aria-label={`Use ${item.label}`}
                              checked={choices.some(
                                choice =>
                                  choice.id === item.id &&
                                  choice.choice === 'use',
                              )}
                              disabled={!detection.online || detection.busy}
                              onCheckedChange={checked =>
                                setDraft(previous => ({
                                  ...previous,
                                  [item.id]: {
                                    id: item.id,
                                    revision: item.revision,
                                    choice: checked ? 'use' : 'skip',
                                  },
                                }))
                              }
                            />
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setPanel(item.id)}
                            >
                              Review
                            </Button>
                          </div>
                        ) : item.action === 'review' ? (
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
              {!!choices.length && canChoose && (
                <SettingsRow
                  title="Setup choices"
                  description="Selected definitions stay withheld until separately verified on this computer."
                >
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!detection.online || detection.busy}
                    onClick={() => {
                      setAssistant(false);
                      setPanel('choices');
                    }}
                  >
                    Review choices
                  </Button>
                </SettingsRow>
              )}
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
            title={
              panel === 'diagnostics'
                ? 'Verify tools'
                : panel === 'changed'
                  ? 'Setup changed'
                  : panel === 'choices'
                    ? 'Review setup choices'
                    : 'Setup finding'
            }
            closeLabel="Close setup review"
            onClose={() => setPanel(null)}
          />
          <PanelBody className="space-y-2 p-3">
            {panel === 'choices' &&
              choices.map(choice => (
                <SettingsRow
                  key={choice.id}
                  title={
                    scan.findings.find(item => item.id === choice.id)?.label ??
                    choice.id
                  }
                  description={
                    choice.choice === 'use'
                      ? 'Use · Awaiting local verification'
                      : 'Skip · Withheld'
                  }
                />
              ))}
            {panel === 'diagnostics' && (
              <>
                <p
                  id={diagnosticTitle}
                  className="text-xs text-muted-foreground"
                >
                  Review the installed programs and exact read-only version
                  commands.
                </p>
                {detection.busy && !diagnostics && (
                  <StatusMessage tone="loading">
                    Checking installed tools…
                  </StatusMessage>
                )}
                {diagnostics?.tools.length === 0 && (
                  <StatusMessage>
                    No eligible executable was found.
                  </StatusMessage>
                )}
                {diagnostics?.tools.map(tool => (
                  <SettingsRow
                    key={tool.label}
                    title={tool.label}
                    description={
                      <>
                        <MiddleTruncatedText path value={tool.executable} />
                        <p>
                          {tool.argument} · {tool.digest.slice(0, 12)}
                        </p>
                      </>
                    }
                  />
                ))}
              </>
            )}
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
          {panel === 'choices' && (
            <SidePanelFooter label="Setup choice actions">
              <Button
                size="sm"
                disabled={
                  !detection.online || detection.busy || !choices.length
                }
                onClick={async () => {
                  const applied = await detection.applyChoices(choices);
                  if (!applied) return;
                  setDraft({});
                  setPanel(null);
                  onCompleteScan?.(applied);
                }}
              >
                Apply choices
              </Button>
            </SidePanelFooter>
          )}
          {diagnostics && diagnostics.tools.length > 0 && (
            <SidePanelFooter label="Tool verification actions">
              <Button
                size="sm"
                aria-describedby={diagnosticTitle}
                disabled={detection.busy || !detection.online}
                onClick={() => {
                  void detection.verifyDiagnostics(diagnostics.digest);
                  setPanel(null);
                }}
              >
                Run version checks
              </Button>
            </SidePanelFooter>
          )}
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
  const templates = scan.findings.filter(item =>
    item.id.startsWith('profile/branches/'),
  );
  return (
    <SettingsRow
      title="Repository setup"
      description={
        <>
          <p>
            {withheld
              ? `${withheld} setup ${withheld === 1 ? 'item needs' : 'items need'} review on this computer.`
              : 'Local checkout metadata found.'}
          </p>
          {templates.length > 0 && (
            <p>
              Profile branch templates ·{' '}
              {templates.map(item => item.description).join(', ')}
            </p>
          )}
        </>
      }
    >
      <Button size="sm" variant="ghost" onClick={onReview}>
        View setup
      </Button>
    </SettingsRow>
  );
}
