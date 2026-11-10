import { useEffect, useState } from 'react';

const REFRESH_CLOCK_MS = 15_000;

export const useUsageClock = () => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    const timer = window.setInterval(update, REFRESH_CLOCK_MS);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return now;
};
