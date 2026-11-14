import { useId } from 'react';
import { formatEdge, graphMessages } from '@nesvo/contracts';
import { ArrowRight } from 'lucide-react';
import { edgeWhenLabels } from '@/entities/pipeline-graph';
import { Button } from '@/shared/ui/button';
import { notesId } from './field-notes';
import { Field, Segmented, type SegmentOption } from './fields';
import type { EdgeInspectorProps, EdgeWhen } from './index';

const HUMAN_ROUTING_REASON =
  'Human decisions are accept, reject or fix and are not routed on failure.';

const whenOptions = (human: boolean): SegmentOption<EdgeWhen>[] => [
  {
    value: 'success',
    label: edgeWhenLabels.success,
    title: 'Runs when the source step passes.',
  },
  {
    value: 'failure',
    label: edgeWhenLabels.failure,
    disabled: human,
    title: human ? HUMAN_ROUTING_REASON : 'Runs when the source step fails.',
  },
  {
    value: 'any',
    label: edgeWhenLabels.any,
    title: 'Runs after the source step ends.',
  },
];

const whenHints: Record<EdgeWhen, string> = {
  success: 'The target starts after the source passes.',
  failure:
    'The target starts after the source fails. The failure still applies when the phase ends.',
  any: 'The target starts after the source ends, whatever the outcome.',
};

export function EdgeInspectorForm({
  edge,
  sourceType,
  onChange,
  onDelete,
}: EdgeInspectorProps) {
  const fieldId = `${useId()}when`;
  const human = sourceType === 'human';
  const notes =
    human && edge.when === 'failure'
      ? [
          {
            severity: 'error' as const,
            message: graphMessages.humanRouting(formatEdge(edge)),
          },
        ]
      : [];
  return (
    <div
      role="group"
      aria-label={`Connection ${edge.from} to ${edge.to}`}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto p-3">
        <p className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
          <span className="min-w-0 truncate" title={edge.from}>
            {edge.from}
          </span>
          <ArrowRight
            role="img"
            aria-label="to"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 truncate" title={edge.to}>
            {edge.to}
          </span>
        </p>
        <Field
          id={fieldId}
          label="Runs on"
          as="span"
          notes={notes}
          hint={
            human && edge.when !== 'failure'
              ? `${whenHints[edge.when]} ${HUMAN_ROUTING_REASON}`
              : whenHints[edge.when]
          }
        >
          <Segmented
            label="Runs on"
            value={edge.when}
            options={whenOptions(human)}
            toggle
            invalid={notes.length > 0}
            describedBy={notes.length ? notesId(fieldId) : undefined}
            onChange={onChange}
          />
        </Field>
      </div>
      <div className="flex h-11 shrink-0 items-center border-t px-3">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onDelete}
          className="text-muted-foreground"
        >
          Remove connection
        </Button>
      </div>
    </div>
  );
}
