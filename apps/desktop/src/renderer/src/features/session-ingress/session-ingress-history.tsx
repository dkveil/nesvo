import { useState } from 'react';
import type { ExternalSessionMessageEntry } from '@nesvo/contracts';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { PanelBody } from '@/shared/ui/panel';
import { SettingsRow, SettingsRows } from '@/shared/ui/settings-section';
import { SidePanel, SidePanelHeader } from '@/shared/ui/side-panel';
import { StatusMessage } from '@/shared/ui/status-message';
import { errorDetail } from '@/entities/session';

import { ingressStatus } from './use-session-ingress-history';

export function SessionIngressItems({
  entries,
  onOpen,
}: {
  entries: ExternalSessionMessageEntry[];
  onOpen: (id: string) => void;
}) {
  const visible = entries.filter(
    entry =>
      !['routing', 'rejected', 'inbox', 'dismissed'].includes(
        entry.receipt.status,
      ),
  );
  if (!visible.length) return null;
  return (
    <SettingsRows>
      <SettingsRow
        title={`External messages · ${visible.length}`}
        description={`Message from ${visible.at(-1)!.receipt.source} · ${ingressStatus[visible.at(-1)!.receipt.status]}`}
      >
        <Button
          size="xs"
          type="button"
          variant="ghost"
          onClick={() => onOpen(visible.at(-1)!.receipt.id)}
        >
          View messages
        </Button>
      </SettingsRow>
    </SettingsRows>
  );
}

export function SessionIngressDetails({
  hostId,
  entries,
  selectedId,
  onOpen,
  onClose,
}: {
  hostId: string;
  entries: ExternalSessionMessageEntry[];
  selectedId: string;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selected = entries.find(entry => entry.receipt.id === selectedId);
  const receipt = selected?.receipt;
  const decide = async (action: 'continue' | 'dismiss') => {
    if (!receipt) return;
    setBusy(true);
    setError('');
    try {
      await window.nesvo.externalSessionMessages(
        { action, actionId: crypto.randomUUID(), receiptId: receipt.id },
        hostId,
      );
    } catch (reason) {
      setError(errorDetail(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SidePanel
      kind="details"
      resizeLabel="Resize external messages"
      focusOnOpen
      onEscape={onClose}
    >
      <SidePanelHeader
        title="External messages"
        closeLabel="Close external messages"
        onClose={onClose}
      />
      <PanelBody className="space-y-3 p-3">
        {receipt && selected && (
          <>
            <SettingsRow
              title={`Message from ${receipt.source}`}
              description={`${receipt.provenance.label} · ${ingressStatus[receipt.status]}`}
            />
            <CodeBlock code={selected.text} wrap copyable={false} />
            {receipt.reason && <StatusMessage>{receipt.reason}</StatusMessage>}
            <SettingsRow title="Receipt" description={receipt.id} />
            {selected.changes.map((change, index) => (
              <SettingsRow
                key={change.at + ':' + index}
                title={ingressStatus[change.action]}
                description={`${change.actor} · ${new Date(change.at).toLocaleString()}`}
              />
            ))}
            {(receipt.status === 'held' || receipt.status === 'uncertain') && (
              <div className="flex gap-1">
                <Button
                  disabled={busy || receipt.kind !== 'send'}
                  onClick={() => void decide('continue')}
                >
                  Queue for next turn
                </Button>
                <Button
                  disabled={busy}
                  variant="ghost"
                  onClick={() => void decide('dismiss')}
                >
                  Dismiss
                </Button>
              </div>
            )}
          </>
        )}
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
        <SettingsRows>
          {[...entries]
            .reverse()
            .filter(
              entry =>
                !['routing', 'rejected', 'inbox', 'dismissed'].includes(
                  entry.receipt.status,
                ),
            )
            .map(entry => (
              <SettingsRow
                key={entry.receipt.id}
                title={entry.receipt.source}
                description={ingressStatus[entry.receipt.status]}
              >
                <Button
                  size="xs"
                  variant="ghost"
                  selected={entry.receipt.id === selectedId}
                  onClick={() => onOpen(entry.receipt.id)}
                >
                  Details
                </Button>
              </SettingsRow>
            ))}
        </SettingsRows>
      </PanelBody>
    </SidePanel>
  );
}
