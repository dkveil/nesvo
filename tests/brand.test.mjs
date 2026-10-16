import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(`../packages/brand/${path}`, import.meta.url), 'utf8');
const logo = JSON.parse(read('logo.json'));
const { colors } = JSON.parse(read('tokens.json'));

test('shared terminal glyphs and vector paths preserve the approved mark exactly', () => {
  const approved = [
    ...read('assets/nesvo-logo.svg').matchAll(/<path fill="[^"]+" d="([^"]+)"/g),
  ].map(match => match[1]);
  assert.equal(approved.length, 5);
  assert.equal(logo.paths.robot, approved[0]);
  assert.equal(logo.paths.wordmark, approved.slice(1).join(''));
  for (const [index, rows] of logo.glyphs.entries()) {
    const pixels = rows.flatMap((row, y) =>
      [...row].flatMap((pixel, x) =>
        pixel === '1' ? [`M${logo.origins[index] + x} ${y}h1v1h-1z`] : [],
      ),
    );
    assert.equal(pixels.join(''), approved[index]);
    assert.equal(rows.length, 8, 'all letter bodies share the same height and baseline');
  }
  assert.deepEqual(logo.eye, { x: 5, y: 2, width: 1, height: 1 });
  assert.deepEqual(logo.eyelid, { x: 2, y: 2, width: 5, height: 1 });
});

test('Ultraviolet palette and six-second step frames retain the approved contract', () => {
  assert.equal(colors.background, '#17171A');
  assert.equal(colors.surface, '#1E1E22');
  assert.equal(colors.accent, '#A34DFF');
  assert.equal(colors.text, '#EAE8EE');
  assert.equal(colors.muted, '#ADACB5');
  assert.equal(colors.border, '#35353D');
  assert.equal(new Set([colors.accent, colors.success, colors.warning, colors.danger]).size, 4);
  assert.equal(logo.motion.durationMs, 6000);
  assert.deepEqual(
    logo.motion.frames.filter(frame => !frame.eyeOpen).map(frame => frame.atMs),
    [840, 3960],
  );
  assert.deepEqual(
    logo.motion.frames.map(frame => frame.atMs),
    [...logo.motion.frames.map(frame => frame.atMs)].sort((a, b) => a - b),
  );
  assert.equal(logo.motion.frames[0].atMs, 0);
  assert.ok(logo.motion.frames.every(frame => frame.atMs < logo.motion.durationMs));
  const animated = read('assets/nesvo-logo-animated.svg');
  assert.match(animated, /class="eyelid" x="2" y="2" width="5" height="1" fill="#A34DFF"/);
  assert.match(animated, /prefers-reduced-motion:reduce/);
});
