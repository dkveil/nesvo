const MAX_TITLE_LENGTH = 100;

export function deriveThreadTitle(text: string) {
  const firstLine =
    text
      .split(/\r?\n/)
      .map(line => line.replace(/\s+/g, ' ').trim())
      .find(Boolean) ?? '';
  return firstLine.slice(0, MAX_TITLE_LENGTH).trim() || 'New thread';
}
