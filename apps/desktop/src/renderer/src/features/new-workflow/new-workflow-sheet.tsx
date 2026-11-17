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
import { FieldError } from '@/features/edit-automation/field-error';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { ScrollArea } from '@/shared/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/shared/ui/sheet';
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

const scopeOptions: { value: DefinitionScope; label: string; hint: string }[] =
  [
    {
      value: 'project',
      label: 'Project',
      hint: 'Saved in .agents/workflows of the chosen folder.',
    },
    {
      value: 'global',
      label: 'Global',
      hint: 'Saved in the home folder and shared by every project.',
    },
  ];

const nameMessage = (name: string) => {
  if (!name.trim()) return 'Give the workflow a name.';
  return stepNameSchema.safeParse(name).success
    ? ''
    : 'Use lowercase letters, digits and single hyphens.';
};

export function NewWorkflowSheet({
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
    <Sheet
      open
      onOpenChange={open => {
        if (!open && !pending) onClose();
      }}
    >
      <SheetContent
        className="w-full gap-0 bg-card p-0 sm:max-w-md"
        aria-describedby={`${id}-description`}
      >
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="text-sm">New workflow</SheetTitle>
          <SheetDescription id={`${id}-description`} className="text-xs">
            A graph of steps that checks a task. The graph editor opens with
            these details and writes the file when you save.
          </SheetDescription>
        </SheetHeader>
        <form
          ref={form}
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={event => {
            event.preventDefault();
            void submit();
          }}
        >
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-5 px-5 py-4">
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-name`} className="text-xs">
                  Name
                </Label>
                <Input
                  size="md"
                  id={`${id}-name`}
                  data-field="name"
                  autoFocus
                  value={name}
                  maxLength={workflowDefinitionLimits.name}
                  placeholder="release"
                  spellCheck={false}
                  aria-invalid={!!visibleNameError}
                  aria-describedby={
                    visibleNameError ? `${id}-name-error` : `${id}-name-hint`
                  }
                  disabled={pending}
                  onChange={event => setName(event.target.value)}
                  onBlur={() => setTouched(true)}
                  className="h-8 font-mono text-[13px]"
                />
                <FieldError
                  id={`${id}-name-error`}
                  message={visibleNameError}
                />
                {!visibleNameError && (
                  <p
                    id={`${id}-name-hint`}
                    className="text-2xs leading-4 text-muted-foreground"
                  >
                    The name is the file name and stays.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-description-field`} className="text-xs">
                  Description
                </Label>
                <Textarea
                  size="lg"
                  id={`${id}-description-field`}
                  value={description}
                  maxLength={workflowDefinitionLimits.description + 1}
                  placeholder="What this workflow checks and when to use it."
                  aria-invalid={descriptionTooLong}
                  disabled={pending}
                  onChange={event => setDescription(event.target.value)}
                  className="min-h-16 text-[13px] leading-5"
                />
                <FieldError
                  id={`${id}-description-error`}
                  message={
                    descriptionTooLong
                      ? `At most ${workflowDefinitionLimits.description} characters.`
                      : ''
                  }
                />
              </div>
              <div className="space-y-1.5">
                <span className="text-xs font-medium">Computer and folder</span>
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
                <p className="text-2xs leading-4 text-muted-foreground">
                  {trimmedDirectory
                    ? 'The project is the nearest folder with .git at or above this folder.'
                    : 'Without a folder the workflow is saved globally.'}
                </p>
              </div>
              <div className="space-y-1.5">
                <span className="text-xs font-medium">Scope</span>
                <div
                  role="radiogroup"
                  aria-label="Scope"
                  className="flex gap-1"
                >
                  {scopeOptions.map(option => {
                    const disabled =
                      pending ||
                      (option.value === 'project' && !trimmedDirectory);
                    const checked = effectiveScope === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        disabled={disabled}
                        title={
                          option.value === 'project' && !trimmedDirectory
                            ? 'Choose a folder to save in the project.'
                            : option.hint
                        }
                        onClick={() => setScope(option.value)}
                        className={
                          checked
                            ? 'h-7 rounded-md border border-ring bg-highlight px-2.5 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring'
                            : 'h-7 rounded-md border px-2.5 text-xs text-muted-foreground transition-colors duration-100 outline-none enabled:hover:bg-accent enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'
                        }
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-2xs leading-4 text-muted-foreground">
                  {
                    scopeOptions.find(option => option.value === effectiveScope)
                      ?.hint
                  }
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-notes`} className="text-xs">
                  Notes
                </Label>
                <Textarea
                  size="lg"
                  id={`${id}-notes`}
                  value={body}
                  maxLength={workflowDefinitionLimits.body}
                  placeholder="Free text kept below the frontmatter of the workflow file."
                  disabled={pending}
                  onChange={event => setBody(event.target.value)}
                  className="min-h-20 text-[13px] leading-5"
                />
              </div>
            </div>
          </ScrollArea>
          <SheetFooter className="gap-2 border-t px-5 py-3">
            {(error || blockedReason) && (
              <p
                role="alert"
                className="text-xs text-destructive [overflow-wrap:anywhere]"
              >
                {error || blockedReason}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="md"
                disabled={pending}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="md"
                disabled={pending || !!blockedReason}
              >
                {pending ? 'Opening…' : 'Create and open'}
              </Button>
            </div>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
