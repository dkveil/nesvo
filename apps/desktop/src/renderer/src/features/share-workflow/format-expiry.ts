const dateFormat = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export const formatExpiry = (expiresAt: string, now = Date.now()) => {
  const time = Date.parse(expiresAt);
  return time <= now
    ? `Expired ${dateFormat.format(time)}`
    : `Expires ${dateFormat.format(time)}`;
};
