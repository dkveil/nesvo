import { useId, useRef, useState } from 'react';
import {
  stepNameSchema,
  workflowDefinitionLimits,
  type Computer,
  type DefinitionScope,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { HostPicker } from '@/features/new-thread/host-picker';
import { LocationPicker } from '@/features/new-thread/location-picker';
import { errorMessages } from '@/features/edit-automation/field-messages';
import { Button } from '@/shared/ui/button';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { SavedInField } from '@/shared/ui/saved-in-field';
import { StatusMessage } from '@/shared/ui/status-message';
import { Textarea } from '@/shared/ui/textarea';

export type NewWorkflowDraft = {
  hostId: string;
  directory: string;
  scope: DefinitionScope;
  name: string;
  description: string;
  body: string;
};

type Props = {
  hostId: string;
  directory: string;
  computers: Computer[];
  existingNames: (hostId: string, directory: string) => Promise<string[]>;
  onManageComputers: () => void;
  onCreate: (draft: NewWorkflowDraft) => Promise<void>;
  onClose: () => void;
};

const nameMessage = (name: string) => {
  if (!name.trim()) return 'Give the workflow a name.';
  return stepNameSchema.safeParse(name).success
    ? ''
    : 'Use lowercase letters, digits and single hyphens.';
};

export function NewWorkflowDialog({
  hostId: initialHostId,
  directory: initialDirectory,
  computers,
  existingNames,
  onManageComputers,
  onCreate,
  onClose,
}: Props) {
  const id = useId();
  const [hostId, setHostId] = useState(initialHostId);
  const [directory, setDirectory] = useState(initialDirectory);
  const [scope, setScope] = useState<DefinitionScope>(
    initialDirectory.trim() ? 'project' : 'global',
  );
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [touched, setTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [locationOpen, setLocationOpen] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const computer = computers.find(item => item.id === hostId);
  const connected = computer?.status === 'connected';
  const trimmedDirectory = directory.trim();
  const effectiveScope: DefinitionScope = trimmedDirectory ? scope : 'global';
  const nameError = nameMessage(name);
  const visibleNameError = touched || attempted ? nameError : '';
  const descriptionTooLong =
    description.length > workflowDefinitionLimits.description;
  const blockedReason = !connected
    ? `${computer?.name ?? 'This computer'} is offline.`
    : '';
  const submit = async () => {
    setAttempted(true);
    if (nameError || descriptionTooLong || blockedReason) {
      form.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus();
      return;
    }
    setPending(true);
    setError('');
    try {
      const taken = await existingNames(hostId, trimmedDirectory);
      if (taken.includes(name.trim())) {
        setError(
          `A workflow named "${name.trim()}" already exists here. Open it with Edit.`,
        );
        return;
      }
      await onCreate({
        hostId,
        directory: trimmedDirectory,
        scope: effectiveScope,
        name: name.trim(),
        description: description.trim(),
        body,
      });
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open onOpenChange={open => !open && !pending && onClose()}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-3 p-4"
        showCloseButton={!pending}
      >
        <DialogHeader className="pr-8">
          <DialogTitle size="sm">New workflow</DialogTitle>
          <DialogDescription>
            Define what the workflow checks, then add steps in the graph editor.
          </DialogDescription>
        </DialogHeader>
        <form
          ref={form}
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={event => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-0.5 py-0.5">
            <Field
              id={`${id}-name`}
              label="Name"
              hint={
                visibleNameError
                  ? undefined
                  : 'The name is the file name and stays.'
              }
              messages={errorMessages(visibleNameError)}
            >
              <Input
                size="md"
                id={`${id}-name`}
                data-field="name"
                value={name}
                maxLength={workflowDefinitionLimits.name}
                placeholder="release"
                spellCheck={false}
                aria-invalid={!!visibleNameError}
                aria-describedby={
                  visibleNameError ? `${id}-name-messages` : `${id}-name-hint`
                }
                disabled={pending}
                onChange={event => setName(event.target.value)}
                onBlur={() => setTouched(true)}
                className="font-mono placeholder:font-sans"
              />
            </Field>
            <Field
              id={`${id}-description-field`}
              label="Description"
              messages={errorMessages(
                descriptionTooLong
                  ? `At most ${workflowDefinitionLimits.description} characters.`
                  : '',
              )}
            >
              <Textarea
                size="md"
                id={`${id}-description-field`}
                value={description}
                maxLength={workflowDefinitionLimits.description + 1}
                placeholder="What this workflow checks and when to use it."
                aria-invalid={descriptionTooLong}
                disabled={pending}
                onChange={event => setDescription(event.target.value)}
              />
            </Field>
            <Field
              id={`${id}-location`}
              label="Computer and folder"
              as="span"
              hint={
                trimmedDirectory
                  ? 'The project is the nearest folder with .git at or above this folder.'
                  : 'Without a folder the workflow is saved globally.'
              }
            >
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                <HostPicker
                  computers={computers}
                  hostId={hostId}
                  disabled={pending}
                  onChange={setHostId}
                  onManageComputers={onManageComputers}
                />
                <LocationPicker
                  directory={directory}
                  computerName={computer?.name ?? 'this computer'}
                  disabled={pending}
                  open={locationOpen && !pending}
                  onOpenChange={setLocationOpen}
                  onChange={setDirectory}
                />
              </div>
            </Field>
            <SavedInField
              id={`${id}-scope`}
              scope={effectiveScope}
              size="md"
              disabled={pending}
              projectDisabled={!trimmedDirectory}
              onChange={setScope}
            />
            <Field id={`${id}-notes`} label="Notes">
              <Textarea
                size="md"
                id={`${id}-notes`}
                value={body}
                maxLength={workflowDefinitionLimits.body}
                placeholder="Free text kept below the frontmatter of the workflow file."
                disabled={pending}
                onChange={event => setBody(event.target.value)}
                className="min-h-20"
              />
            </Field>
          </div>
          {(error || blockedReason) && (
            <StatusMessage tone="error" className="shrink-0 pt-2">
              {error || blockedReason}
            </StatusMessage>
          )}
          <DialogFooter className="shrink-0 pt-3">
            <DialogCancel disabled={pending} onClick={onClose} />
            <Button
              type="submit"
              size="lg"
              disabled={pending || !!blockedReason}
            >
              {pending ? 'Opening…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
