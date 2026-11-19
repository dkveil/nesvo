import { useState } from 'react';
import {
  checkStackDetectors,
  checkStackSchema,
  type CheckCandidate,
  type CheckEvidence,
  type CheckProjectProfile,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { Disclosure } from '@/shared/ui/disclosure';
import { KeyValueList } from '@/shared/ui/key-value-list';
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusMessage } from '@/shared/ui/status-message';

const outcomes: Record<
  CheckEvidence['invocations'][number]['outcome'],
  string
> = {
  'setup-mismatch': 'Setup mismatch',
  blocked: 'Blocked',
  passed: 'Passed',
  failed: 'Failed',
  timeout: 'Timed out',
};

function targetOf(candidate: CheckCandidate) {
  const target = candidate.target;
  if ('tool' in target) return [target.tool, ...target.args].join(' ');
  return target.runner === 'package-script' ? target.script : target.task;
}

function MappingUndo({
  hostId,
  mapping,
}: {
  hostId: string;
  mapping: NonNullable<CheckEvidence['mapping']>;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    status: 'success' | 'error';
    text: string;
  } | null>(null);
  const undo = async () => {
    setPending(true);
    try {
      const result = await window.nesvo.workflows.assistantUndo(
        hostId,
        mapping,
      );
      setMessage(
        result.status === 'undone'
          ? { status: 'success', text: 'Project mapping undone.' }
          : {
              status: 'error',
              text:
                result.status === 'conflict'
                  ? result.message
                  : (result.issues[0]?.message ?? 'Undo was refused.'),
            },
      );
    } catch (error) {
      setMessage({ status: 'error', text: errorDetail(error) });
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="space-y-2">
      {message && (
        <StatusMessage tone={message.status === 'error' ? 'error' : 'success'}>
          {message.text}
        </StatusMessage>
      )}
      {message?.status !== 'success' && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={pending}
          onClick={() => void undo()}
        >
          {pending ? 'Undoing…' : 'Undo Project mapping'}
        </Button>
      )}
    </div>
  );
}

export function CheckObservation({
  check,
  profile,
  hostId,
}: {
  check: CheckEvidence;
  profile: CheckProjectProfile | undefined;
  hostId: string;
}) {
  const selected = check.proposed;
  const stack = checkStackSchema.safeParse(profile?.stack);
  const entries = [
    ...(profile
      ? [
          {
            key: 'stack',
            label: 'Stack',
            value: stack.success
              ? checkStackDetectors[stack.data].label
              : profile.stack === 'ambiguous'
                ? 'Ambiguous'
                : 'Unknown',
          },
        ]
      : []),
    ...(selected
      ? [{ key: 'selected', label: 'Chosen check', value: targetOf(selected) }]
      : []),
    ...(check.rationale
      ? [{ key: 'rationale', label: 'Why', value: check.rationale }]
      : []),
  ];
  return (
    <section aria-label="Check evidence" className="space-y-2">
      <SectionLabel className="px-0">Check evidence</SectionLabel>
      {entries.length > 0 && <KeyValueList entries={entries} />}
      {check.invocations.map((entry, index) => {
        const reason =
          entry.outcome !== 'passed' &&
          entry.reason !== check.invocations[index + 1]?.substitution
            ? entry.reason
            : null;
        const facts = [
          ...(entry.substitution
            ? [
                {
                  key: 'substitution',
                  label: 'Substitution',
                  value: entry.substitution,
                },
              ]
            : []),
          ...(entry.exitCode === null
            ? []
            : [{ key: 'exit', label: 'Exit code', value: entry.exitCode }]),
          ...(entry.proof
            ? [{ key: 'proof', label: 'Suite', value: entry.proof }]
            : []),
        ];
        return (
          <div
            key={entry.candidate.id}
            className="space-y-1.5 border-t border-border py-2"
          >
            <p className="font-medium">
              {entry.substitution ? 'Alternate' : 'Selected check'} ·{' '}
              {outcomes[entry.outcome]}
            </p>
            {entry.command && (
              <CodeBlock
                code={entry.command}
                aria-label={'Check command ' + (index + 1)}
                wrap
              />
            )}
            {facts.length > 0 && <KeyValueList entries={facts} />}
            {reason && (
              <p className="leading-5 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                {reason}
              </p>
            )}
          </div>
        );
      })}
      <Disclosure title="Details" contentClassName="space-y-2 px-2">
        <KeyValueList
          entries={[
            {
              key: 'profile',
              label: 'Profile SHA-256',
              value: <span className="font-mono">{check.profileHash}</span>,
            },
          ]}
        />
        {check.invocations.map(({ candidate, substitution }) => (
          <div key={candidate.id} className="space-y-1">
            <p className="font-medium text-foreground">
              {substitution ? 'Alternate' : 'Selected check'}
            </p>
            <KeyValueList
              entries={[
                {
                  key: 'source',
                  label: 'Source',
                  value:
                    candidate.source.file + ' · ' + candidate.source.location,
                },
                {
                  key: 'hash',
                  label: 'Source SHA-256',
                  value: (
                    <span className="font-mono">{candidate.source.hash}</span>
                  ),
                },
                { key: 'module', label: 'Module', value: candidate.directory },
              ]}
            />
          </div>
        ))}
      </Disclosure>
      {check.mapping && (
        <MappingUndo
          key={check.mapping.changeId}
          hostId={hostId}
          mapping={check.mapping}
        />
      )}
    </section>
  );
}
