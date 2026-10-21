const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const RECENT_MS = 45 * SECOND_MS;
const SECONDS_EPOCH_CEILING = 100_000_000_000;

export const epochMillis = (value: number) =>
  value > 0 && value < SECONDS_EPOCH_CEILING ? value * SECOND_MS : value;

const formatSpan = (span: number) => {
  if (span < HOUR_MS) return `${Math.max(1, Math.floor(span / MINUTE_MS))} min`;
  if (span < DAY_MS) return `${Math.floor(span / HOUR_MS)} h`;
  return `${Math.floor(span / DAY_MS)} d`;
};

export const formatAge = (at: number, now: number) => {
  const span = now - epochMillis(at);
  if (span < RECENT_MS) return 'just now';
  return `${formatSpan(span)} ago`;
};

export const formatRemaining = (until: number, now: number) => {
  const span = epochMillis(until) - now;
  if (span <= 0) return 'now';
  if (span < MINUTE_MS) return 'in under a minute';
  return `in ${formatSpan(span)}`;
};
