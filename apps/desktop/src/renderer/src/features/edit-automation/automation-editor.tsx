import { useId, useRef, type ReactNode } from 'react';
import { Clock } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { PanelBody } from '@/shared/ui/panel';
import {
  SidePanel,
  SidePanelHeader,
  SidePanelFooter,
} from '@/shared/ui/side-panel';
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
  const descriptionId = useId();
  const editor = useAutomationEditor(props, form);
  const editorForm = (
    <form
      ref={form}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={event => {
        event.preventDefault();
        void editor.save();
      }}
    >
      <PanelBody className="@container overscroll-contain">
        {editor.editing && (
          <p
            id={descriptionId}
            className="px-3 pt-3 text-xs text-muted-foreground"
          >
            {automationEditorDescription(editor.values)}
          </p>
        )}
        <div className="px-3 pt-3">
          <RitualTemplates editor={editor} />
        </div>
        <div className="grid gap-3 p-3 @2xl:grid-cols-2">
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
      </PanelBody>
      {(editor.error || editor.blockedReason || editor.stale) && (
        <div className="shrink-0 px-3 pb-2">
          <AutomationEditorMessages editor={editor} />
        </div>
      )}
      {editor.editing ? (
        <SidePanelFooter
          label="Automation actions"
          className="justify-end gap-2"
        >
          <AutomationEditorButtons editor={editor} />
        </SidePanelFooter>
      ) : (
        <DialogFooter className="shrink-0 px-3 pt-2">
          <AutomationEditorButtons editor={editor} />
        </DialogFooter>
      )}
    </form>
  );
  if (!editor.editing)
    return (
      <Dialog
        open
        onOpenChange={open => !open && !editor.pending && editor.close()}
      >
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-3 sm:max-w-[44rem]"
          data-automation-editor=""
          showCloseButton={!editor.pending}
        >
          <DialogHeader className="px-3 pt-1 pr-8">
            <DialogTitle size="sm">New automation</DialogTitle>
            <DialogDescription>
              {automationEditorDescription(editor.values)}
            </DialogDescription>
          </DialogHeader>
          {editorForm}
        </DialogContent>
      </Dialog>
    );
  return (
    <SidePanel
      kind="automation-editor"
      resizeLabel="Resize automation editor"
      role="dialog"
      aria-label={automationEditorTitle(editor.editing)}
      aria-describedby={descriptionId}
      data-automation-editor=""
      focusOnOpen
      onEscape={editor.pending ? undefined : editor.close}
    >
      <SidePanelHeader
        icon={Clock}
        title={automationEditorTitle(editor.editing)}
        closeLabel="Close automation editor"
        closeDisabled={editor.pending}
        onClose={editor.close}
      />
      {editorForm}
    </SidePanel>
  );
}
