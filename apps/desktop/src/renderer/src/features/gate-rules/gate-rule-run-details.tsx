import { useState } from 'react';
import type { WorkflowRun } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { hostKey } from '@/shared/lib/host-key';
import { Button } from '@/shared/ui/button';
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusMessage } from '@/shared/ui/status-message';
import { GateRuleUndo } from './gate-rule-undo';
import { useGateRules } from './use-gate-rules';

type Props = {
  run: WorkflowRun;
  hostId: string;
  enabled: boolean;
  onSession: (key: string) => void;
};

export function GateRuleRunDetails({ run, hostId, enabled, onSession }: Props) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState('');
  const { overview, error, reload } = useGateRules(hostId, enabled, run.id);
  const generation = overview?.generation;
  const proposals = overview?.proposals ?? [];
  if (!generation && !error) return null;
  const retry = async () => {
    setPending(true);
    setFailure('');
    try {
      await window.nesvo.gateRules(
        { action: 'retry', runId: run.id, requestId: crypto.randomUUID() },
        hostId,
      );
      reload();
    } catch (reason) {
      setFailure(errorDetail(reason));
    } finally {
      setPending(false);
    }
  };
  const status =
    generation?.reason ??
    (generation?.status === 'running'
      ? 'Drafting gate rules…'
      : generation?.status === 'none'
        ? 'No gate rules proposed.'
        : null);
  return (
    <section
      aria-label="Rules proposed from this run"
      className="space-y-1 px-2 pb-2"
    >
      <SectionLabel as="h3">Rules proposed from this run</SectionLabel>
      {status && <StatusMessage>{status}</StatusMessage>}
      {(failure || error) && (
        <StatusMessage tone="error">{failure || error}</StatusMessage>
      )}
      {generation?.sessionId && (
        <Button
          variant="link"
          size="inline"
          onClick={() => onSession(hostKey(generation.sessionId!, hostId))}
        >
          Open proposal session
        </Button>
      )}
      {proposals.map(row => (
        <div key={row.id} className="flex items-start gap-2 py-1 text-xs">
          <p className="min-w-0 flex-1 break-words">
            {row.ruleId && (
              <span className="mr-1 font-mono text-muted-foreground">
                {row.ruleId}
              </span>
            )}
            {row.proposal.description}
            <span className="block capitalize text-muted-foreground">
              {row.status}
            </span>
            {row.error && (
              <span className="block text-muted-foreground">{row.error}</span>
            )}
          </p>
          {row.changeId && (
            <GateRuleUndo
              hostId={hostId}
              input={{ conversationId: row.sessionId, changeId: row.changeId }}
            />
          )}
        </div>
      ))}
      {generation &&
        !proposals.length &&
        generation.status !== 'running' &&
        generation.retries < 2 && (
          <Button
            variant="outline"
            size="xs"
            disabled={pending || !enabled}
            onClick={() => void retry()}
          >
            Propose again
          </Button>
        )}
    </section>
  );
}
