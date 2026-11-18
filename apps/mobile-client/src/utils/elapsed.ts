const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

export function formatElapsed(
  startedAt: string,
  finishedAt: string | null,
  now: number,
) {
  const end = finishedAt ? Date.parse(finishedAt) : now;
  const seconds = Math.floor(Math.max(0, end - Date.parse(startedAt)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;
  if (seconds < SECONDS_PER_HOUR)
    return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m ${seconds % SECONDS_PER_MINUTE}s`;
  return `${Math.floor(seconds / SECONDS_PER_HOUR)}h ${Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)}m`;
}
