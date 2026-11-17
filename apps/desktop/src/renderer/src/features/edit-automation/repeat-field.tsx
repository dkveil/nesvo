import {
  scheduleKindLabels,
  scheduleKinds,
  type ScheduleKind,
} from '@/entities/scheduled-job';
import { Field } from '@/shared/ui/field';
import { SegmentedControl } from '@/shared/ui/segmented-control';

type Props = {
  id: string;
  value: ScheduleKind;
  disabled?: boolean;
  onChange: (kind: ScheduleKind) => void;
};

export function RepeatField({ id, value, disabled, onChange }: Props) {
  return (
    <Field id={id} label="Repeat" as="span">
      <SegmentedControl
        label="Repeat"
        fullWidth
        value={value}
        disabled={disabled}
        options={scheduleKinds.map(kind => ({
          value: kind,
          label: scheduleKindLabels[kind],
        }))}
        onChange={onChange}
      />
    </Field>
  );
}
