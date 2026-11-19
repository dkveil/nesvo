import { useEffect, useRef, useState } from 'react';
import type {
  DesktopApi,
  MobileDevice,
  MobileGatewayStatus,
  MobilePairing,
} from '@nesvo/contracts';
import { Copy, Smartphone } from 'lucide-react';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Checkbox } from '@/shared/ui/checkbox';
import {
  isChangedDeviceGrant,
  type SettingsAuthorityReview,
} from '@/features/configuration/authority-review';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { Textarea } from '@/shared/ui/textarea';

type Props = {
  review?: Extract<SettingsAuthorityReview, { kind: 'phone-access' }>;
  api: Pick<
    DesktopApi,
    | 'mobileStatus'
    | 'enableMobile'
    | 'disableMobile'
    | 'pairMobile'
    | 'revokeMobile'
  >;
};

export function MobileAccess({ api, review }: Props) {
  const [activeReview, setActiveReview] = useState(review);
  const [revoked, setRevoked] = useState(false);
  const [reviewedAgain, setReviewedAgain] = useState(false);
  const [status, setStatus] = useState<MobileGatewayStatus | null>(null);
  const [pairing, setPairing] = useState<MobilePairing | null>(null);
  const [revoking, setRevoking] = useState<MobileDevice | null>(null);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now);
  const busy = useRef(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (busy.current) return;
      try {
        const next = await api.mobileStatus();
        if (!active) return;
        setStatus(next);
        setPairing(previous =>
          previous &&
          next.devices.some(
            device =>
              Date.parse(device.createdAt) >=
              Date.parse(previous.expiresAt) - 120_000,
          )
            ? null
            : previous,
        );
      } catch (failure) {
        if (active) setError(errorDetail(failure));
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [api]);
  const action = async (name: string, operation: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(name);
    setError('');
    try {
      await operation();
    } catch (failure) {
      if (isChangedDeviceGrant(failure)) setRevoked(true);
      setError(errorDetail(failure));
    } finally {
      busy.current = false;
      setPending('');
    }
  };
  const validPairing =
    pairing && Date.parse(pairing.expiresAt) > now ? pairing : null;
  const complete = async (action: 'enable' | 'pair') => {
    if (activeReview?.action !== action) return null;
    const { result, recorded } =
      await window.nesvo.configuration.completeReview(
        {
          review: { ...activeReview.review, reviewRevocation: reviewedAgain },
          operation: { kind: 'phone-access', action },
        },
        activeReview.hostId,
      );
    setActiveReview(undefined);
    if (!recorded)
      setError(
        'The action completed. Inspect the unsettled receipt in Change history.',
      );
    return result;
  };
  return (
    <div className="space-y-8">
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {activeReview && (
        <InlineNotice>
          {activeReview.action === 'enable'
            ? 'Review the proposal to enable Phone access.'
            : 'Review the proposal to create a one-time pairing link.'}
          {revoked && (
            <label className="flex items-center gap-2 text-ui">
              <Checkbox
                checked={reviewedAgain}
                onCheckedChange={checked => setReviewedAgain(checked === true)}
              />
              I reviewed the proposal after the device grant changed.
            </label>
          )}
        </InlineNotice>
      )}
      {!status ? (
        error ? (
          <InlineNotice>Phone access is unavailable.</InlineNotice>
        ) : (
          <InlineNotice tone="loading">Loading devices…</InlineNotice>
        )
      ) : (
        <>
          <SettingsSection title="Phone access">
            <SettingsRow
              title={
                status.enabled ? 'Phone access is on' : 'Phone access is off'
              }
              description={
                status.enabled
                  ? 'Keep Nesvo open while using this connection.'
                  : 'Continue your sessions from Nesvo on your phone. Enable access before pairing a device.'
              }
            >
              <Button
                variant="outline"
                disabled={
                  !!pending ||
                  Boolean(
                    activeReview?.action === 'enable' &&
                    (status.enabled || (revoked && !reviewedAgain)),
                  )
                }
                onClick={() =>
                  void action('access', async () => {
                    const result = status.enabled
                      ? null
                      : await complete('enable');
                    const next =
                      result?.kind === 'enable'
                        ? result.value
                        : status.enabled
                          ? await api.disableMobile()
                          : await api.enableMobile();
                    setStatus(next);
                    setPairing(null);
                  })
                }
              >
                {pending === 'access'
                  ? 'Updating…'
                  : status.enabled
                    ? 'Disable'
                    : 'Enable phone access'}
              </Button>
            </SettingsRow>
            {status.enabled && (
              <div className="space-y-3 px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-ui font-medium">Pair a phone</p>
                  <Button
                    disabled={
                      !!pending ||
                      Boolean(
                        activeReview?.action === 'pair' &&
                        revoked &&
                        !reviewedAgain,
                      )
                    }
                    onClick={() =>
                      void action('pair', async () => {
                        const result = await complete('pair');
                        setPairing(
                          result?.kind === 'pair'
                            ? result.value
                            : await api.pairMobile(),
                        );
                        setCopied(false);
                        setNow(Date.now());
                      })
                    }
                  >
                    {pending === 'pair'
                      ? 'Creating…'
                      : pairing
                        ? 'New pairing link'
                        : 'Create pairing link'}
                  </Button>
                </div>
                {validPairing ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Paste this single-use link into Nesvo on your phone. It
                      expires in two minutes.
                    </p>
                    <Textarea
                      size="md"
                      aria-label="Pairing link"
                      value={validPairing.link}
                      readOnly
                      className="min-h-24 font-mono text-xs break-all"
                      onFocus={event => event.currentTarget.select()}
                    />
                    <Button
                      variant="outline"
                      onClick={() =>
                        void action('copy', async () => {
                          await navigator.clipboard.writeText(
                            validPairing.link,
                          );
                          setCopied(true);
                        })
                      }
                    >
                      <Copy />
                      {copied ? 'Copied' : 'Copy link'}
                    </Button>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {pairing
                      ? 'This pairing link expired. Create a new one.'
                      : 'Only pair devices you want to use for your sessions.'}
                  </p>
                )}
                {status.url?.startsWith('http:') && (
                  <p className="text-xs text-muted-foreground">
                    This connection is available locally. Remote phones need a
                    configured HTTPS address.
                  </p>
                )}
              </div>
            )}
          </SettingsSection>
          {(status.enabled || status.devices.length > 0) && (
            <SettingsSection title="Paired devices">
              {status.devices.length === 0 ? (
                <SettingsRow
                  title="No paired devices yet"
                  description="Devices you pair appear here and can be revoked at any time."
                />
              ) : (
                status.devices.map(device => (
                  <SettingsRow
                    key={device.id}
                    title={
                      <span className="flex items-center gap-2">
                        <Smartphone className="size-3.5 text-muted-foreground" />
                        <span className="truncate">{device.name}</span>
                      </span>
                    }
                    description={
                      device.lastSeenAt
                        ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                        : 'Paired, waiting for connection'
                    }
                  >
                    <Button
                      variant="ghost"
                      disabled={!!pending}
                      aria-label={`Revoke ${device.name}`}
                      aria-haspopup="dialog"
                      onClick={() => setRevoking(device)}
                    >
                      Revoke
                    </Button>
                  </SettingsRow>
                ))
              )}
            </SettingsSection>
          )}
        </>
      )}
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={open => {
          if (!open) setRevoking(null);
        }}
        title={`Revoke ${revoking?.name ?? 'device'}?`}
        description="The phone is disconnected and can no longer reach your sessions. Pair it again to restore access."
        confirmLabel="Revoke device"
        pendingLabel="Revoking…"
        onConfirm={() =>
          revoking &&
          action(revoking.id, async () => {
            setStatus(await api.revokeMobile(revoking.id));
          })
        }
      />
    </div>
  );
}
