const uiLocale = 'en';
const dateFormat = new Intl.DateTimeFormat(uiLocale, { dateStyle: 'medium' });
const calendarDateFormat = new Intl.DateTimeFormat(uiLocale, {
  dateStyle: 'medium',
  timeZone: 'UTC',
});
const dateTimeFormat = new Intl.DateTimeFormat(uiLocale, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatDate(isoDate: string) {
  const time = Date.parse(isoDate);
  if (!Number.isFinite(time)) return '';
  const formatter = isoDate.length === 10 ? calendarDateFormat : dateFormat;
  return formatter.format(time);
}

export function formatDateTime(isoDate: string) {
  const time = Date.parse(isoDate);
  return Number.isFinite(time) ? dateTimeFormat.format(time) : '';
}
