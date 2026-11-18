const maxBuckets = 128;
const windowMs = 60_000;

export function createMobileRateLimiter() {
  const rates = new Map<string, { expiresAt: number; count: number }>();
  return (key: string, limit: number): boolean => {
    const now = Date.now();
    for (const [id, entry] of rates)
      if (entry.expiresAt <= now) rates.delete(id);

    let state = rates.get(key);
    if (state) {
      rates.delete(key);
    } else {
      if (rates.size >= maxBuckets) {
        const oldest = rates.keys().next();
        if (!oldest.done) rates.delete(oldest.value);
      }
      state = { expiresAt: now + windowMs, count: 0 };
    }
    rates.set(key, state);
    return ++state.count <= limit;
  };
}
