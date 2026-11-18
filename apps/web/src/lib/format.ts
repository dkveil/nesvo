const BYTES_PER_MEGABYTE = 1024 * 1024;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export const formatMegabytes = (bytes: number | null): string | null =>
  bytes == null ? null : `${(bytes / BYTES_PER_MEGABYTE).toFixed(1)} MB`;

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeZone: 'UTC',
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

export const formatDate = (value: string | number | null): string | null => {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dateFormatter.format(date);
};

export const formatDateTimeUtc = (value: number): string =>
  `${dateTimeFormatter.format(new Date(value))} UTC`;

export const formatTimeLeft = (expiresAt: number, now: number): string => {
  const left = expiresAt - now;
  if (left <= MS_PER_HOUR) return 'in less than an hour';
  if (left < MS_PER_DAY) {
    const hours = Math.floor(left / MS_PER_HOUR);
    return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  const days = Math.floor(left / MS_PER_DAY);
  return `in ${days} ${days === 1 ? 'day' : 'days'}`;
};
