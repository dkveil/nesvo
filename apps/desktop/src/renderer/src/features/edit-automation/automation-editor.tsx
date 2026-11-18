import { useRef } from 'react';
import { ScrollArea } from '@/shared/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/shared/ui/sheet';
import {
  automationEditorDescription,
  automationEditorTitle,
} from './automation-copy';
import {
  AutomationEditorButtons,
  AutomationEditorMessages,
} from './automation-editor-actions';
import {
  AutomationLimitFields,
  AutomationLocationField,
  AutomationModelField,
  AutomationNameField,
  AutomationScheduleField,
  AutomationTaskFields,
  AutomationTriggerFields,
} from './automation-fields';
import {
  useAutomationEditor,
  type AutomationEditorProps,
} from './use-automation-editor';

export function AutomationEditor(props: AutomationEditorProps) {
  const form = useRef<HTMLFormElement>(null);
  const editor = useAutomationEditor(props, form);
  return (
    <Sheet
      open
      onOpenChange={open => {
        if (!open && !editor.pending) editor.close();
      }}
    >
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{automationEditorTitle(editor.editing)}</SheetTitle>
          <SheetDescription>
            {automationEditorDescription(editor.values)}
          </SheetDescription>
        </SheetHeader>
        <form
          ref={form}
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={event => {
            event.preventDefault();
            void editor.save();
          }}
        >
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-4 px-5 py-4">
              <AutomationNameField editor={editor} />
              <AutomationTaskFields editor={editor} />
              <AutomationLocationField editor={editor} />
              <AutomationModelField editor={editor} />
              <AutomationScheduleField editor={editor} />
              <AutomationTriggerFields editor={editor} />
              <AutomationLimitFields editor={editor} />
            </div>
          </ScrollArea>
          <SheetFooter className="flex-wrap">
            <AutomationEditorMessages editor={editor} />
            <AutomationEditorButtons editor={editor} />
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
