import { useRef, type RefObject } from 'react';
import { promptSkillSchema, type PromptSkill } from '@nesvo/contracts';
import { StatusMessage } from '@/shared/ui/status-message';
import { Textarea, type TextareaProps } from '@/shared/ui/textarea';
import { SelectSkill, type SkillScope } from './index';
import { SelectedSkillChip } from './selected-skill-chip';
import { promptSlashQuery } from './skill-command';

type Props = Omit<TextareaProps, 'onChange' | 'value'> & {
  value: string;
  skill?: PromptSkill;
  scope: SkillScope;
  available?: boolean;
  unavailableMessage?: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string, skill: PromptSkill | undefined) => void;
};

export function PromptTextarea({
  value,
  skill,
  scope,
  available = true,
  unavailableMessage,
  inputRef,
  onChange,
  onKeyDown: onPromptKeyDown,
  ...props
}: Props) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  const textarea = inputRef ?? localRef;
  const query = promptSlashQuery(value);
  return (
    <SelectSkill
      scope={scope}
      api={window.nesvo}
      draft={query}
      selection={skill}
      enabled={available}
      requireSnapshot
      onSelect={entry => {
        const selected = promptSkillSchema.strip().parse(entry);
        onChange(
          value.slice(0, value.length - query.length).trimEnd(),
          selected,
        );
      }}
      onFocusMessage={() => textarea.current?.focus()}
    >
      {({ anchor, inputAria, onInput, onKeyDown, selectionIssue }) => (
        <div>
          {skill && (
            <SelectedSkillChip
              skill={skill}
              onRemove={() => onChange(value, undefined)}
              disabled={props.disabled}
            />
          )}
          {anchor(
            <Textarea
              {...props}
              {...inputAria}
              resize="none"
              ref={textarea}
              value={value}
              onKeyDown={event => {
                onKeyDown(event);
                if (!event.defaultPrevented) onPromptKeyDown?.(event);
              }}
              onChange={event => {
                onInput();
                onChange(event.target.value, skill);
              }}
            />,
          )}
          {selectionIssue && (
            <StatusMessage tone="warning">
              {!available && unavailableMessage
                ? unavailableMessage
                : selectionIssue}
            </StatusMessage>
          )}
        </div>
      )}
    </SelectSkill>
  );
}
