import { useEffect, useState } from 'react';
import type {
  SharedWorkflowLink,
  WorkflowShareSettings,
  WorkflowSharingApi,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { formatExpiry } from '@/shared/lib/format-expiry';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Input } from '@/shared/ui/input';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  api: Pick<
    WorkflowSharingApi,
    'settings' | 'setOrigin' | 'links' | 'revoke' | 'forget'
  >;
};

const EXPIRY_REFRESH_MS = 60_000;

export function SharingSettings({ api }: Props) {
  const [settings, setSettings] = useState<WorkflowShareSettings | null>(null);
  const [origin, setOrigin] = useState('');
  const [links, setLinks] = useState<SharedWorkflowLink[]>([]);
  const [message, setMessage] = useState<{
    tone: 'error' | 'success';
    text: string;
  } | null>(null);
  const [revoking, setRevoking] = useState<SharedWorkflowLink | null>(null);
  const [revokeError, setRevokeError] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all([api.settings(), api.links()]).then(
      ([current, stored]) => {
        if (!active) return;
        setSettings(current);
        setOrigin(current.origin);
        setLinks(stored);
      },
      failure => {
        if (active)
          setMessage({
            tone: 'error',
            text: `Sharing settings could not be read. ${errorDetail(failure)}`,
          });
      },
    );
    return () => {
      active = false;
    };
  }, [api]);
  const saveOrigin = async (value: string | null) => {
    setMessage(null);
    try {
      const next = await api.setOrigin(value);
      setSettings(next);
      setOrigin(next.origin);
      setMessage({ tone: 'success', text: 'Share site saved.' });
    } catch (failure) {
      setMessage({ tone: 'error', text: errorDetail(failure) });
    }
  };
  const forget = async (link: SharedWorkflowLink) => {
    try {
      setLinks(await api.forget(link.id));
    } catch (failure) {
      setMessage({ tone: 'error', text: errorDetail(failure) });
    }
  };
  const now = useNow(EXPIRY_REFRESH_MS);
  return (
    <div className="space-y-8">
      <SettingsSection title="Share site">
        <SettingsRow
          title="Site address"
          description={
            <div className="space-y-1">
              <p>
                Shared workflows are uploaded to this site and stay available
                for 7 days. Anyone with a link can read the workflow without an
                account. Import links from this site and from{' '}
                {settings?.defaultOrigin ?? 'https://nesvo.dev'} open in Nesvo.
              </p>
              {settings?.overriddenByEnvironment && (
                <p>The app was started with a fixed share site.</p>
              )}
              {message && (
                <StatusMessage tone={message.tone}>
                  {message.text}
                </StatusMessage>
              )}
            </div>
          }
        >
          <form
            className="flex items-center gap-2"
            onSubmit={event => {
              event.preventDefault();
              void saveOrigin(origin.trim());
            }}
          >
            <Input
              aria-label="Share site address"
              size="md"
              className="w-56 disabled:opacity-100"
              value={origin}
              maxLength={2048}
              disabled={!settings || settings.overriddenByEnvironment}
              onChange={event => setOrigin(event.target.value)}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={
                !settings ||
                settings.overriddenByEnvironment ||
                origin.trim() === settings.origin
              }
            >
              Save
            </Button>
            {settings &&
              !settings.overriddenByEnvironment &&
              settings.origin !== settings.defaultOrigin && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void saveOrigin(null)}
                >
                  Use default
                </Button>
              )}
          </form>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Shared links">
        {links.length === 0 ? (
          <SettingsRow
            title="No shared links"
            description="Share a workflow from the Workflows view or the graph editor. Its link appears here until you revoke or remove it."
          />
        ) : (
          links.map(link => {
            const expired = Date.parse(link.expiresAt) <= now;
            return (
              <SettingsRow
                key={link.id}
                title={link.name}
                description={
                  <div className="space-y-0.5">
                    <p className="font-mono text-2xs break-all text-foreground">
                      {link.url}
                    </p>
                    <p>{formatExpiry(link.expiresAt, now)}</p>
                  </div>
                }
              >
                {expired ? (
                  <Button variant="ghost" onClick={() => void forget(link)}>
                    Remove
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setRevokeError('');
                      setRevoking(link);
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </SettingsRow>
            );
          })
        )}
      </SettingsSection>
      <ConfirmDialog
        surface="panel"
        open={!!revoking}
        onOpenChange={open => {
          if (!open) setRevoking(null);
        }}
        title={`Revoke the link to ${revoking?.name ?? 'this workflow'}?`}
        description="The share site deletes the workflow and the link stops working. Workflows already imported stay where they were saved."
        confirmLabel="Revoke link"
        pendingLabel="Revoking…"
        onConfirm={async () => {
          if (!revoking) return;
          try {
            setLinks(await api.revoke(revoking.id));
          } catch (failure) {
            setRevokeError(errorDetail(failure));
            return false;
          }
        }}
      >
        {revokeError && (
          <StatusMessage tone="error">{revokeError}</StatusMessage>
        )}
      </ConfirmDialog>
    </div>
  );
}
