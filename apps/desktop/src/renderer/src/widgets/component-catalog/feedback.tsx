import { CalendarClock, Plus } from 'lucide-react';
import { Badge, CountBadge, type BadgeTone } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { EmptyState } from '@/shared/ui/empty-state';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { Kbd, KeyCombo } from '@/shared/ui/kbd';
import { Meter, Progress } from '@/shared/ui/progress';
import { Spinner } from '@/shared/ui/spinner';
import { StatusDot, type StatusDotTone } from '@/shared/ui/status-dot';
import { StatusMessage } from '@/shared/ui/status-message';
import {
  CatalogSection,
  Specimen,
  SpecimenRow,
  StateCaption,
} from './specimen';

const BADGE_TONES: BadgeTone[] = [
  'neutral',
  'info',
  'success',
  'warning',
  'error',
  'accent',
];

const DOT_TONES: StatusDotTone[] = [
  'neutral',
  'info',
  'success',
  'warning',
  'error',
  'accent',
  'strong',
];

export function FeedbackSection() {
  return (
    <CatalogSection
      id="feedback"
      title="Status and feedback"
      description="Status colour comes from the success, info, warning and error foreground tokens. Destructive is reserved for actions that delete or discard."
    >
      <Specimen title="Badge and CountBadge" source="shared/ui/badge.tsx">
        <SpecimenRow label="soft · sm">
          {BADGE_TONES.map(tone => (
            <Badge key={tone} tone={tone}>
              {tone}
            </Badge>
          ))}
        </SpecimenRow>
        <SpecimenRow label="outline · sm">
          {BADGE_TONES.map(tone => (
            <Badge key={tone} tone={tone} appearance="outline">
              {tone}
            </Badge>
          ))}
        </SpecimenRow>
        <SpecimenRow label="xs">
          <Badge size="xs">Plan first</Badge>
          <Badge size="xs" tone="info" appearance="outline">
            Project
          </Badge>
          <Badge size="xs" tone="warning">
            Stale
          </Badge>
        </SpecimenRow>
        <SpecimenRow label="count">
          <CountBadge count={3} />
          <CountBadge count={128} />
          <CountBadge count={7} tone="muted" />
        </SpecimenRow>
      </Specimen>
      <div className="grid gap-3 lg:grid-cols-2">
        <Specimen title="StatusDot" source="shared/ui/status-dot.tsx">
          <SpecimenRow label="sm · md">
            {DOT_TONES.map(tone => (
              <StateCaption key={tone} label={tone}>
                <span className="flex items-center gap-1.5">
                  <StatusDot tone={tone} />
                  <StatusDot tone={tone} size="md" />
                </span>
              </StateCaption>
            ))}
          </SpecimenRow>
          <SpecimenRow label="pulse · ring">
            <StatusDot tone="info" pulse label="Working" />
            <span className="relative inline-flex size-6 items-center justify-center rounded-full bg-highlight">
              <StatusDot
                tone="warning"
                ringClassName="border-background"
                className="absolute -right-0.5 -bottom-0.5"
              />
            </span>
          </SpecimenRow>
        </Specimen>
        <Specimen title="Kbd and Spinner" source="kbd.tsx · spinner.tsx">
          <SpecimenRow label="kbd">
            <Kbd>/</Kbd>
            <KeyCombo keys="Ctrl K" />
            <KeyCombo keys="Shift Tab" size="md" />
            <span className="inline-flex h-6 items-center gap-2 rounded-control bg-tooltip px-2 text-2xs text-tooltip-foreground">
              Tooltip tone
              <KeyCombo keys="Ctrl B" tone="tooltip" />
            </span>
          </SpecimenRow>
          <SpecimenRow label="spinner">
            <Spinner />
            <Spinner size="md" />
            <Spinner label="Loading sample" className="text-info-foreground" />
          </SpecimenRow>
        </Specimen>
      </div>
      <Specimen title="Meter and Progress" source="shared/ui/progress.tsx">
        <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
          <StateCaption label="meter · success (sample 72%)">
            <Meter
              label="Sample allowance"
              value={72}
              tone="success"
              className="w-56"
            />
          </StateCaption>
          <StateCaption label="meter · warning (sample 31%)">
            <Meter
              label="Sample allowance"
              value={31}
              tone="warning"
              className="w-56"
            />
          </StateCaption>
          <StateCaption label="meter · error (sample 8%)">
            <Meter
              label="Sample allowance"
              value={8}
              tone="error"
              className="w-56"
            />
          </StateCaption>
          <StateCaption label="meter · stale">
            <Meter
              label="Sample allowance"
              value={64}
              tone="success"
              stale
              className="w-56"
            />
          </StateCaption>
          <StateCaption label="meter · unavailable">
            <Meter label="Sample allowance" value={null} className="w-56" />
          </StateCaption>
          <StateCaption label="progress · neutral 40%">
            <Progress label="Sample upload" value={40} className="w-56" />
          </StateCaption>
          <StateCaption label="progress · indeterminate">
            <Progress
              label="Sample check"
              value={null}
              tone="info"
              indeterminate
              className="w-56"
            />
          </StateCaption>
        </div>
      </Specimen>
      <Specimen
        title="StatusMessage and InlineNotice"
        source="status-message.tsx · inline-notice.tsx"
      >
        <div className="grid gap-x-8 gap-y-2 md:grid-cols-2">
          <div className="space-y-1.5">
            <StatusMessage tone="loading">
              Loading sample branches…
            </StatusMessage>
            <StatusMessage tone="info">
              Applies from the next turn.
            </StatusMessage>
            <StatusMessage tone="success">Saved sample workflow.</StatusMessage>
            <StatusMessage tone="warning">
              The sample computer runs an older host.
            </StatusMessage>
            <StatusMessage tone="error">
              Could not reach the sample computer.
            </StatusMessage>
          </div>
          <div className="space-y-2">
            <InlineNotice>
              Sample note: this folder has no workflows yet.
            </InlineNotice>
            <InlineNotice tone="warning">
              Sample warning: the saved diff is older than the branch.
            </InlineNotice>
            <InlineNotice tone="error">
              Sample error: the pull request could not be loaded.
            </InlineNotice>
          </div>
        </div>
      </Specimen>
      <Specimen title="EmptyState" source="shared/ui/empty-state.tsx">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-control border">
            <EmptyState
              size="md"
              icon={CalendarClock}
              title="No sample automations yet"
              description="Run a read-only prompt on a schedule. Results arrive in the Inbox for acceptance."
              action={
                <Button variant="secondary">
                  <Plus />
                  New automation
                </Button>
              }
              className="min-h-64"
            />
          </div>
          <div className="rounded-control border">
            <EmptyState
              size="sm"
              title="No matches"
              description="Try a shorter sample query."
            />
          </div>
        </div>
      </Specimen>
    </CatalogSection>
  );
}
