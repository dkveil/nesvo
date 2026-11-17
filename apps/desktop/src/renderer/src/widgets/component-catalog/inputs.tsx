import { useState } from 'react';
import { GitBranch, List, Rows3 } from 'lucide-react';
import { Checkbox } from '@/shared/ui/checkbox';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { SearchField } from '@/shared/ui/search-field';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { Switch } from '@/shared/ui/switch';
import { Textarea } from '@/shared/ui/textarea';
import {
  CatalogSection,
  Specimen,
  SpecimenRow,
  StateCaption,
} from './specimen';

const SIZES = ['sm', 'md', 'lg'] as const;

function SearchFields() {
  const [query, setQuery] = useState('sample');
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <StateCaption label="panel · with clear">
        <div className="w-64">
          <SearchField
            aria-label="Search files"
            placeholder="Search files"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onClear={() => setQuery('')}
          />
        </div>
      </StateCaption>
      <StateCaption label="panel · shortcut">
        <div className="w-64">
          <SearchField
            aria-label="Search settings"
            placeholder="Search"
            shortcut="/"
          />
        </div>
      </StateCaption>
      <StateCaption label="sidebar">
        <div className="w-64 rounded-control bg-sidebar p-1">
          <SearchField
            variant="sidebar"
            aria-label="Search sessions"
            placeholder="Search sessions"
            shortcut="Ctrl K"
          />
        </div>
      </StateCaption>
      <StateCaption label="underline">
        <div className="w-64 rounded-control border bg-popover">
          <SearchField
            variant="underline"
            aria-label="Filter options"
            placeholder="Filter options"
          />
        </div>
      </StateCaption>
      <StateCaption label="palette">
        <div className="w-96 rounded-surface border bg-popover">
          <SearchField
            variant="palette"
            aria-label="Search history"
            placeholder="Search all sessions"
          />
        </div>
      </StateCaption>
    </div>
  );
}

function Selections() {
  const [view, setView] = useState<'list' | 'tree'>('list');
  const [repeat, setRepeat] = useState<'interval' | 'daily' | 'weekly'>(
    'daily',
  );
  const [days, setDays] = useState<string[]>(['mon', 'wed']);
  const [phase, setPhase] = useState<'plan' | 'done' | 'push'>('plan');
  const [checked, setChecked] = useState<boolean | 'indeterminate'>(true);
  const [enabled, setEnabled] = useState(true);
  return (
    <>
      <Specimen
        title="SegmentedControl"
        source="shared/ui/segmented-control.tsx"
      >
        <SpecimenRow label="sm · single">
          <SegmentedControl
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: 'list', label: 'List', icon: <List /> },
              { value: 'tree', label: 'Tree', icon: <Rows3 /> },
            ]}
          />
          <SegmentedControl
            label="View (icons)"
            iconOnly
            value={view}
            onChange={setView}
            options={[
              { value: 'list', label: 'List', icon: <List /> },
              { value: 'tree', label: 'Tree', icon: <Rows3 /> },
            ]}
          />
        </SpecimenRow>
        <SpecimenRow label="md · counts">
          <SegmentedControl
            label="Repeat"
            size="md"
            value={repeat}
            onChange={setRepeat}
            options={[
              { value: 'interval', label: 'Interval' },
              { value: 'daily', label: 'Daily', count: 3 },
              { value: 'weekly', label: 'Weekly', count: 1 },
            ]}
          />
        </SpecimenRow>
        <SpecimenRow label="multiple">
          <SegmentedControl
            label="Days"
            mode="multiple"
            value={days}
            onChange={setDays}
            options={['mon', 'tue', 'wed', 'thu', 'fri'].map(day => ({
              value: day,
              label: day.charAt(0).toUpperCase() + day.slice(1),
            }))}
          />
        </SpecimenRow>
        <SpecimenRow label="full width · invalid">
          <div className="w-80">
            <SegmentedControl
              label="Phase"
              fullWidth
              invalid
              value={phase}
              onChange={setPhase}
              options={[
                { value: 'plan', label: 'Plan' },
                { value: 'done', label: 'Before done' },
                { value: 'push', label: 'Before push', disabled: true },
              ]}
            />
          </div>
        </SpecimenRow>
        <SpecimenRow label="disabled">
          <SegmentedControl
            label="View (disabled)"
            disabled
            value={view}
            onChange={setView}
            options={[
              { value: 'list', label: 'List' },
              { value: 'tree', label: 'Tree' },
            ]}
          />
        </SpecimenRow>
      </Specimen>
      <Specimen title="Checkbox and Switch" source="checkbox.tsx · switch.tsx">
        <SpecimenRow label="checkbox" className="gap-5">
          <Label className="gap-2 text-ui font-normal">
            <Checkbox checked={checked} onCheckedChange={setChecked} />
            Viewed
          </Label>
          <Label className="gap-2 text-ui font-normal">
            <Checkbox checked="indeterminate" />
            Some files
          </Label>
          <Label className="gap-2 text-ui font-normal">
            <Checkbox />
            Unchecked
          </Label>
          <Label className="gap-2 text-ui font-normal">
            <Checkbox data-preview-focus="" />
            Focus
          </Label>
          <Label className="gap-2 text-ui font-normal">
            <Checkbox disabled checked />
            Disabled
          </Label>
        </SpecimenRow>
        <SpecimenRow label="switch" className="gap-5">
          <Label className="gap-2 text-ui font-normal">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            Use my hooks
          </Label>
          <Label className="gap-2 text-ui font-normal">
            <Switch data-preview-focus="" />
            Focus
          </Label>
          <Label className="gap-2 text-ui font-normal">
            <Switch disabled />
            Disabled
          </Label>
        </SpecimenRow>
      </Specimen>
    </>
  );
}

export function InputsSection() {
  return (
    <CatalogSection
      id="inputs"
      title="Inputs"
      description="Text entry, search, choice and toggles. Every control shares the size scale and the inset focus ring."
    >
      <Specimen title="Input" source="shared/ui/input.tsx">
        {SIZES.map(size => (
          <SpecimenRow key={size} label={size}>
            <Input
              size={size}
              aria-label={`Sample ${size} input`}
              placeholder="Session name"
              className="w-56"
            />
          </SpecimenRow>
        ))}
        <SpecimenRow label="states" className="items-start gap-4">
          <StateCaption label="focus">
            <Input
              aria-label="Focused input"
              defaultValue="sample-branch"
              data-preview-focus=""
              className="w-44"
            />
          </StateCaption>
          <StateCaption label="invalid">
            <Input
              aria-label="Invalid input"
              defaultValue="bad name!"
              aria-invalid
              className="w-44"
            />
          </StateCaption>
          <StateCaption label="disabled">
            <Input
              aria-label="Disabled input"
              defaultValue="read only"
              disabled
              className="w-44"
            />
          </StateCaption>
          <StateCaption label="ghost (inline title)">
            <Input
              variant="ghost"
              aria-label="Inline title"
              defaultValue="Sample session"
              className="w-44 font-medium"
            />
          </StateCaption>
        </SpecimenRow>
      </Specimen>
      <Specimen title="Textarea" source="shared/ui/textarea.tsx">
        <div className="grid gap-3 md:grid-cols-2">
          <Textarea
            aria-label="Sample textarea"
            placeholder="Describe the check this step runs"
          />
          <Textarea
            aria-label="Invalid textarea"
            aria-invalid
            defaultValue="This sample text is too long for the field."
          />
        </div>
      </Specimen>
      <Specimen title="SearchField" source="shared/ui/search-field.tsx">
        <SearchFields />
      </Specimen>
      <Specimen title="Select" source="shared/ui/select.tsx">
        <SpecimenRow label="sm · md · ghost">
          {(['sm', 'md'] as const).map(size => (
            <Select key={size} defaultValue="main">
              <SelectTrigger size={size} aria-label={`Branch ${size}`}>
                <GitBranch />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="main">main</SelectItem>
                <SelectItem value="feature">sample/feature</SelectItem>
                <SelectItem value="fix" disabled>
                  sample/fix (locked)
                </SelectItem>
              </SelectContent>
            </Select>
          ))}
          <Select defaultValue="week">
            <SelectTrigger variant="ghost" aria-label="Period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">Today</SelectItem>
              <SelectItem value="week">This week</SelectItem>
              <SelectItem value="month">This month</SelectItem>
            </SelectContent>
          </Select>
          <Select>
            <SelectTrigger aria-label="Disabled select" disabled>
              <SelectValue placeholder="Disabled" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
            </SelectContent>
          </Select>
        </SpecimenRow>
      </Specimen>
      <Selections />
      <Specimen title="Field" source="shared/ui/field.tsx">
        <div className="grid gap-4 md:grid-cols-2">
          <Field
            id="catalog-field-name"
            label="Step name"
            hint="Shown on the canvas and in run history."
          >
            <Input id="catalog-field-name" defaultValue="Lint" />
          </Field>
          <Field
            id="catalog-field-command"
            label="Command"
            messages={[
              { severity: 'error', message: 'Enter a command to run.' },
              {
                severity: 'warning',
                message: 'Used by 2 other sample workflows.',
              },
            ]}
          >
            <Input
              id="catalog-field-command"
              aria-invalid
              aria-describedby="catalog-field-command-messages"
            />
          </Field>
          <Field
            id="catalog-field-inline"
            label="Inline layout"
            layout="inline"
            className="md:col-span-2"
          >
            <Input id="catalog-field-inline" defaultValue="sample value" />
          </Field>
        </div>
      </Specimen>
    </CatalogSection>
  );
}
