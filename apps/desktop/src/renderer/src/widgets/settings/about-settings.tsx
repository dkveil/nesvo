import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import {
  HOST_CONTRACT_REVISION,
  type AboutInfo,
  type Computer,
  type DesktopApi,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { KeyValueList } from '@/shared/ui/key-value-list';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { Skeleton } from '@/shared/ui/skeleton';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  api: Pick<
    DesktopApi,
    'about' | 'showDataDirectory' | 'openLogs' | 'openLicenses'
  >;
  computers: Computer[];
};

const COPIED_RESET_MS = 2000;

const connectionLabels: Record<Computer['status'], string> = {
  connected: 'connected',
  connecting: 'connecting',
  syncing: 'syncing',
  disconnected: 'offline',
  incompatible: 'update required',
  error: 'connection failed',
};

const platformLabels: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

function platformLabel(about: AboutInfo) {
  return `${platformLabels[about.platform] ?? about.platform} ${about.osRelease} (${about.arch})`;
}

function diagnosticsSummary(about: AboutInfo, computers: Computer[]) {
  return [
    `Nesvo ${about.version}${about.packaged ? '' : ' (development)'}`,
    `Electron ${about.electron} · Node ${about.node} · Chrome ${about.chrome}`,
    `Platform ${platformLabel(about)}`,
    `Host contract revision ${HOST_CONTRACT_REVISION}`,
    `Computers (${computers.length})`,
    ...computers.map(
      computer =>
        `- ${computer.name} · ${computer.kind === 'local' ? 'local' : 'SSH'} · ${connectionLabels[computer.status]} · ${computer.capabilities.length} capabilities`,
    ),
  ].join('\n');
}

export function AboutSettings({ api, computers }: Props) {
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    api
      .about()
      .then(value => {
        if (active) setAbout(value);
      })
      .catch((failure: unknown) => {
        if (active)
          setError(`Could not read app details. ${errorDetail(failure)}`);
      });
    return () => {
      active = false;
    };
  }, [api]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const run = (action: () => Promise<void>, failure: string) => {
    setActionError('');
    void action().catch(() => setActionError(failure));
  };
  const copyDiagnostics = () => {
    if (!about) return;
    setActionError('');
    void navigator.clipboard
      .writeText(diagnosticsSummary(about, computers))
      .then(
        () => setCopied(true),
        () => setActionError('The diagnostics could not be copied.'),
      );
  };
  return (
    <div className="space-y-8">
      <SettingsSection title="Version">
        <div className="px-3 py-3">
          {about ? (
            <KeyValueList
              aria-label="Version details"
              entries={[
                {
                  key: 'version',
                  label: 'Nesvo',
                  value: `${about.version}${about.packaged ? '' : ' · development build'}`,
                },
                { key: 'electron', label: 'Electron', value: about.electron },
                { key: 'node', label: 'Node.js', value: about.node },
                { key: 'chrome', label: 'Chromium', value: about.chrome },
                {
                  key: 'platform',
                  label: 'Platform',
                  value: platformLabel(about),
                },
                {
                  key: 'contract',
                  label: 'Host contract',
                  value: `Revision ${HOST_CONTRACT_REVISION}`,
                },
              ]}
            />
          ) : error ? (
            <StatusMessage tone="error">{error}</StatusMessage>
          ) : (
            <div className="space-y-2" aria-hidden="true">
              <Skeleton className="w-48" />
              <Skeleton className="w-40" />
              <Skeleton className="w-56" />
            </div>
          )}
        </div>
        <SettingsRow
          title="Diagnostics"
          description="Versions, platform and computer connection status. No paths, credentials or messages."
        >
          <Button variant="outline" disabled={!about} onClick={copyDiagnostics}>
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy diagnostics'}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Files">
        <SettingsRow
          title="Data folder"
          description={
            <span className="font-mono text-2xs">
              {about?.dataDirectory ?? '…'}
            </span>
          }
        >
          <Button
            variant="outline"
            disabled={!about}
            onClick={() =>
              run(api.showDataDirectory, 'The data folder could not be shown.')
            }
          >
            Show in folder
          </Button>
        </SettingsRow>
        <SettingsRow
          title="Logs"
          description={
            <span className="font-mono text-2xs">
              {about?.logsDirectory ?? '…'}
            </span>
          }
        >
          <Button
            variant="outline"
            onClick={() =>
              run(api.openLogs, 'The logs folder could not be opened.')
            }
          >
            Open logs
          </Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Legal">
        <SettingsRow
          title="Third-party licenses"
          description="Notices for the open source software included in Nesvo."
        >
          <Button
            variant="outline"
            onClick={() =>
              run(api.openLicenses, 'The license notices could not be opened.')
            }
          >
            Third-party licenses
          </Button>
        </SettingsRow>
      </SettingsSection>
      {actionError && <StatusMessage tone="error">{actionError}</StatusMessage>}
    </div>
  );
}
