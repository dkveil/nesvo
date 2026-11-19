import { useEffect, useId, useState } from 'react';
import {
  autonomyLevelSchema,
  type AutonomyStatistics,
  type AutonomyLevel,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusMessage } from '@/shared/ui/status-message';

const levels: Record<AutonomyLevel, string> = {
  0: 'Always ask',
  1: 'Recommend',
  2: 'Narrow the decision',
  3: 'Observe',
  4: 'Decide within policy',
};

export function GateAutonomy({
  hostId,
  directory,
  workflow,
  gate,
}: {
  hostId: string;
  directory: string;
  workflow: string;
  gate: string;
}) {
  const id = useId();
  const [view, setView] = useState<AutonomyStatistics | null>(null);
  const [minimum, setMinimum] = useState('');
  const [windowDays, setWindowDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    let active = true;
    void window.nesvo
      .gateRules(
        { action: 'autonomy-read', target: { directory, workflow, gate } },
        hostId,
      )
      .then(overview => {
        if (!active || !overview.autonomy) return;
        const { autonomy } = overview;
        setView(autonomy);
        setMinimum(String(autonomy.settings.minimum));
        setWindowDays(String(autonomy.settings.windowDays));
      })
      .catch(error => {
        if (active) setFailure(errorDetail(error));
      });
    return () => {
      active = false;
    };
  }, [directory, gate, hostId, workflow]);
  if (!view)
    return failure ? (
      <StatusMessage tone="error">{failure}</StatusMessage>
    ) : null;
  const apply = async (level: AutonomyLevel) => {
    setBusy(true);
    setFailure('');
    try {
      const result = await window.nesvo.gateRules(
        {
          action: 'autonomy-set',
          input: {
            target: { directory, workflow, gate },
            revision: view.settings.revision,
            level,
            minimum: Number(minimum),
            windowDays: Number(windowDays),
            confirmed: true,
          },
        },
        hostId,
      );
      if (result.autonomy) setView(result.autonomy);
    } catch (error) {
      setFailure(errorDetail(error));
    } finally {
      setBusy(false);
    }
  };
  const { settings, agreements, observations, overrides } = view;
  const upgrade = autonomyLevelSchema.safeParse(settings.level + 1);
  const lower = autonomyLevelSchema.safeParse(settings.level - 1);
  const valid =
    Number.isInteger(Number(minimum)) &&
    Number(minimum) >= 1 &&
    Number(minimum) <= 100 &&
    Number.isInteger(Number(windowDays)) &&
    Number(windowDays) >= 1 &&
    Number(windowDays) <= 365;
  return (
    <section
      className="space-y-2.5 border-b border-border pb-3"
      aria-label="Gate autonomy"
    >
      <SectionLabel>Gate autonomy</SectionLabel>
      <p className="text-ui font-medium">
        {gate} · Level {settings.level} · {levels[settings.level]}
      </p>
      <p className="text-xs text-muted-foreground">
        {observations
          ? `${Math.round((100 * agreements) / observations)}% agreement (${agreements} of ${observations})`
          : 'No compared decisions yet'}
        {' · '}
        {overrides} overrides
      </p>
      {view.proposal !== null && (
        <p className="text-ui">
          Proposed level {view.proposal} · {levels[view.proposal]}
        </p>
      )}
      {view.considerNarrowing && (
        <p className="text-xs text-muted-foreground">
          This gate reviews many files. Consider focusing on the paths the
          recommendation is uncertain about.
        </p>
      )}
      {settings.override && (
        <p className="text-xs text-muted-foreground">
          Last override · {settings.override.reason}
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <Field id={`${id}-minimum`} label="Minimum agreements">
          <Input
            id={`${id}-minimum`}
            value={minimum}
            onChange={event => setMinimum(event.target.value)}
            type="number"
            min={1}
            max={100}
          />
        </Field>
        <Field id={`${id}-days`} label="Window in days">
          <Input
            id={`${id}-days`}
            value={windowDays}
            onChange={event => setWindowDays(event.target.value)}
            type="number"
            min={1}
            max={365}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {upgrade.success && (
          <Button
            size="xs"
            variant="secondary"
            disabled={busy || !valid}
            onClick={() => void apply(upgrade.data)}
          >
            Accept level {upgrade.data}
          </Button>
        )}
        {lower.success && (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || !valid}
            onClick={() => void apply(lower.data)}
          >
            Lower to {lower.data}
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          disabled={
            busy ||
            !valid ||
            (Number(minimum) === settings.minimum &&
              Number(windowDays) === settings.windowDays)
          }
          onClick={() => void apply(settings.level)}
        >
          Save thresholds
        </Button>
      </div>
      {failure && <StatusMessage tone="error">{failure}</StatusMessage>}
    </section>
  );
}
