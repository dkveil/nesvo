import { Button } from '@/shared/ui/button';
import { DialogCancel } from '@/shared/ui/dialog';
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
  const { pending, blockedReason, stale, errors, close, editing } = editor;
  return (
    <>
      {editing ? (
        <Button
          type="button"
          variant="ghost"
          size="md"
          disabled={pending}
          onClick={close}
        >
          Cancel
        </Button>
      ) : (
        <DialogCancel disabled={pending} onClick={close} />
      )}
      <Button
        type="submit"
        size={editing ? 'md' : 'lg'}
        disabled={
          pending ||
          !!blockedReason ||
          stale ||
          errors.prompt === SKILL_PROMPT_MESSAGE
        }
      >
        {editing
          ? pending
            ? 'Saving…'
            : 'Save'
          : pending
            ? 'Creating…'
            : 'Create'}
      </Button>
    </>
  );
}
