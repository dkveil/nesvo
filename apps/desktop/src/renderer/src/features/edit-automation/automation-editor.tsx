import { useRef, type ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { SectionLabel } from '@/shared/ui/section-label';
import { RitualTemplates } from './ritual-templates';
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

function EditorGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-1.5">
      <SectionLabel as="h3" className="px-0">
        {title}
      </SectionLabel>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

export function AutomationEditor(props: AutomationEditorProps) {
  const form = useRef<HTMLFormElement>(null);
  const editor = useAutomationEditor(props, form);
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && !editor.pending) editor.close();
      }}
    >
      <DialogContent
        data-automation-editor=""
        showCloseButton={!editor.pending}

        className="flex h-[min(calc(100dvh-2rem),52rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
      >
        <DialogHeader className="border-b border-border px-5 py-2.5">
          <DialogTitle>{automationEditorTitle(editor.editing)}</DialogTitle>
          <DialogDescription>
            {automationEditorDescription(editor.values)}
          </DialogDescription>
        </DialogHeader>
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
            <div className="px-5 pt-2.5">
              <RitualTemplates editor={editor} />
            </div>
            <div className="grid gap-x-6 gap-y-3 px-5 py-3 md:grid-cols-2">
              <div className="min-w-0 space-y-3">
                <EditorGroup title="Task">
                  <AutomationNameField editor={editor} />
                </EditorGroup>
                <EditorGroup title="Computer and model">
                  <AutomationLocationField editor={editor} />
                  <AutomationModelField editor={editor} />
                </EditorGroup>
                <AutomationTaskFields editor={editor} />
              </div>
              <div className="min-w-0 space-y-3">
                <EditorGroup title="Schedule">
                  <AutomationScheduleField editor={editor} />
                </EditorGroup>
                <EditorGroup title="Condition and limits">
                  <AutomationTriggerFields editor={editor} />
                  <AutomationLimitFields editor={editor} />
                </EditorGroup>
              </div>
            </div>
          </ScrollArea>
          <DialogFooter className="flex-wrap border-t border-border px-6 py-4 sm:flex-wrap">
            <AutomationEditorMessages editor={editor} />
            <AutomationEditorButtons editor={editor} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
