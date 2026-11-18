import { Button } from '@/shared/ui/button';
import { StatusMessage } from '@/shared/ui/status-message';
import { SKILL_PROMPT_MESSAGE } from './automation-form';
import type { AutomationEditorState } from './use-automation-editor';

export function AutomationEditorMessages({
  editor,
}: {
  editor: AutomationEditorState;
}) {
  const { stale, error, blockedReason, computer, reload } = editor;
  return (
    <>
      {stale && (
        <div className="flex w-full items-center justify-between gap-2">
          <StatusMessage tone="error">
            This automation changed on {computer?.name ?? 'its computer'}.
            Reload to edit the latest version.
          </StatusMessage>
          <Button type="button" size="xs" variant="outline" onClick={reload}>
            Reload
          </Button>
        </div>
      )}
      {(error || blockedReason) && (
        <StatusMessage tone="error" className="w-full">
          {error || blockedReason}
        </StatusMessage>
      )}
    </>
  );
}

export function AutomationEditorButtons({
  editor,
}: {
  editor: AutomationEditorState;
}) {
  const { pending, blockedReason, stale, errors, close } = editor;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="md"
        disabled={pending}
        onClick={close}
      >
        Cancel
      </Button>
      <Button
        type="submit"
        size="md"
        disabled={
          pending ||
          !!blockedReason ||
          stale ||
          errors.prompt === SKILL_PROMPT_MESSAGE
        }
      >
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </>
  );
}
