import { useEffect, useState } from 'react';
import type { ResolvedGateRule } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { GateRuleUndo } from '@/features/gate-rules/gate-rule-undo';
import { RuleUsage } from '@/features/gate-rules/rule-usage';
import { formatDate } from '@/shared/lib/format-date';
import { Badge } from '@/shared/ui/badge';
import { NativeDisclosure } from '@/shared/ui/disclosure';
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  directory: string;
  hostId: string;
  step: string;
  workflow: string;
  initial: ResolvedGateRule[];
};

export function InspectorGateRules({
  directory,
  hostId,
  step,
  workflow,
  initial,
}: Props) {
  const [rules, setRules] = useState<ResolvedGateRule[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let revision = 0;
    const load = () => {
      const request = ++revision;
      void window.nesvo.workflows.listDefinitions(hostId, { directory }).then(
        catalog => {
          if (!active || request !== revision) return;
          setRules(catalog.gateRules ?? []);
          setError('');
        },
        reason => {
          if (active && request === revision) setError(errorDetail(reason));
        },
      );
    };
    const release = window.nesvo.subscribe(event => {
      if (
        ('hostId' in event &&
          event.hostId === hostId &&
          ((event.type === 'gate-rule-proposal-changed' &&
            event.proposal.status === 'accepted') ||
            (event.type === 'workflow-assistant-change' &&
              event.change.kind === 'gate-rule'))) ||
        (event.type === 'workflow-step-changed' &&
          event.step.hostId === hostId &&
          event.step.name === step &&
          !!event.step.deliveredRules?.length)
      )
        load();
    });
    load();
    return () => {
      active = false;
      release();
    };
  }, [directory, hostId, step]);
  const visible = (rules ?? initial).filter(
    rule =>
      rule.scope.steps?.includes(step) &&
      (!rule.scope.workflows || rule.scope.workflows.includes(workflow)),
  );
  return (
    <section aria-label="Gate rules" className="space-y-2 border-t px-3 py-3">
      <SectionLabel as="h3" count={visible.length}>
        Gate rules
      </SectionLabel>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {!visible.length && (
        <p className="text-xs text-muted-foreground">No gate rules assigned.</p>
      )}
      {visible.length > 0 && (
        <ul className="divide-y divide-border border-b border-border">
          {visible.map(rule => (
            <li key={rule.id} className="space-y-1 py-2">
              <div className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
                <span className="font-mono">{rule.id}</span>
                <span>
                  {rule.kind === 'check' ? 'Check suggestion' : 'Instruction'}
                </span>
                <span>
                  {rule.source.scope === 'project' ? 'Project' : 'Global'}
                </span>
                {rule.status === 'retired' && <Badge size="xs">Retired</Badge>}
              </div>
              <p className="text-xs leading-5 [overflow-wrap:anywhere]">
                {rule.body.rule}
              </p>
              <RuleUsage
                metrics={rule.metrics}
                kind={rule.kind}
                since={rule.provenance.date}
              />
              <NativeDisclosure title="Source and check">
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {rule.body.why}
                </p>
                <p className="mt-1 [overflow-wrap:anywhere]">
                  Check: {rule.body.check}
                </p>
                {rule.provenance.quote && (
                  <p className="mt-1 [overflow-wrap:anywhere]">
                    “{rule.provenance.quote}”
                  </p>
                )}
                <p className="mt-1 text-2xs">
                  {rule.provenance.step ? `${rule.provenance.step} · ` : ''}
                  <time dateTime={rule.provenance.date}>
                    {formatDate(rule.provenance.date)}
                  </time>
                </p>
              </NativeDisclosure>
              {rule.undo && <GateRuleUndo hostId={hostId} input={rule.undo} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
