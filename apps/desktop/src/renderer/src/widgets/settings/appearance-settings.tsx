import { useEffect, useRef, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { ColorScheme, DesktopApi } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import {
  SegmentedControl,
  type SegmentedOption,
} from '@/shared/ui/segmented-control';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  api: Pick<DesktopApi, 'colorScheme' | 'setColorScheme'>;
};

const schemeDescriptions: Record<ColorScheme, string> = {
  system: 'Follow the system appearance',
  light: 'Always use the light appearance',
  dark: 'Always use the dark appearance',
};

const schemeOptions: SegmentedOption<ColorScheme>[] = [
  { value: 'system', label: 'System', icon: <Monitor /> },
  { value: 'light', label: 'Light', icon: <Sun /> },
  { value: 'dark', label: 'Dark', icon: <Moon /> },
];

export function AppearanceSettings({ api }: Props) {
  const [scheme, setScheme] = useState<ColorScheme | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
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
    const unsubscribe = window.nesvo.subscribe(event => {
      if (
        event.type !== 'configuration-changed' ||
        event.hostId !== 'local' ||
        event.change.target.area !== 'appearance'
      )
        return;
      void window.nesvo.configuration
        .profile({ action: 'read' })
        .then(profile => {
          if (active && profile.colorScheme) {
            confirmed.current = profile.colorScheme;
            setScheme(profile.colorScheme);
          }
        })
        .catch(() => undefined);
    });
    return () => {
      active = false;
      unsubscribe();
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
  return (
    <SettingsSection title="Color scheme">
      <SettingsRow
        title="Theme"
        description={
          <>
            {scheme ? schemeDescriptions[scheme] : 'Choose how Nesvo looks.'}
            {error && <StatusMessage tone="error">{error}</StatusMessage>}
          </>
        }
      >
        <SegmentedControl
          label="Color scheme"
          size="md"
          value={scheme}
          options={schemeOptions}
          disabled={loading}
          onChange={next => void choose(next)}
        />
      </SettingsRow>
    </SettingsSection>
  );
}
