const timeOf = (date: Date) =>
  date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const startOfDay = (time: number) => {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const dayDistance = (from: number, to: number) =>
  Math.round((startOfDay(to) - startOfDay(from)) / 86_400_000);

export const hasReset = (resetsAt: string, now: number) =>
  Date.parse(resetsAt) <= now;

export const resetLabel = (resetsAt: string, now: number) => {
  const reset = new Date(resetsAt);
  const time = timeOf(reset);
  if (hasReset(resetsAt, now)) return `Reset at ${time}`;
  const days = dayDistance(now, reset.getTime());
  if (days === 0) return `Resets at ${time}`;
  if (days === 1) return `Resets tomorrow at ${time}`;
  const date = reset.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year:
      reset.getFullYear() === new Date(now).getFullYear()
        ? undefined
        : 'numeric',
  });
  return `Resets on ${date} at ${time}`;
};

export const availableIn = (resetsAt: string, now: number) => {
  const remaining = Date.parse(resetsAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return '';
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `available in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `available in ${hours}h ${minutes % 60}m`;
  return `available in ${Math.floor(hours / 24)}d ${hours % 24}h`;
};
