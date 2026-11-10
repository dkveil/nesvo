import { useEffect, useRef, useState } from 'react';
import type {
  DesktopApi,
  MobileGatewayStatus,
  MobilePairing,
} from '@nesvo/contracts';
import { Copy, Smartphone } from 'lucide-react';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { Textarea } from '@/shared/ui/textarea';

type Props = {
  api: Pick<
    DesktopApi,
    | 'mobileStatus'
    | 'enableMobile'
    | 'disableMobile'
    | 'pairMobile'
    | 'revokeMobile'
  >;
};

export function MobileAccess({ api }: Props) {
  const [status, setStatus] = useState<MobileGatewayStatus | null>(null);
  const [pairing, setPairing] = useState<MobilePairing | null>(null);
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
      setError(errorDetail(failure));
    } finally {
      busy.current = false;
      setPending('');
    }
  };
  const validPairing =
    pairing && Date.parse(pairing.expiresAt) > now ? pairing : null;
  return (
    <div className="space-y-8">
      {error && (
        <p
          role="alert"
          className="px-3 text-xs leading-5 text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      {!status ? (
        <p className="px-3 text-sm text-muted-foreground">
          {error ? 'Phone access is unavailable.' : 'Loading devices…'}
        </p>
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
                size="xs"
                variant="outline"
                disabled={!!pending}
                onClick={() =>
                  void action('access', async () => {
                    const next = status.enabled
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
                  <p className="text-[13px] font-medium">Pair a phone</p>
                  <Button
                    size="xs"
                    disabled={!!pending}
                    onClick={() =>
                      void action('pair', async () => {
                        setPairing(await api.pairMobile());
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
                      aria-label="Pairing link"
                      value={validPairing.link}
                      readOnly
                      className="min-h-24 font-mono text-xs break-all"
                      onFocus={event => event.currentTarget.select()}
                    />
                    <Button
                      variant="outline"
                      size="xs"
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
          <SettingsSection title="Paired devices">
            {status.devices.length === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                No paired devices yet.
              </p>
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
                    size="xs"
                    className="text-muted-foreground hover:text-foreground"
                    disabled={!!pending}
                    aria-label={`Revoke ${device.name}`}
                    onClick={() =>
                      void action(device.id, async () => {
                        setStatus(await api.revokeMobile(device.id));
                      })
                    }
                  >
                    Revoke
                  </Button>
                </SettingsRow>
              ))
            )}
          </SettingsSection>
        </>
      )}
    </div>
  );
}
