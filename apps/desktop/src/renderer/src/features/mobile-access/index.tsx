import { useEffect, useRef, useState } from 'react';
import type {
  DesktopApi,
  MobileGatewayStatus,
  MobilePairing,
} from '@nesvo/contracts';
import { Copy, Smartphone } from 'lucide-react';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
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
  onOpenChange: (open: boolean) => void;
};

export function MobileAccess({ api, onOpenChange }: Props) {
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
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Phone access</DialogTitle>
          <DialogDescription>
            Continue your sessions from Nesvo on your phone.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!status ? (
          <p className="py-5 text-sm text-muted-foreground">
            {error ? 'Phone access is unavailable.' : 'Loading devices…'}
          </p>
        ) : (
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  {status.enabled
                    ? 'Phone access is on'
                    : 'Phone access is off'}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {status.enabled
                    ? 'Keep Nesvo open while using this connection.'
                    : 'Enable access before pairing a device.'}
                </p>
              </div>
              <Button
                size="sm"
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
            </div>
            {status.enabled && (
              <div className="space-y-3 border-y py-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">Pair a phone</p>
                  <Button
                    size="sm"
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
                      className="min-h-24 break-all text-xs"
                      onFocus={event => event.currentTarget.select()}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void action('copy', async () => {
                          await navigator.clipboard.writeText(
                            validPairing.link,
                          );
                          setCopied(true);
                        })
                      }
                    >
                      <Copy className="size-3.5" />
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
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Paired devices
              </p>
              {status.devices.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground">
                  No paired devices yet.
                </p>
              ) : (
                <ul className="divide-y">
                  {status.devices.map(device => (
                    <li
                      key={device.id}
                      className="flex items-center gap-3 py-3"
                    >
                      <Smartphone className="size-4 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{device.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {device.lastSeenAt
                            ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                            : 'Paired, waiting for connection'}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
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
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
