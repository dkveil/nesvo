import { useState } from 'react';
import type {
  CheckCandidate,
  CheckEvidence,
  CheckProjectProfile,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { KeyValueList } from '@/shared/ui/key-value-list';
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusMessage } from '@/shared/ui/status-message';
import { Hint } from '@/shared/ui/tooltip';

const stackLabels: Record<CheckProjectProfile['stack'], string> = {
  typescript: 'TypeScript',
  kotlin: 'Kotlin',
  ambiguous: 'Ambiguous',
  unknown: 'Unknown',
};

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
  const entries = [
    ...(profile
      ? [{ key: 'stack', label: 'Stack', value: stackLabels[profile.stack] }]
      : []),
    ...(selected
      ? [{ key: 'selected', label: 'Selected', value: targetOf(selected) }]
      : []),
  ];
  return (
    <section aria-label="Check evidence" className="space-y-2">
      <SectionLabel className="px-0">Check evidence</SectionLabel>
      {entries.length > 0 && <KeyValueList entries={entries} />}
      {check.rationale && (
        <p className="leading-5 text-muted-foreground [overflow-wrap:anywhere]">
          {check.rationale}
        </p>
      )}
      {check.invocations.map((entry, index) => {
        const { source } = entry.candidate;
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
            <KeyValueList
              entries={[
                {
                  key: 'source',
                  label: 'Source',
                  value: source.file + ' · ' + source.location,
                },
                {
                  key: 'hash',
                  label: 'SHA-256',
                  value: (
                    <Hint label={source.hash}>
                      <span className="font-mono" title={source.hash}>
                        {source.hash.slice(0, 12)}
                        {'\u2026'}
                      </span>
                    </Hint>
                  ),
                },
                ...(entry.candidate.directory === '.'
                  ? []
                  : [
                      {
                        key: 'folder',
                        label: 'Module',
                        value: entry.candidate.directory,
                      },
                    ]),
                ...(entry.exitCode === null
                  ? []
                  : [
                      {
                        key: 'exit',
                        label: 'Exit code',
                        value: entry.exitCode,
                      },
                    ]),
                ...(entry.proof
                  ? [{ key: 'proof', label: 'Suite', value: entry.proof }]
                  : []),
              ]}
            />
            {entry.outcome !== 'passed' && (
              <p className="leading-5 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                {entry.reason}
              </p>
            )}
          </div>
        );
      })}
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
