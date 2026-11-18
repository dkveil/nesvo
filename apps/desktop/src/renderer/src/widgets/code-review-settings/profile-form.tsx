import { useState } from 'react';
import {
  REVIEW_SEVERITY_ORDER,
  claudeModelSchema,
  codeReviewLimits,
  reviewFindingTypeSchema,
  reviewToneSchema,
  type Provider,
  type ReviewerProfile,
  type ReviewFindingType,
  type ReviewSeverity,
  type ReviewTone,
  type SaveReviewerProfileInput,
} from '@nesvo/contracts';
import {
  findingTypeLabels,
  severityLabels,
  toneLabels,
} from '@/features/code-review';
import { modelLabel, providers } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Checkbox } from '@/shared/ui/checkbox';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { StatusMessage } from '@/shared/ui/status-message';
import { Switch } from '@/shared/ui/switch';

type ProfileFormProps = {
  profile: ReviewerProfile | null;
  pending: boolean;
  error: string;
  onSave: (input: SaveReviewerProfileInput) => void;
  onCancel: () => void;
  onDelete?: () => void;
};

const DEFAULT_TYPES: ReviewFindingType[] = [
  'comment',
  'suggestion',
  'question',
];

export function ProfileForm({
  profile,
  pending,
  error,
  onSave,
  onCancel,
  onDelete,
}: ProfileFormProps) {
  const [name, setName] = useState(profile?.name ?? '');
  const [provider, setProvider] = useState<Provider>(
    profile?.provider ?? 'Claude Code',
  );
  const [model, setModel] = useState(profile?.model ?? 'default');
  const [effort, setEffort] = useState(profile?.effort ?? '');
  const [types, setTypes] = useState<ReviewFindingType[]>(
    profile?.findingTypes ?? DEFAULT_TYPES,
  );
  const [severity, setSeverity] = useState<ReviewSeverity>(
    profile?.minimumSeverity ?? 'minor',
  );
  const [maxFindings, setMaxFindings] = useState(
    String(profile?.maxFindings ?? 20),
  );
  const [tone, setTone] = useState<ReviewTone>(profile?.tone ?? 'neutral');
  const [language, setLanguage] = useState(profile?.language ?? 'English');
  const [includeSummary, setIncludeSummary] = useState(
    profile?.includeSummary ?? true,
  );
  const limit = Number(maxFindings);
  const limitValid =
    Number.isInteger(limit) && limit >= 1 && limit <= codeReviewLimits.findings;
  const effortAllowed = provider === 'Codex' && model.trim() !== 'default';
  const valid =
    !!name.trim() &&
    !!model.trim() &&
    !!language.trim() &&
    types.length > 0 &&
    limitValid;
  const changeProvider = (next: Provider) => {
    setProvider(next);
    setModel('default');
    setEffort('');
  };
  const toggleType = (type: ReviewFindingType, checked: boolean) =>
    setTypes(previous =>
      checked
        ? reviewFindingTypeSchema.options.filter(
            option => option === type || previous.includes(option),
          )
        : previous.filter(option => option !== type),
    );
  return (
    <form
      aria-label={profile ? `Edit ${profile.name}` : 'New reviewer profile'}
      className="grid gap-3 p-3"
      onSubmit={event => {
        event.preventDefault();
        if (!valid || pending) return;
        onSave({
          id: profile?.id ?? crypto.randomUUID(),
          expectedRevision: profile?.revision ?? null,
          name: name.trim(),
          provider,
          model: model.trim(),
          effort: effortAllowed && effort.trim() ? effort.trim() : null,
          findingTypes: types,
          minimumSeverity: severity,
          maxFindings: limit,
          tone,
          language: language.trim(),
          includeSummary,
        });
      }}
    >
      <Field id="reviewer-profile-name" label="Name">
        <Input
          id="reviewer-profile-name"
          size="md"
          value={name}
          maxLength={80}
          disabled={pending}
          placeholder="Thorough reviewer"
          onChange={event => setName(event.target.value)}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field id="reviewer-profile-provider" label="Provider">
          <Select
            value={provider}
            onValueChange={value => changeProvider(value as Provider)}
            disabled={pending}
          >
            <SelectTrigger
              id="reviewer-profile-provider"
              size="md"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {providers.map(item => (
                <SelectItem key={item} value={item}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {provider === 'Claude Code' ? (
          <Field id="reviewer-profile-model" label="Model">
            <Select value={model} onValueChange={setModel} disabled={pending}>
              <SelectTrigger
                id="reviewer-profile-model"
                size="md"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {claudeModelSchema.options.map(option => (
                  <SelectItem key={option} value={option}>
                    {modelLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <Field
            id="reviewer-profile-model"
            label="Model"
            hint="A model ID, or default."
          >
            <Input
              id="reviewer-profile-model"
              size="md"
              value={model}
              maxLength={200}
              spellCheck={false}
              disabled={pending}
              onChange={event => setModel(event.target.value)}
            />
          </Field>
        )}
        <Field
          id="reviewer-profile-effort"
          label="Effort"
          hint={
            provider === 'Codex'
              ? 'Optional, for a specific model.'
              : 'Codex only.'
          }
        >
          <Input
            id="reviewer-profile-effort"
            size="md"
            value={effortAllowed ? effort : ''}
            maxLength={32}
            spellCheck={false}
            disabled={pending || !effortAllowed}
            placeholder="Default"
            onChange={event => setEffort(event.target.value.toLowerCase())}
          />
        </Field>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-xs font-medium">Finding types</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {reviewFindingTypeSchema.options.map(type => (
            <Label
              key={type}
              htmlFor={`reviewer-profile-type-${type}`}
              className="text-xs font-normal"
            >
              <Checkbox
                id={`reviewer-profile-type-${type}`}
                checked={types.includes(type)}
                disabled={pending}
                onCheckedChange={checked => toggleType(type, checked === true)}
              />
              {findingTypeLabels[type]}
            </Label>
          ))}
        </div>
        {!types.length && (
          <StatusMessage tone="error">Choose at least one type.</StatusMessage>
        )}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field id="reviewer-profile-severity" label="Minimum severity">
          <Select
            value={severity}
            onValueChange={value => setSeverity(value as ReviewSeverity)}
            disabled={pending}
          >
            <SelectTrigger
              id="reviewer-profile-severity"
              size="md"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {REVIEW_SEVERITY_ORDER.map(option => (
                <SelectItem key={option} value={option}>
                  {severityLabels[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          id="reviewer-profile-limit"
          label="Maximum findings"
          messages={
            limitValid
              ? []
              : [
                  {
                    severity: 'error',
                    message: `Use 1 to ${codeReviewLimits.findings}.`,
                  },
                ]
          }
        >
          <Input
            id="reviewer-profile-limit"
            size="md"
            inputMode="numeric"
            value={maxFindings}
            maxLength={3}
            aria-invalid={!limitValid || undefined}
            disabled={pending}
            onChange={event => setMaxFindings(event.target.value)}
          />
        </Field>
        <Field id="reviewer-profile-tone" label="Tone">
          <Select
            value={tone}
            onValueChange={value => setTone(value as ReviewTone)}
            disabled={pending}
          >
            <SelectTrigger
              id="reviewer-profile-tone"
              size="md"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {reviewToneSchema.options.map(option => (
                <SelectItem key={option} value={option}>
                  {toneLabels[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field
        id="reviewer-profile-language"
        label="Comment language"
        hint="The agent writes findings and the summary in this language."
      >
        <Input
          id="reviewer-profile-language"
          size="md"
          value={language}
          maxLength={40}
          disabled={pending}
          onChange={event => setLanguage(event.target.value)}
        />
      </Field>
      <Field
        id="reviewer-profile-summary"
        label="Add a summary"
        layout="switch"
        hint="An overall summary goes into the review body."
      >
        <Switch
          id="reviewer-profile-summary"
          checked={includeSummary}
          disabled={pending}
          onCheckedChange={setIncludeSummary}
        />
      </Field>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      <div className="flex flex-wrap justify-end gap-2">
        {onDelete && (
          <Button
            type="button"
            variant="ghost"
            size="md"
            className="mr-auto"
            disabled={pending}
            onClick={onDelete}
          >
            Delete profile
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="md"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" size="md" disabled={!valid || pending}>
          {pending ? 'Saving…' : profile ? 'Save profile' : 'Add profile'}
        </Button>
      </div>
    </form>
  );
}
