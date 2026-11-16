const key = 'nesvo.seen';
const maxSeen = 200;

function sanitize(seen: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(seen).slice(-maxSeen));
}

export function readSeen(): Record<string, number> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const seen: Record<string, number> = {};
    for (const [id, revision] of Object.entries(value))
      if (typeof revision === 'number' && Number.isFinite(revision))
        seen[id] = revision;
    return sanitize(seen);
  } catch {
    return {};
  }
}

export function writeSeen(seen: Record<string, number>): void {
  try {
    localStorage.setItem(key, JSON.stringify(sanitize(seen)));
  } catch {
    return;
  }
}
