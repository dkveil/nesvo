import { useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import {
  STEP_NAME_PATTERN,
  type WorkflowImportFile,
  type WorkflowImportOffer,
  type WorkflowImportResult,
  type WorkflowImportTarget,
  type WorkflowSharingApi,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { formatExpiry } from '@/shared/lib/format-expiry';
import { savedInHint, savedInLabels } from '@/shared/lib/saved-in';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Checkbox } from '@/shared/ui/checkbox';
import { CodeBlock } from '@/shared/ui/code-block';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { SectionLabel } from '@/shared/ui/section-label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { StatusMessage } from '@/shared/ui/status-message';

export type ImportedWorkflow = { directory: string; workflowName: string };

type Props = {
  offer: WorkflowImportOffer | null;
  folders: string[];
  api: Pick<
    WorkflowSharingApi,
    'importWorkflow' | 'pickFolder' | 'dismissImport'
  >;
  onClose: () => void;
  onImported: (imported: ImportedWorkflow) => void;
};

type ReadyOffer = Extract<WorkflowImportOffer, { status: 'ready' }>;

type PlanState =
  | { status: 'error'; key: string; message: string }
  | { status: 'checked'; key: string; result: WorkflowImportResult };

const GLOBAL_LOCATION = 'global';
const PICK_LOCATION = 'pick';

const folderName = (directory: string) =>
  directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory;

const stepType = (content: string) => {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? '';
  const type = /^type:[ \t]*["']?([a-z-]+)/m.exec(frontmatter)?.[1];
  return type ? type[0]!.toUpperCase() + type.slice(1) : 'Step';
};

const locationTarget = (location: string): WorkflowImportTarget =>
  location === GLOBAL_LOCATION
    ? { scope: 'global' }
    : { scope: 'project', directory: location.slice('project:'.length) };

const stateBadge = (file: WorkflowImportFile | undefined) => {
  if (!file) return null;
  if (file.state === 'new')
    return (
      <Badge tone="info" size="xs">
        New
      </Badge>
    );
  if (file.state === 'same')
    return (
      <Badge tone="neutral" size="xs">
        Already there
      </Badge>
    );
  return (
    <Badge tone="warning" size="xs">
      Different file exists
    </Badge>
  );
};

function RefusedLink({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>This link could not be opened</DialogTitle>
        <DialogDescription>
          Nothing was imported and nothing ran.
        </DialogDescription>
      </DialogHeader>
      <StatusMessage tone="error">{message}</StatusMessage>
      <DialogFooter>
        <Button size="lg" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

function ImportReview({
  offer,
  folders,
  api,
  onClose,
  onImported,
}: Omit<Props, 'offer'> & { offer: ReadyOffer }) {
  const { bundle } = offer;
  const [extraFolders, setExtraFolders] = useState<string[]>([]);
  const choices = [...new Set([...folders, ...extraFolders])];
  const [location, setLocation] = useState(
    choices[0] ? `project:${choices[0]}` : GLOBAL_LOCATION,
  );
  const [name, setName] = useState(bundle.name);
  const [checked, setChecked] = useState<PlanState | null>(null);
  const [overwriteKey, setOverwriteKey] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const request = useRef(0);
  const validName = STEP_NAME_PATTERN.test(name) && name.length <= 64;
  const target = locationTarget(location);
  const targetKey = JSON.stringify(target);
  const planKey = `${targetKey}:${name}`;
  useEffect(() => {
    if (!validName) return;
    const id = ++request.current;
    const key = `${targetKey}:${name}`;
    api
      .importWorkflow({
        importId: offer.importId,
        target: JSON.parse(targetKey) as WorkflowImportTarget,
        workflowName: name,
        write: false,
      })
      .then(
        result => {
          if (id === request.current)
            setChecked({ status: 'checked', key, result });
        },
        failure => {
          if (id === request.current)
            setChecked({ status: 'error', key, message: errorDetail(failure) });
        },
      );
  }, [api, offer.importId, targetKey, name, validName]);
  const plan =
    checked?.key === planKey
      ? checked
      : validName
        ? { status: 'checking' as const }
        : null;
  const overwrite = overwriteKey === planKey;
  const setOverwrite = (value: boolean) =>
    setOverwriteKey(value ? planKey : '');
  const result = plan?.status === 'checked' ? plan.result : null;
  const fileFor = (kind: 'step' | 'workflow', fileName: string) =>
    result?.files.find(
      file => file.kind === kind && `${file.name}.md` === fileName,
    );
  const different = result?.files.filter(file => file.state === 'different');
  const workflowFile = result?.files.find(file => file.kind === 'workflow');
  const errors = result?.issues ?? [];
  const canSave =
    !!result &&
    validName &&
    errors.length === 0 &&
    (!different?.length || overwrite) &&
    !saving;
  const save = async () => {
    if (!result) return false;
    setSaving(true);
    setSaveError('');
    try {
      const saved = await api.importWorkflow({
        importId: offer.importId,
        target,
        workflowName: name,
        overwrite: result.files
          .filter(file => file.state === 'different' && file.currentHash)
          .map(file => ({
            kind: file.kind,
            name: file.name,
            expectedHash: file.currentHash!,
          })),
        write: true,
      });
      if (saved.status === 'saved') {
        onImported({
          directory: target.scope === 'project' ? target.directory : '',
          workflowName: name,
        });
        return true;
      }
      setChecked({ status: 'checked', key: planKey, result: saved });
      setSaveError(
        saved.status === 'blocked'
          ? 'The files changed while you reviewed them. Review the changes and save again.'
          : 'The workflow could not be saved. See the issues above.',
      );
      return false;
    } catch (failure) {
      setSaveError(errorDetail(failure));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const chooseLocation = async (value: string) => {
    if (value !== PICK_LOCATION) {
      setLocation(value);
      return;
    }
    const picked = await api.pickFolder();
    if (!picked) return;
    setExtraFolders(current =>
      current.includes(picked) ? current : [...current, picked],
    );
    setLocation(`project:${picked}`);
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Import {bundle.name}</DialogTitle>
        <DialogDescription>
          Shared through {offer.origin.replace(/^https?:\/\//, '')}.
          {offer.expiresAt && ` ${formatExpiry(offer.expiresAt)}.`} Review every
          step before you save. Nothing runs now.
        </DialogDescription>
      </DialogHeader>
      {bundle.description && (
        <p className="text-xs leading-5">{bundle.description}</p>
      )}
      <InlineNotice tone="warning">
        Commands and actions in this workflow run on your computer, with your
        account, when you run the workflow. Agent steps send their instructions
        to your provider. Read them all before you save.
      </InlineNotice>
      {result && result.findingCount > 0 && (
        <section aria-label="Possible secrets" className="space-y-1">
          <InlineNotice tone="warning">
            {result.findingCount === 1
              ? 'One line looks like a secret.'
              : `${result.findingCount} lines look like secrets.`}{' '}
            Check them before you use the workflow.
          </InlineNotice>
          <ul className="space-y-px rounded-surface border p-1">
            {result.findings.map((finding, index) => (
              <li
                key={`${finding.fileName}:${finding.line}:${index}`}
                className="px-2 py-1 font-mono text-2xs break-all text-muted-foreground"
              >
                {finding.fileName}:{finding.line} · {finding.label} ·{' '}
                {finding.excerpt}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Shared steps" className="space-y-2">
        <SectionLabel count={bundle.steps.length}>Steps</SectionLabel>
        {bundle.steps.map(step => (
          <div key={step.fileName} className="space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-medium">
                {step.fileName.slice(0, -'.md'.length)}
              </span>
              <span className="text-2xs text-muted-foreground">
                {stepType(step.content)}
              </span>
              {stateBadge(fileFor('step', step.fileName))}
            </div>
            <CodeBlock
              label={`steps/${step.fileName}`}
              code={step.content}
              wrap
              maxHeightClassName="max-h-64"
            />
          </div>
        ))}
      </section>
      <section aria-label="Shared workflow file" className="space-y-1">
        <div className="flex items-center gap-2">
          <SectionLabel>Workflow</SectionLabel>
          {stateBadge(workflowFile)}
        </div>
        <CodeBlock
          label={`workflows/${bundle.workflow.fileName}`}
          code={bundle.workflow.content}
          wrap
          maxHeightClassName="max-h-64"
        />
      </section>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id="import-workflow-location"
          label="Saved in"
          hint={savedInHint(
            location === GLOBAL_LOCATION ? 'global' : 'project',
          )}
        >
          <Select
            value={location}
            onValueChange={value => void chooseLocation(value)}
          >
            <SelectTrigger
              id="import-workflow-location"
              size="md"
              className="w-full"
              aria-describedby="import-workflow-location-hint"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map(folder => (
                <SelectItem
                  key={folder}
                  value={`project:${folder}`}
                  title={folder}
                >
                  {savedInLabels.project} · {folderName(folder)}
                </SelectItem>
              ))}
              <SelectItem value={GLOBAL_LOCATION}>
                {savedInLabels.global}
              </SelectItem>
              <SelectSeparator />
              <SelectItem value={PICK_LOCATION}>
                <FolderOpen />
                Choose a folder…
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          id="import-workflow-name"
          label="Workflow name"
          messages={
            validName
              ? []
              : [
                  {
                    severity: 'error',
                    message:
                      'Use lowercase letters, digits and single hyphens.',
                  },
                ]
          }
        >
          <Input
            id="import-workflow-name"
            size="md"
            value={name}
            maxLength={64}
            aria-invalid={!validName}
            onChange={event => setName(event.target.value.trim())}
          />
        </Field>
      </div>
      {result && (
        <p className="font-mono text-2xs break-all text-muted-foreground">
          {result.root}
        </p>
      )}
      {plan?.status === 'checking' && (
        <StatusMessage tone="loading">Checking the location…</StatusMessage>
      )}
      {plan?.status === 'error' && (
        <StatusMessage tone="error">{plan.message}</StatusMessage>
      )}
      {errors.length > 0 && (
        <section aria-label="Import issues" className="space-y-1">
          <InlineNotice tone="error">
            The shared files do not pass validation and cannot be saved.
          </InlineNotice>
          <ul className="space-y-px rounded-surface border p-1">
            {errors.map((issue, index) => (
              <li key={index} className="px-2 py-1 text-xs">
                {issue.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      {result && workflowFile?.state === 'different' && (
        <InlineNotice tone="warning">
          A different workflow named {name} already exists here.
          {result.suggestedName && (
            <>
              {' '}
              <Button
                variant="link"
                size="inline"
                onClick={() => setName(result.suggestedName!)}
              >
                Save it as {result.suggestedName}
              </Button>{' '}
              or overwrite it below.
            </>
          )}
        </InlineNotice>
      )}
      {!!different?.length && (
        <Label className="flex items-center gap-2 text-xs leading-5 font-normal">
          <Checkbox
            checked={overwrite}
            onCheckedChange={value => setOverwrite(value === true)}
            disabled={saving}
          />
          Overwrite{' '}
          {different.map(file => `${file.kind}s/${file.name}.md`).join(', ')}{' '}
          with the shared version
        </Label>
      )}
      {saveError && <StatusMessage tone="error">{saveError}</StatusMessage>}
      <DialogFooter>
        <DialogCancel disabled={saving} onClick={onClose} />
        <Button
          size="lg"
          disabled={!canSave}
          onClick={() => {
            if (different?.length) setConfirming(true);
            else void save();
          }}
        >
          {saving ? 'Saving…' : 'Save workflow'}
        </Button>
      </DialogFooter>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Overwrite existing files?"
        description="The shared version replaces these files. Workflows that use the steps change with them."
        confirmLabel="Overwrite and save"
        pendingLabel="Saving…"
        onConfirm={save}
      >
        <ul className="space-y-0.5 font-mono text-2xs text-muted-foreground">
          {different?.map(file => (
            <li key={file.path} className="break-all">
              {file.path}
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </>
  );
}

export function ImportWorkflowDialog({
  offer,
  folders,
  api,
  onClose,
  onImported,
}: Props) {
  const close = () => {
    if (offer?.status === 'ready') void api.dismissImport(offer.importId);
    onClose();
  };
  return (
    <Dialog
      open={!!offer}
      onOpenChange={open => {
        if (!open) close();
      }}
    >
      <DialogContent
        surface="panel"
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
      >
        {offer?.status === 'refused' && (
          <RefusedLink message={offer.message} onClose={close} />
        )}
        {offer?.status === 'ready' && (
          <ImportReview
            key={offer.importId}
            offer={offer}
            folders={folders}
            api={api}
            onClose={close}
            onImported={onImported}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
