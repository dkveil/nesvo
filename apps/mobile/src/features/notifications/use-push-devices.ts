import { useCallback, useEffect, useRef, useState } from 'react';

import { useWorkspace } from '@entities/workspace';

import type { PushDevice } from '@shared/api/host';

type DeviceList = { devices: PushDevice[]; receivedAt: number } | null;

export const usePushDevices = () => {
  const { client, connected, hostCapabilities, mode } = useWorkspace();
  const supported = mode === 'live' && hostCapabilities?.pushDevices === true;
  const hostId = hostCapabilities?.hostId ?? '';
  const [list, setList] = useState<DeviceList>(null);
  const [failed, setFailed] = useState(false);
  const pending = useRef<string | null>(null);
  const lastHost = useRef(hostId);

  const refresh = useCallback(() => {
    pending.current = client.requestPushDevices(client.requestId());
  }, [client]);

  useEffect(
    () =>
      client.subscribe(event => {
        if (event.type === 'pushDevices' && event.requestId === pending.current) {
          pending.current = null;
          setFailed(false);
          setList({ devices: event.devices, receivedAt: Date.now() });
        } else if (event.type === 'error' && event.requestId === pending.current) {
          pending.current = null;
          setFailed(true);
        } else if (event.type === 'pushRegistered') {
          refresh();
        } else if (event.type === 'capabilities' && (event.hostId ?? '') !== lastHost.current) {
          lastHost.current = event.hostId ?? '';
          pending.current = null;
          setList(null);
        } else if (event.type === 'disconnected') {
          pending.current = null;
        }
      }),
    [client, refresh],
  );

  useEffect(() => {
    if (!supported || !connected) return;
    const timer = setTimeout(refresh, 0);
    return () => clearTimeout(timer);
  }, [supported, connected, hostId, refresh]);

  return {
    supported,
    connected,
    devices: supported ? (list?.devices ?? null) : null,
    receivedAt: supported ? (list?.receivedAt ?? null) : null,
    failed,
  };
};
