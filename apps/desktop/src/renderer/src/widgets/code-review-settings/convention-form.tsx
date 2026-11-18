import { useState } from 'react';
import {
  GITHUB_REPOSITORY_PATTERN,
  REVIEW_LANGUAGE_SCOPE_PATTERN,
  codeReviewLimits,
  type ReviewConvention,
  type ReviewConventionLayer,
  type SaveReviewConventionInput,
} from '@nesvo/contracts';
import { layerLabels } from '@/features/code-review';
import { Button } from '@/shared/ui/button';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { StatusMessage } from '@/shared/ui/status-message';
import { Textarea } from '@/shared/ui/textarea';

type ConventionFormProps = {
  convention: ReviewConvention | null;
  pending: boolean;
  error: string;
  onSave: (input: SaveReviewConventionInput) => void;
  onCancel: () => void;
};

const LAYERS: ReviewConventionLayer[] = ['global', 'language', 'project'];

const isAbsolutePath = (value: string) =>
  value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);

const scopeError = (layer: ReviewConventionLayer, scope: string) => {
  if (layer === 'language' && !REVIEW_LANGUAGE_SCOPE_PATTERN.test(scope))
    return 'Use a file extension such as ts or py.';
  if (
    layer === 'project' &&
    !GITHUB_REPOSITORY_PATTERN.test(scope) &&
    !isAbsolutePath(scope)
  )
    return 'Use owner/name or an absolute project folder.';
  return '';
};

export function ConventionForm({
  convention,
  pending,
  error,
  onSave,
  onCancel,
}: ConventionFormProps) {
  const [layer, setLayer] = useState<ReviewConventionLayer>(
    convention?.layer ?? 'global',
  );
  const [scope, setScope] = useState(convention?.scope ?? '');
  const [text, setText] = useState(convention?.text ?? '');
  const [touched, setTouched] = useState(false);
  const resolvedScope = layer === 'global' ? '' : scope.trim();
  const invalidScope = scopeError(layer, resolvedScope);
  const valid = !!text.trim() && !invalidScope;
  return (
    <form
      aria-label={convention ? 'Edit convention' : 'New convention'}
      className="grid gap-3 p-3"
      onSubmit={event => {
        event.preventDefault();
        setTouched(true);
        if (!valid || pending) return;
        onSave({
          id: convention?.id ?? crypto.randomUUID(),
          layer,
          scope: resolvedScope,
          text: text.trim(),
        });
      }}
    >
      <SegmentedControl
        label="Convention layer"
        value={layer}
        fullWidth
        options={LAYERS.map(value => ({ value, label: layerLabels[value] }))}
        onChange={setLayer}
        disabled={pending}
      />
      {layer !== 'global' && (
        <Field
          id="review-convention-scope"
          label={layer === 'language' ? 'File extension' : 'Project'}
          hint={
            layer === 'language'
              ? 'Applies when the pull request changes files with this extension.'
              : 'A GitHub repository as owner/name, or a project folder on this computer.'
          }
          messages={
            touched && invalidScope
              ? [{ severity: 'error', message: invalidScope }]
              : []
          }
        >
          <Input
            id="review-convention-scope"
            size="md"
            value={scope}
            maxLength={4096}
            spellCheck={false}
            aria-invalid={(touched && !!invalidScope) || undefined}
            disabled={pending}
            placeholder={layer === 'language' ? 'ts' : 'owner/name'}
            onBlur={() => setTouched(true)}
            onChange={event => setScope(event.target.value)}
          />
        </Field>
      )}
      <Field id="review-convention-text" label="Convention">
        <Textarea
          resize="none"
          id="review-convention-text"
          rows={3}
          value={text}
          maxLength={codeReviewLimits.conventionText}
          disabled={pending}
          placeholder="Flag missing error handling around network calls."
          onChange={event => setText(event.target.value)}
        />
      </Field>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="md"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" size="md" disabled={pending || !text.trim()}>
          {pending
            ? 'Saving…'
            : convention
              ? 'Save convention'
              : 'Add convention'}
        </Button>
      </div>
    </form>
  );
}
