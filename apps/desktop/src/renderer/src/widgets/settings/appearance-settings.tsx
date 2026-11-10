import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  colorSchemes,
  type ColorScheme,
  type DesktopApi,
} from '@nesvo/contracts';
import { cn } from 'cn';
import { errorDetail } from '@/entities/session';
import { SettingsSection } from '@/shared/ui/settings-section';

type Props = {
  api: Pick<DesktopApi, 'colorScheme' | 'setColorScheme'>;
};

const schemeLabels: Record<ColorScheme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

const schemeDescriptions: Record<ColorScheme, string> = {
  system: 'Follow the system appearance',
  light: 'Always use the light appearance',
  dark: 'Always use the dark appearance',
};

function SchemeMock({ tone }: { tone: 'light' | 'dark' }) {
  return (
    <div
      data-scheme-preview={tone}
      className="flex size-full gap-2 bg-(--preview-canvas) p-2"
    >
      <div className="flex w-1/4 flex-col gap-1.5 rounded-sm bg-(--preview-panel) p-1.5">
        <span className="h-1.5 w-3/4 rounded-full bg-(--preview-line)" />
        <span className="h-1.5 w-full rounded-full bg-(--preview-line)" />
        <span className="h-1.5 w-2/3 rounded-full bg-(--preview-line)" />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 pt-1.5">
        <span className="h-1.5 w-1/2 self-end rounded-full bg-(--preview-line)" />
        <span className="h-1.5 w-3/4 rounded-full bg-(--preview-line)" />
        <span className="h-1.5 w-2/3 rounded-full bg-(--preview-line)" />
        <span className="mt-auto flex h-4 items-center justify-end rounded-sm bg-(--preview-panel) px-1">
          <span className="size-2 rounded-full bg-primary" />
        </span>
      </div>
    </div>
  );
}

function SchemePreview({ scheme }: { scheme: ColorScheme }) {
  if (scheme !== 'system')
    return (
      <div className="h-24 overflow-hidden rounded-md border">
        <SchemeMock tone={scheme} />
      </div>
    );
  return (
    <div className="relative h-24 overflow-hidden rounded-md border">
      <SchemeMock tone="light" />
      <div className="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
        <SchemeMock tone="dark" />
      </div>
    </div>
  );
}

export function AppearanceSettings({ api }: Props) {
  const [scheme, setScheme] = useState<ColorScheme | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const options = useRef<Partial<Record<ColorScheme, HTMLButtonElement>>>({});
  const request = useRef(0);
  const confirmed = useRef<ColorScheme | null>(null);
  useEffect(() => {
    let active = true;
    api
      .colorScheme()
      .then(value => {
        if (!active) return;
        confirmed.current ??= value;
        setScheme(previous => previous ?? value);
      })
      .catch((failure: unknown) => {
        if (active)
          setError(
            `Could not read the color scheme. ${errorDetail(failure)} Choose one to set it.`,
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api]);
  const choose = async (next: ColorScheme) => {
    const attempt = ++request.current;
    setScheme(next);
    setError('');
    try {
      const saved = await api.setColorScheme(next);
      confirmed.current = saved;
      if (attempt === request.current) setScheme(saved);
    } catch (failure) {
      if (attempt !== request.current) return;
      setScheme(confirmed.current);
      setError(`Could not change the color scheme. ${errorDetail(failure)}`);
    }
  };
  const moveFocus = (event: KeyboardEvent, current: ColorScheme) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next =
      colorSchemes[
        (colorSchemes.indexOf(current) + step + colorSchemes.length) %
          colorSchemes.length
      ]!;
    options.current[next]?.focus();
    void choose(next);
  };
  const focusable = scheme ?? 'system';
  return (
    <SettingsSection
      title="Color scheme"
      className="divide-y-0 border-0 bg-transparent"
    >
      <div
        role="radiogroup"
        aria-label="Color scheme"
        aria-busy={loading}
        className="grid grid-cols-3 gap-3"
      >
        {colorSchemes.map(option => (
          <button
            key={option}
            ref={element => {
              if (element) options.current[option] = element;
            }}
            type="button"
            role="radio"
            aria-checked={scheme === option}
            aria-label={schemeLabels[option]}
            title={schemeDescriptions[option]}
            tabIndex={option === focusable ? 0 : -1}
            disabled={loading}

            onClick={() => void choose(option)}
            onKeyDown={event => moveFocus(event, option)}
            className={cn(
              'space-y-2 rounded-lg border bg-card p-1.5 pb-2 text-center text-[13px] text-muted-foreground transition-[border-color,box-shadow,color] duration-150 outline-none',
              'enabled:hover:border-input enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-64',
              'aria-checked:border-primary aria-checked:font-medium aria-checked:text-foreground aria-checked:ring-1 aria-checked:ring-primary',
            )}
          >
            <SchemePreview scheme={option} />
            <span className="block">{schemeLabels[option]}</span>
          </button>
        ))}
      </div>
      {error && (
        <p
          role="alert"
          className="px-3 pt-2 text-xs text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
    </SettingsSection>
  );
}
