import { useState } from 'react';
import {
  REVIEW_LANGUAGE_SCOPE_PATTERN,
  codeReviewLimits,
  type CodeReviewSettings,
  type DesktopApi,
  type ReviewConventionLayer,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
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
import { Input } from '@/shared/ui/input';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { StatusMessage } from '@/shared/ui/status-message';
import { Textarea } from '@/shared/ui/textarea';
import { layerLabels } from './labels';

type SaveRuleDialogProps = {
  api: Pick<DesktopApi, 'saveReviewConvention'>;
  repository: string;
  path: string;
  initialText: string;
  onSaved: (settings: CodeReviewSettings) => void;
  onClose: () => void;
};

const LAYERS: ReviewConventionLayer[] = ['global', 'language', 'project'];

const extensionOf = (path: string) =>
  /\.([A-Za-z0-9+#_-]{1,20})$/.exec(path)?.[1]?.toLowerCase() ?? '';

export function SaveRuleDialog({
  api,
  repository,
  path,
  initialText,
  onSaved,
  onClose,
}: SaveRuleDialogProps) {
  const extension = extensionOf(path);
  const [layer, setLayer] = useState<ReviewConventionLayer>(
    extension ? 'language' : 'project',
  );
  const [scope, setScope] = useState(extension);
  const [text, setText] = useState(initialText);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const resolvedScope =
    layer === 'global' ? '' : layer === 'project' ? repository : scope.trim();
  const scopeValid =
    layer !== 'language' || REVIEW_LANGUAGE_SCOPE_PATTERN.test(resolvedScope);
  const save = async () => {
    if (pending || !text.trim() || !scopeValid) return;
    setPending(true);
    setError('');
    try {
      onSaved(
        await api.saveReviewConvention({
          id: crypto.randomUUID(),
          layer,
          scope: resolvedScope,
          text: text.trim(),
        }),
      );
      onClose();
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent showCloseButton={!pending} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save as review rule</DialogTitle>
          <DialogDescription>
            Later reviews include this convention for the chosen scope.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <SegmentedControl
            label="Rule scope"
            value={layer}
            fullWidth
            options={LAYERS.map(value => ({
              value,
              label: layerLabels[value],
            }))}
            onChange={setLayer}
            disabled={pending}
          />
          {layer === 'language' && (
            <Field
              id="save-rule-extension"
              label="File extension"
              messages={
                scopeValid
                  ? []
                  : [
                      {
                        severity: 'error',
                        message: 'Use a file extension such as ts or py.',
                      },
                    ]
              }
            >
              <Input
                id="save-rule-extension"
                size="md"
                value={scope}
                maxLength={20}
                spellCheck={false}
                aria-invalid={!scopeValid || undefined}
                disabled={pending}
                onChange={event => setScope(event.target.value.toLowerCase())}
              />
            </Field>
          )}
          {layer === 'project' && (
            <p className="text-xs text-muted-foreground">
              Applies to reviews of{' '}
              <span className="font-mono text-foreground">{repository}</span>.
            </p>
          )}
          <Field id="save-rule-text" label="Convention">
            <Textarea
              id="save-rule-text"
              value={text}
              rows={4}
              maxLength={codeReviewLimits.conventionText}
              disabled={pending}
              onChange={event => setText(event.target.value)}
            />
          </Field>
          {error && <StatusMessage tone="error">{error}</StatusMessage>}
        </div>
        <DialogFooter>
          <DialogCancel disabled={pending} onClick={onClose} />
          <Button
            size="lg"
            disabled={pending || !text.trim() || !scopeValid}
            aria-busy={pending || undefined}
            onClick={() => void save()}
          >
            {pending ? 'Saving…' : 'Save rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
