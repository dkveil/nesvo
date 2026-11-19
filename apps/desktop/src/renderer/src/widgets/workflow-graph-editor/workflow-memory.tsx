import { useEffect, useId, useState } from 'react';
import type {
  DefinitionCatalog,
  LessonOverview,
  RuleEntryScope,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { GateAutonomy } from '@/features/workflow-gate-decision/gate-autonomy';
import { GateTrust } from '@/features/workflow-gate-decision/gate-trust';
import { GateRuleUndo } from '@/features/gate-rules/gate-rule-undo';
import { RuleUsage } from '@/features/gate-rules/rule-usage';
import { hostKey } from '@/shared/lib/host-key';
import { Button } from '@/shared/ui/button';
import { Field } from '@/shared/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { StatusMessage } from '@/shared/ui/status-message';

export function WorkflowMemory({
  hostId,
  directory,
  name,
  steps,
  onSession,
}: {
  hostId: string;
  directory: string;
  name: string;
  steps: string[];
  onSession: (key: string) => void;
}) {
  const id = useId();
  const [step, setStep] = useState('');
  const [catalog, setCatalog] = useState<DefinitionCatalog | null>(null);
  const [lessons, setLessons] = useState<LessonOverview | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () => {
      void window.nesvo.workflows
        .listDefinitions(hostId, { directory })
        .then(result => {
          if (active) setCatalog(result);
        })
        .catch(reason => {
          if (active) setError(errorDetail(reason));
        });
    };
    load();
    void window.nesvo
      .readLessons(hostId)
      .then(result => {
        if (active) setLessons(result);
      })
      .catch(reason => {
        if (active) setError(errorDetail(reason));
      });
    const release = window.nesvo.subscribe(event => {
      if (
        event.type === 'gate-rule-proposal-changed' ||
        event.type === 'workflow-assistant-change'
      )
        load();
    });
    return () => {
      active = false;
      release();
    };
  }, [hostId, directory]);
  const matches = (scope: RuleEntryScope) =>
    (!scope.workflows || scope.workflows.includes(name)) &&
    (!scope.steps ||
      (step
        ? scope.steps.includes(step)
        : scope.steps.some(item => steps.includes(item))));
  const entries = [
    ...(catalog?.precedents ?? [])
      .filter(entry => entry.status === 'active' && matches(entry.scope))
      .map(entry => ({
        ...entry,
        label: 'Decision precedent',
        key: entry.source.path,
      })),
    ...(catalog?.gateRules ?? [])
      .filter(entry => entry.status === 'active' && matches(entry.scope))
      .map(entry => ({
        ...entry,
        label: 'Gate rule',
        key: entry.source.path,
      })),
    ...(lessons?.lessons ?? [])
      .filter(
        entry =>
          entry.state === 'active' &&
          matches(entry.scope) &&
          (!entry.project ||
            catalog?.roots.project === `${entry.project}/.agents/workflows` ||
            catalog?.roots.project?.replaceAll('\\', '/').toLowerCase() ===
              `${entry.project}/.agents/workflows`
                .replaceAll('\\', '/')
                .toLowerCase()),
      )
      .map(entry => ({ ...entry, label: 'Lesson', undo: undefined })),
  ];
  return (
    <section className="space-y-3 p-3" aria-label="Lessons and decisions">
      <Field id={id} label="Filter by step">
        <Select
          value={step || 'all-steps:'}
          onValueChange={value => setStep(value === 'all-steps:' ? '' : value)}
        >
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all-steps:">All steps</SelectItem>
            {steps.map(name => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {step &&
        catalog?.workflows
          .find(item => item.name === name)
          ?.steps.some(item => item.name === step && item.type === 'human') && (
          <div key={step} className="space-y-3">
            <GateTrust
              hostId={hostId}
              directory={directory}
              workflow={name}
              gate={step}
              onSession={onSession}
            />
            <GateAutonomy
              hostId={hostId}
              directory={directory}
              workflow={name}
              gate={step}
            />
          </div>
        )}
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {catalog && !entries.length && (
        <p className="text-ui text-muted-foreground">
          No entries apply to this workflow.
        </p>
      )}
      <ul className="divide-y divide-border">
        {entries.map(entry => (
          <li key={entry.key} className="space-y-1.5 py-2.5">
            <p className="text-xs text-muted-foreground">
              {entry.label}
              {entry.provenance.step && ` · ${entry.provenance.step}`}
            </p>
            <p className="text-ui font-medium [overflow-wrap:anywhere]">
              {entry.body.rule}
            </p>
            <p className="text-ui text-muted-foreground [overflow-wrap:anywhere]">
              {entry.body.why}
            </p>
            <RuleUsage
              metrics={entry.metrics}
              kind={
                entry.label === 'Decision precedent' ? 'decision' : entry.kind
              }
              since={entry.provenance.date}
            />
            <div className="flex items-center gap-2">
              {entry.provenance.run && entry.provenance.session && (
                <Button
                  size="xs"
                  variant="link"
                  onClick={() =>
                    onSession(hostKey(entry.provenance.session!, hostId))
                  }
                >
                  Open source run
                </Button>
              )}
              {entry.undo && (
                <GateRuleUndo input={entry.undo} hostId={hostId} />
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
