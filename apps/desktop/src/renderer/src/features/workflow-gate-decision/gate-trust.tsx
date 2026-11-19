import { useEffect, useId, useState } from 'react';
import {
  gateTrustConditionSchema,
  type AutonomyTarget,
  type GateTrustCondition,
  type GateTrustRequest,
  type GateTrustView,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { hostKey } from '@/shared/lib/host-key';
import { Button } from '@/shared/ui/button';
import { Checkbox } from '@/shared/ui/checkbox';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusMessage } from '@/shared/ui/status-message';
import { Textarea } from '@/shared/ui/textarea';

const list = (input: string) =>
  input
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

const conditionText = (condition: GateTrustCondition) =>
  `when ${condition.when}, up to ${condition.maximumFiles} files and ${condition.maximumLines} changed lines, and ${condition.passedChecks.join(', ')} passed` +
  (condition.protectedPaths.length
    ? `. Paths needing review include ${condition.protectedPaths.join(', ')}.`
    : '.');

export function GateTrust({
  hostId,
  directory,
  workflow,
  gate,
  assistant = false,
  onSession,
}: AutonomyTarget & {
  hostId: string;
  assistant?: boolean;
  onSession?: (key: string) => void;
}) {
  const id = useId();
  const [view, setView] = useState<GateTrustView | null>(null);
  const [reasons, setReasons] = useState('');
  const [humanRequired, setHumanRequired] = useState(false);
  const [showCases, setShowCases] = useState(false);
  const [draft, setDraft] = useState<GateTrustCondition | null>(null);
  const [checks, setChecks] = useState('');
  const [paths, setPaths] = useState('');
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const target = { directory, workflow, gate };
  useEffect(() => {
    let active = true;
    void window.nesvo
      .gateRules(
        { action: 'trust-read', target: { directory, workflow, gate } },
        hostId,
      )
      .then(({ trust }) => {
        if (!active || !trust) return;
        setView(trust);
        setReasons(trust.record.reasons);
        setHumanRequired(trust.record.humanRequired);
      })
      .catch(error => {
        if (active) setFailure(errorDetail(error));
      });
    return () => {
      active = false;
    };
  }, [directory, gate, hostId, workflow]);
  const send = async (input: GateTrustRequest) => {
    setBusy(true);
    setFailure('');
    try {
      const { trust } = await window.nesvo.gateRules(input, hostId);
      if (!trust) return;
      setView(trust);
      setReasons(trust.record.reasons);
      setHumanRequired(trust.record.humanRequired);
      if (input.action === 'trust-ask') setAsked(true);
      if (input.action !== 'trust-decide' || input.decision !== 'preview')
        setDraft(null);
    } catch (error) {
      setFailure(errorDetail(error));
    } finally {
      setBusy(false);
    }
  };
  if (!view)
    return failure ? (
      <StatusMessage tone="error">{failure}</StatusMessage>
    ) : null;
  const { record, cases, proposal } = view;
  const revision = record.revision;
  const save = (clearSplit?: boolean) =>
    void send({
      action: 'trust-save',
      target,
      revision,
      reasons: clearSplit ? record.reasons : reasons,
      humanRequired: clearSplit ? record.humanRequired : humanRequired,
      clearSplit,
    });
  const decide = (
    decision: 'accept' | 'dismiss' | 'preview',
    condition?: GateTrustCondition,
  ) => {
    if (!proposal) return;
    void send({
      action: 'trust-decide',
      target,
      revision,
      evidence: proposal.evidence,
      definition: view.definition,
      decision,
      condition,
    });
  };
  const parsed =
    draft &&
    gateTrustConditionSchema.safeParse({
      ...draft,
      passedChecks: list(checks),
      protectedPaths: list(paths),
    });
  return (
    <section
      className="space-y-2.5 border-b border-border pb-3"
      aria-label="Gate trust"
    >
      <SectionLabel>Gate trust</SectionLabel>
      <Field id={id} label="Why is this gate human?">
        <Textarea
          id={id}
          rows={2}
          maxLength={2000}
          value={reasons}
          placeholder="Critical paths, missing evidence, or review policy"
          onChange={event => setReasons(event.target.value)}
        />
      </Field>
      <Field
        id={`${id}-required`}
        label="Always require a person"
        layout="inline"
      >
        <Checkbox
          id={`${id}-required`}
          checked={humanRequired}
          onCheckedChange={value => setHumanRequired(value === true)}
        />
      </Field>
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="xs"
          variant="secondary"
          disabled={
            busy ||
            (reasons.trim() === record.reasons &&
              humanRequired === record.humanRequired)
          }
          onClick={() => save()}
        >
          Save trust record
        </Button>
        {cases.length > 0 && (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={showCases}
            onClick={() => setShowCases(!showCases)}
          >
            {showCases
              ? 'Hide decision cases'
              : `Show ${cases.length} decision ${cases.length === 1 ? 'case' : 'cases'}`}
          </Button>
        )}
      </div>
      {!view.memoryEnabled && (
        <p className="text-xs text-muted-foreground">
          Enable decision memory to collect cases for this gate.
        </p>
      )}
      {showCases &&
        [true, false].map(safe => (
          <div className="space-y-1.5" key={String(safe)}>
            <SectionLabel>
              {safe ? 'Would have been safe to automate' : 'Still needed me'}
              {' ('}
              {cases.filter(item => item.safe === safe).length}
              {')'}
            </SectionLabel>
            <ul className="divide-y divide-border">
              {cases
                .filter(item => item.safe === safe)
                .map(item => (
                  <li
                    key={item.stepId}
                    className="space-y-1 py-2 text-xs text-muted-foreground [overflow-wrap:anywhere]"
                  >
                    <p className="font-medium text-foreground">
                      {item.decision === 'accept'
                        ? 'Approved'
                        : item.decision === 'fix'
                          ? 'Asked for fixes'
                          : 'Rejected'}{' '}
                      — {item.stage} — {item.lane ?? 'unassigned'} lane
                    </p>
                    <p>
                      {item.files ?? 'Unknown'} files, {item.lines ?? 'unknown'}{' '}
                      changed lines, {item.risk} risk
                    </p>
                    {item.paths.length > 0 && <p>{item.paths.join(', ')}</p>}
                    <p>
                      {item.checks.length
                        ? `Passed ${item.checks.join(', ')}`
                        : 'No passing checks recorded'}
                    </p>
                    {item.concerns.includes('diff') && (
                      <p>A complete text diff was unavailable.</p>
                    )}
                    {item.concerns.includes('override') && (
                      <p>The owner overrode a policy decision.</p>
                    )}
                    {onSession && item.sessionId && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          onSession(hostKey(hostId, item.sessionId!))
                        }
                      >
                        Open source run
                      </Button>
                    )}
                  </li>
                ))}
            </ul>
          </div>
        ))}
      {record.split && (
        <div className="space-y-1.5 border-t border-border pt-2">
          <p className="text-ui font-medium">
            {view.current
              ? 'Accepted split'
              : 'Split needs review after a definition change'}
          </p>
          <p className="text-xs text-muted-foreground">
            Trusted branch {conditionText(record.split.condition)} Other cases
            ask a person.
          </p>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => save(true)}
          >
            Remove split
          </Button>
        </div>
      )}
      {assistant && (
        <Button
          size="xs"
          variant="ghost"
          className="h-auto min-h-7 whitespace-normal text-left"
          disabled={busy}
          onClick={() => void send({ action: 'trust-ask', target })}
        >
          What would I need to make this gate more autonomous?
        </Button>
      )}
      {asked && !proposal && record.dismissed && (
        <p className="text-xs text-muted-foreground">
          The dismissed suggestion will stay hidden until new decisions are
          recorded.
        </p>
      )}
      {proposal && (
        <div className="space-y-2 border-t border-border pt-2">
          <SectionLabel>Trust conditions</SectionLabel>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {proposal.findings.map(finding => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
          {proposal.candidate && (
            <p className="text-ui">
              Trusted branch {conditionText(proposal.candidate)}
            </p>
          )}
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {proposal.trusted} past cases in the trusted branch,{' '}
            {proposal.human} in the human branch.
          </p>
          {draft && (
            <div className="space-y-2">
              <Field
                id={`${id}-lane`}
                label="When"
                hint={'Use lane == "light" or lane == "full".'}
              >
                <Input
                  id={`${id}-lane`}
                  value={draft.when}
                  onChange={event =>
                    setDraft({
                      ...draft,
                      when: event.target.value as GateTrustCondition['when'],
                    })
                  }
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field id={`${id}-files`} label="Maximum files">
                  <Input
                    id={`${id}-files`}
                    type="number"
                    min={1}
                    max={50}
                    value={draft.maximumFiles}
                    onChange={event =>
                      setDraft({
                        ...draft,
                        maximumFiles: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field id={`${id}-lines`} label="Maximum lines">
                  <Input
                    id={`${id}-lines`}
                    type="number"
                    min={1}
                    max={500}
                    value={draft.maximumLines}
                    onChange={event =>
                      setDraft({
                        ...draft,
                        maximumLines: Number(event.target.value),
                      })
                    }
                  />
                </Field>
              </div>
              <Field
                id={`${id}-checks`}
                label="Passing steps"
                hint="Separate step names with commas."
              >
                <Input
                  id={`${id}-checks`}
                  value={checks}
                  onChange={event => setChecks(event.target.value)}
                />
              </Field>
              <Field
                id={`${id}-paths`}
                label="Paths that require a human"
                hint="Separate repository-relative files or folders with commas."
              >
                <Input
                  id={`${id}-paths`}
                  value={paths}
                  onChange={event => setPaths(event.target.value)}
                />
              </Field>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {draft ? (
              <Button
                size="xs"
                variant="secondary"
                disabled={busy || !parsed?.success}
                onClick={() =>
                  parsed?.success && decide('preview', parsed.data)
                }
              >
                Preview edit
              </Button>
            ) : (
              proposal.candidate && (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (!proposal.candidate) return;
                    setDraft(proposal.candidate);
                    setChecks(proposal.candidate.passedChecks.join(', '));
                    setPaths(proposal.candidate.protectedPaths.join(', '));
                  }}
                >
                  Edit
                </Button>
              )
            )}
            {proposal.condition && (
              <Button
                size="xs"
                variant="secondary"
                disabled={
                  busy ||
                  Boolean(
                    draft &&
                    (!parsed?.success ||
                      JSON.stringify(parsed.data) !==
                        JSON.stringify(proposal.condition)),
                  )
                }
                onClick={() =>
                  decide('accept', proposal.condition ?? undefined)
                }
              >
                Accept split
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => decide('dismiss')}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {failure && <StatusMessage tone="error">{failure}</StatusMessage>}
    </section>
  );
}
