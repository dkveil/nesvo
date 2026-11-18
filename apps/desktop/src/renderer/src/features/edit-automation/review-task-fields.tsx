import { modelLabel } from '@/entities/session';
import { Field } from '@/shared/ui/field';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { StatusMessage } from '@/shared/ui/status-message';
import { REVIEW_CHECK_COMMAND, type AutomationValues } from './automation-form';
import { errorMessages, messagesId } from './field-messages';
import type { useReviewProfiles } from './use-review-profiles';

type ReviewProfiles = ReturnType<typeof useReviewProfiles>;

type ReviewTaskFieldsProps = {
  values: AutomationValues;
  profiles: ReviewProfiles;
  error: string | undefined;
  disabled: boolean;
  onChange: (patch: Partial<AutomationValues>) => void;
};

type Task = 'prompt' | 'review';

export function ReviewTaskFields({
  values,
  profiles,
  error,
  disabled,
  onChange,
}: ReviewTaskFieldsProps) {
  const chooseTask = (task: Task) =>
    onChange(
      task === 'review'
        ? {
            reviewMode: true,
            checkEnabled: true,
            checkCommand: values.checkCommand || REVIEW_CHECK_COMMAND,
            askFirst: true,
            writable: false,
            browser: false,
            redCi: false,
          }
        : { reviewMode: false, reviewProfileId: '' },
    );
  return (
    <>
      <Field id="automation-task" label="Task" as="span">
        <SegmentedControl
          label="Automation task"
          value={values.reviewMode ? 'review' : 'prompt'}
          fullWidth
          disabled={disabled}
          options={[
            { value: 'prompt', label: 'Prompt' },
            { value: 'review', label: 'Review new pull requests' },
          ]}
          onChange={chooseTask}
        />
      </Field>
      {values.reviewMode && (
        <Field
          id="automation-review-profile"
          label="Reviewer profile"
          hint="Reviews use the profile’s provider and model in read-only mode. Choose the repository checkout as the folder below."
          messages={errorMessages(error)}
        >
          {profiles.status === 'error' ? (
            <StatusMessage tone="error">{profiles.error}</StatusMessage>
          ) : (
            <Select
              value={values.reviewProfileId}
              onValueChange={reviewProfileId => onChange({ reviewProfileId })}
              disabled={disabled || !profiles.profiles.length}
            >
              <SelectTrigger
                id="automation-review-profile"
                data-field="review"
                size="md"
                className="w-full"
                aria-invalid={!!error}
                aria-describedby={messagesId(
                  'automation-review-profile',
                  error,
                )}
              >
                <SelectValue
                  placeholder={
                    profiles.status === 'loading'
                      ? 'Loading profiles…'
                      : profiles.profiles.length
                        ? 'Choose a profile'
                        : 'Add a profile in Settings › Code review'
                  }
                />
              </SelectTrigger>
              <SelectContent position="popper">
                {profiles.profiles.map(profile => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name} · {profile.provider}{' '}
                    {profile.provider === 'Claude Code'
                      ? modelLabel(profile.model)
                      : profile.model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      )}
    </>
  );
}
