import { useEffect, useEffectEvent, useState } from 'react';
import { errorDetail } from '@/entities/session';

type Settled<T> = { key: string; data: T | null; error: string };

export type Resource<T> = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: T | null;
  error: string;
};

export function useResource<T>(
  load: () => Promise<T>,
  key: string,
  enabled: boolean,
): Resource<T> {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [last, setLast] = useState<T | null>(null);
  const fetch = useEffectEvent(load);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void fetch().then(
      data => {
        if (!current) return;
        setSettled({ key, data, error: '' });
        setLast(data);
      },
      failure => {
        if (current)
          setSettled({ key, data: null, error: errorDetail(failure) });
      },
    );
    return () => {
      current = false;
    };
  }, [key, enabled]);
  if (!enabled) return { status: 'idle', data: last, error: '' };
  if (settled?.key !== key) return { status: 'loading', data: last, error: '' };
  return settled.data
    ? { status: 'ready', data: settled.data, error: '' }
    : { status: 'error', data: last, error: settled.error };
}
