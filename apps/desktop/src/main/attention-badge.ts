const GLYPH_WIDTH = 3;
const GLYPH_HEIGHT = 5;
const RING_WIDTH_RATIO = 0.08;
const TEXT_WIDTH_RATIO = 0.62;
const TEXT_HEIGHT_RATIO = 0.56;
const OVERFLOW_COUNT = 9;

const glyphs: Record<string, string> = {
  '0': '111101101101111',
  '1': '010110010010111',
  '2': '111001111100111',
  '3': '111001111001111',
  '4': '101101111001001',
  '5': '111100111001111',
  '6': '111100111101111',
  '7': '111001001001001',
  '8': '111101111101111',
  '9': '111101111001111',
  '+': '000010111010000',
};

export const badgeLabel = (count: number) =>
  count > OVERFLOW_COUNT ? `${OVERFLOW_COUNT}+` : String(count);

const blend = (
  buffer: Buffer,
  offset: number,
  value: number,
  coverage: number,
) => {
  if (coverage <= 0) return;
  const alpha = Math.min(1, coverage);
  const keep = 1 - alpha;
  for (let channel = 0; channel < 3; channel++)
    buffer[offset + channel] = Math.round(
      value * alpha + buffer[offset + channel]! * keep,
    );
  buffer[offset + 3] = Math.round(255 * alpha + buffer[offset + 3]! * keep);
};

const textScale = (label: string, size: number) => {
  const units = label.length * GLYPH_WIDTH + (label.length - 1);
  return Math.max(
    1,
    Math.min(
      Math.floor((size * TEXT_WIDTH_RATIO) / units),
      Math.floor((size * TEXT_HEIGHT_RATIO) / GLYPH_HEIGHT),
    ),
  );
};

export function paintBadge(
  buffer: Buffer,
  width: number,
  count: number,
  size: number,
  left: number,
  top: number,
) {
  const radius = size / 2;
  const ring = Math.max(1, size * RING_WIDTH_RATIO);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - radius, y + 0.5 - radius);
      const offset = ((top + y) * width + left + x) * 4;
      blend(buffer, offset, 0, radius - distance);
      blend(buffer, offset, 255, radius - ring - distance);
    }
  const label = badgeLabel(count);
  const scale = textScale(label, size);
  const textWidth = (label.length * GLYPH_WIDTH + label.length - 1) * scale;
  const textLeft = left + Math.round((size - textWidth) / 2);
  const textTop = top + Math.round((size - GLYPH_HEIGHT * scale) / 2);
  [...label].forEach((character, index) => {
    const glyph = glyphs[character] ?? '';
    const glyphLeft = textLeft + index * (GLYPH_WIDTH + 1) * scale;
    for (let row = 0; row < GLYPH_HEIGHT; row++)
      for (let column = 0; column < GLYPH_WIDTH; column++) {
        if (glyph[row * GLYPH_WIDTH + column] !== '1') continue;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const x = glyphLeft + column * scale + dx;
            const y = textTop + row * scale + dy;
            blend(buffer, (y * width + x) * 4, 0, 1);
          }
      }
  });
}

export function badgeBitmap(count: number, size: number): Buffer {
  const buffer = Buffer.alloc(size * size * 4);
  paintBadge(buffer, size, count, size, 0, 0);
  return buffer;
}
