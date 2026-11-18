import { useEffect, useState } from 'react';
import {
  readNotificationsEnabled,
  saveNotificationsEnabled,
} from '@/shared/lib/notification-preference';
import { Button } from '@/shared/ui/button';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage, type StatusTone } from '@/shared/ui/status-message';
import { Switch } from '@/shared/ui/switch';

type TestResult = { tone: StatusTone; message: string } | null;

const backgroundDescription =
  document.documentElement.dataset.platform === 'mac'
    ? 'Closing the window keeps Nesvo running so notifications and the Dock badge keep working. Quit from the Dock or with Command Q.'
    : 'Closing the window keeps Nesvo running in the system tray so notifications and the attention count keep working. Quit from the tray menu.';

const blockedMessage =
  'Notifications are blocked for Nesvo. Allow them in the system notification settings.';

async function notificationPermission() {
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

export function NotificationsSettings() {
  const [enabled, setEnabled] = useState(readNotificationsEnabled);
  const [result, setResult] = useState<TestResult>(null);
  const [background, setBackground] = useState<boolean | null>(null);
  const [backgroundError, setBackgroundError] = useState('');
  useEffect(() => {
    let current = true;
    window.nesvo.keepRunningInBackground().then(
      value => {
        if (current) setBackground(value);
      },
      () => {
        if (current) setBackgroundError('The setting could not be read.');
      },
    );
    return () => {
      current = false;
    };
  }, []);
  const changeBackground = (next: boolean) => {
    setBackground(next);
    setBackgroundError('');
    window.nesvo.setKeepRunningInBackground(next).then(setBackground, () => {
      setBackground(!next);
      setBackgroundError('The setting could not be saved.');
    });
  };
  const change = (next: boolean) => {
    setEnabled(next);
    saveNotificationsEnabled(next);
    setResult(null);
  };
  const sendTest = async () => {
    setResult(null);
    if ((await notificationPermission()) !== 'granted') {
      setResult({ tone: 'warning', message: blockedMessage });
      return;
    }
    const notification = new Notification('Nesvo', {
      body: 'Notifications are working.',
      tag: 'nesvo-test-notification',
    });
    notification.onclick = () => {
      void window.nesvo.focusWindow().catch(() => window.focus());
    };
    setResult({ tone: 'success', message: 'Test notification sent.' });
  };
  return (
    <SettingsSection title="Desktop notifications">
      <SettingsRow
        title={
          <label htmlFor="settings-notifications">Show notifications</label>
        }
        description="Approvals that need you and runs that finish or need attention while Nesvo is in the background."
      >
        <Switch
          id="settings-notifications"
          checked={enabled}
          onCheckedChange={change}
        />
      </SettingsRow>
      <SettingsRow
        title="Test notification"
        description={
          result ? (
            <StatusMessage tone={result.tone}>{result.message}</StatusMessage>
          ) : (
            'Check that notifications reach this desktop.'
          )
        }
      >
        <Button
          variant="outline"
          disabled={!enabled}
          onClick={() => void sendTest()}
        >
          Send test notification
        </Button>
      </SettingsRow>
      <SettingsRow
        title={
          <label htmlFor="settings-background">
            Keep running in the background
          </label>
        }
        description={
          backgroundError ? (
            <StatusMessage tone="error">{backgroundError}</StatusMessage>
          ) : (
            backgroundDescription
          )
        }
      >
        <Switch
          id="settings-background"
          checked={background ?? false}
          disabled={background === null}
          onCheckedChange={changeBackground}
        />
      </SettingsRow>
    </SettingsSection>
  );
}
