import { cn } from '@/shared/lib/cn';
import { CatalogSection, Specimen } from './specimen';

const SURFACES = [
  ['background', 'bg-background'],
  ['card', 'bg-card'],
  ['popover', 'bg-popover'],
  ['accent (hover)', 'bg-accent'],
  ['highlight (selected)', 'bg-highlight'],
  ['segment-track', 'bg-segment-track'],
  ['sidebar-row-hover', 'bg-sidebar-row-hover'],
  ['sidebar-row-selected', 'bg-sidebar-row-selected'],
  ['code-background', 'bg-code-background'],
  ['message-surface', 'bg-message-surface'],
] as const;

const INKS = [
  ['foreground', 'bg-foreground'],
  ['secondary-foreground', 'bg-secondary-foreground'],
  ['muted-foreground', 'bg-muted-foreground'],
  ['border', 'bg-border'],
  ['input', 'bg-input'],
  ['ring', 'bg-ring'],
  ['primary', 'bg-primary'],
  ['destructive (actions only)', 'bg-destructive'],
] as const;

const TONES = [
  ['success-foreground', 'bg-success-foreground'],
  ['info-foreground', 'bg-info-foreground'],
  ['warning-foreground', 'bg-warning-foreground'],
  ['error-foreground', 'bg-error-foreground'],
] as const;

const TYPE_SCALE = [
  ['text-micro', '10 / 14', 'text-micro'],
  ['text-2xs', '11 / 16', 'text-2xs'],
  ['text-xs', '12 / 16', 'text-xs'],
  ['text-ui', '13 / 20 · default UI body', 'text-ui'],
  ['text-sm', '14 / 20', 'text-sm'],
  ['text-title', '15 / 22', 'text-title font-semibold tracking-tight'],
  ['text-base', '16 / 24 · dialog title', 'text-base font-semibold'],
] as const;

const RADII = [
  ['rounded-sm', '4px · checkbox, kbd', 'rounded-sm'],
  ['rounded-control', '6px · controls, menu items, rows', 'rounded-control'],
  ['rounded-surface', '8px · popovers, menus, cards', 'rounded-surface'],
  ['rounded-overlay', '12px · dialogs, comment composer', 'rounded-overlay'],
  ['rounded-composer', '16px · message composer', 'rounded-composer'],
  ['rounded-full', 'round icon buttons, pills', 'rounded-full'],
] as const;

const SIZES = [
  ['xs', '24px', 'h-6'],
  ['sm', '28px · default', 'h-7'],
  ['md', '32px', 'h-8'],
  ['lg', '36px', 'h-9'],
] as const;

const MOTION = [
  ['duration-fast', '100ms · colour'],
  ['duration-base', '150ms · transform, opacity, popovers'],
  ['duration-slow', '200ms · panels, dialogs'],
  ['press', 'scale 0.97 · buttons and chips only'],
] as const;

function Swatches({
  entries,
}: {
  entries: readonly (readonly [string, string])[];
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {entries.map(([name, className]) => (
        <div key={name} className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={cn('size-7 shrink-0 rounded-control border', className)}
          />
          <span className="truncate font-mono text-2xs text-muted-foreground">
            {name}
          </span>
        </div>
      ))}
    </div>
  );
}

export function FoundationsSection() {
  return (
    <CatalogSection
      id="foundations"
      title="Foundations"
      description="Tokens from styles.css. Components reference these names; nothing in shared/ui uses raw colours or arbitrary text sizes."
    >
      <Specimen title="Surfaces and states" source="--background … --highlight">
        <Swatches entries={SURFACES} />
      </Specimen>
      <Specimen title="Ink, lines and brand" source="--foreground … --ring">
        <Swatches entries={INKS} />
      </Specimen>
      <Specimen
        title="Status tones"
        source="text-{tone}-foreground"
        className="space-y-2"
      >
        <Swatches entries={TONES} />
        <p className="flex flex-wrap gap-4 text-xs">
          <span className="text-success-foreground">Checks passing</span>
          <span className="text-info-foreground">Working</span>
          <span className="text-warning-foreground">Needs approval</span>
          <span className="text-error-foreground">Could not connect</span>
        </p>
      </Specimen>
      <div className="grid gap-3 lg:grid-cols-2">
        <Specimen title="Type scale" source="--text-*">
          {TYPE_SCALE.map(([name, metrics, className]) => (
            <div key={name} className="flex items-baseline gap-3">
              <span className="w-20 shrink-0 font-mono text-2xs text-muted-foreground">
                {name}
              </span>
              <span className={cn('min-w-0 truncate', className)}>
                Sample session title
              </span>
              <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
                {metrics}
              </span>
            </div>
          ))}
        </Specimen>
        <Specimen title="Radius" source="--radius-*">
          {RADII.map(([name, usage, className]) => (
            <div key={name} className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  'h-7 w-12 shrink-0 border bg-highlight',
                  className,
                )}
              />
              <span className="font-mono text-2xs">{name}</span>
              <span className="ml-auto text-2xs text-muted-foreground">
                {usage}
              </span>
            </div>
          ))}
        </Specimen>
        <Specimen title="Control heights" source="xs · sm · md · lg">
          <div className="flex items-end gap-3">
            {SIZES.map(([name, value, className]) => (
              <div key={name} className="flex flex-col items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    'w-14 rounded-control border bg-highlight',
                    className,
                  )}
                />
                <span className="text-2xs">{name}</span>
                <span className="text-micro text-muted-foreground">
                  {value}
                </span>
              </div>
            ))}
          </div>
        </Specimen>
        <Specimen title="Motion and focus" source="--duration-* · focus-ring">
          {MOTION.map(([name, usage]) => (
            <div key={name} className="flex items-center gap-3">
              <span className="w-24 shrink-0 font-mono text-2xs">{name}</span>
              <span className="text-2xs text-muted-foreground">{usage}</span>
            </div>
          ))}
          <div className="flex items-center gap-3 pt-1">
            <span
              data-preview-focus=""
              className="focus-ring h-7 w-24 rounded-control bg-accent"
            />
            <span className="text-2xs text-muted-foreground">
              focus-ring · 1.5px inset in --ring, keyboard focus only
            </span>
          </div>
        </Specimen>
      </div>
    </CatalogSection>
  );
}
