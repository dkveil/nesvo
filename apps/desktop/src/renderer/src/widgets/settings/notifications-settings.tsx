import { useState } from 'react';
import {
  readNotificationsEnabled,
  saveNotificationsEnabled,
} from '@/shared/lib/notification-preference';
import { Button } from '@/shared/ui/button';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage, type StatusTone } from '@/shared/ui/status-message';
import { Switch } from '@/shared/ui/switch';

type TestResult = { tone: StatusTone; message: string } | null;

const blockedMessage =
  'Notifications are blocked for Nesvo. Allow them in the system notification settings.';

async function notificationPermission() {
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

export function NotificationsSettings() {
  const [enabled, setEnabled] = useState(readNotificationsEnabled);
  const [result, setResult] = useState<TestResult>(null);
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
    </SettingsSection>
  );
}
