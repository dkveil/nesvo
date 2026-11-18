import { useCallback, useEffect, useState } from 'react';
import type {
  DecideLessonInput,
  DesktopApi,
  LessonOverview,
  LessonSettings,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';

const PROPOSAL_POLL_MS = 2000;

export type LessonApi = Pick<
  DesktopApi,
  'readLessons' | 'saveLessonSettings' | 'proposeLessons' | 'decideLesson'
>;

type UseLessonOverviewParams = {
  api: LessonApi;
  hostId: string;
  enabled: boolean;
};

export type UseLessonOverviewResult = {
  overview: LessonOverview | null;
  error: string;
  pending: string | null;
  refresh: () => void;
  saveSettings: (settings: LessonSettings) => Promise<void>;
  propose: () => Promise<void>;
  decide: (input: DecideLessonInput) => Promise<boolean>;
};

export const useLessonOverview = ({
  api,
  hostId,
  enabled,
}: UseLessonOverviewParams): UseLessonOverviewResult => {
  const [overview, setOverview] = useState<LessonOverview | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration(value => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    api.readLessons(hostId).then(
      loaded => {
        if (!current) return;
        setOverview(loaded);
        setError('');
      },
      failure => {
        if (current) setError(errorDetail(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [api, hostId, enabled, generation]);
  const running = overview?.proposal.status === 'running';
  useEffect(() => {
    if (!running || !enabled) return;
    const timer = setTimeout(refresh, PROPOSAL_POLL_MS);
    return () => clearTimeout(timer);
  }, [running, enabled, overview, refresh]);
  const run = async (key: string, action: () => Promise<LessonOverview>) => {
    setPending(key);
    setError('');
    try {
      setOverview(await action());
      return true;
    } catch (failure) {
      setError(errorDetail(failure));
      return false;
    } finally {
      setPending(null);
    }
  };
  return {
    overview,
    error,
    pending,
    refresh,
    saveSettings: async settings => {
      await run('settings', () => api.saveLessonSettings(settings, hostId));
    },
    propose: async () => {
      await run('propose', () =>
        api.proposeLessons({ requestId: crypto.randomUUID() }, hostId),
      );
    },
    decide: input =>
      run(`${input.key}:${input.decision}`, () =>
        api.decideLesson(input, hostId),
      ),
  };
};
