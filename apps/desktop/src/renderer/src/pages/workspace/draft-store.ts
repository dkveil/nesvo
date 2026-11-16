const key = 'nesvo.drafts';
const maxDraftLength = 32_000;
const maxDrafts = 50;

function sanitize(drafts: Record<string, string>): Record<string, string> {
  const entries = Object.entries(drafts)
    .filter(([, value]) => value !== '')
    .map(([id, value]): [string, string] => [
      id,
      value.slice(0, maxDraftLength),
    ]);
  return Object.fromEntries(entries.slice(-maxDrafts));
}

export function readDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const drafts: Record<string, string> = {};
    for (const [id, text] of Object.entries(value))
      if (typeof text === 'string') drafts[id] = text;
    return sanitize(drafts);
  } catch {
    return {};
  }
}

export function writeDrafts(drafts: Record<string, string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(sanitize(drafts)));
  } catch {
    return;
  }
}
