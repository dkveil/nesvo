import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getLogoFrame,
  LOGO_CYCLE_MS,
  nextLogoFrameDelay,
} from '../apps/mobile/src/shared/brand/model/logo-motion';

test('logo eye preserves the SVG step-end look transitions', () => {
  assert.equal(getLogoFrame(0).eyeOffsetX, 0);
  for (const [atMs, before, after] of [
    [1440, 0, 1],
    [2520, 1, -1],
    [3600, -1, 0],
  ] as const) {
    assert.equal(getLogoFrame(atMs - 0.5).eyeOffsetX, before);
    assert.equal(getLogoFrame(atMs).eyeOffsetX, after);
    assert.equal(getLogoFrame(atMs + 0.5).eyeOffsetX, after);
  }
});

test('logo eyelid closes only for the two source blink windows', () => {
  assert.equal(getLogoFrame(0).closed, false);
  for (const [startMs, endMs] of [
    [840, 1080],
    [3960, 4200],
  ] as const) {
    assert.equal(getLogoFrame(startMs - 0.5).closed, false);
    assert.equal(getLogoFrame(startMs).closed, true);
    assert.equal(getLogoFrame(endMs - 0.5).closed, true);
    assert.equal(getLogoFrame(endMs).closed, false);
  }
});

test('logo satellite preserves every source step including the cycle reset', () => {
  assert.equal(getLogoFrame(0).satelliteOffsetY, 0);
  for (const [atMs, before, after] of [
    [1500, 0, -1],
    [2700, -1, 0],
    [3900, 0, 1],
    [4500, 1, 3],
    [5400, 3, 1],
    [6000, 1, 0],
  ] as const) {
    assert.equal(getLogoFrame(atMs - 0.5).satelliteOffsetY, before);
    assert.equal(getLogoFrame(atMs).satelliteOffsetY, after);
    assert.equal(getLogoFrame(atMs + 0.5).satelliteOffsetY, after);
  }
});

test('logo frames and delays wrap across cycles without losing fractional milliseconds', () => {
  assert.equal(LOGO_CYCLE_MS, 6000);
  for (const elapsedMs of [0, 839.5, 840, 1080, 1440, 3900, 3960, 5400, 5999.5]) {
    assert.deepEqual(getLogoFrame(elapsedMs + LOGO_CYCLE_MS * 7), getLogoFrame(elapsedMs));
    assert.equal(nextLogoFrameDelay(elapsedMs + LOGO_CYCLE_MS * 7), nextLogoFrameDelay(elapsedMs));
  }
  assert.equal(nextLogoFrameDelay(839.5), 0.5);
  assert.equal(nextLogoFrameDelay(5999.5), 0.5);
  assert.equal(nextLogoFrameDelay(6000), 840);
});

test('logo scheduler wakes only when a visible frame changes', () => {
  const boundaries = [840, 1080, 1440, 1500, 2520, 2700, 3600, 3900, 3960, 4200, 4500, 5400, 6000];
  let elapsedMs = 0;
  for (const boundaryMs of boundaries) {
    const delayMs = nextLogoFrameDelay(elapsedMs);
    assert.ok(delayMs > 0);
    assert.equal(elapsedMs + delayMs, boundaryMs);
    assert.deepEqual(getLogoFrame(boundaryMs - 0.5), getLogoFrame(elapsedMs));
    assert.notDeepEqual(getLogoFrame(boundaryMs), getLogoFrame(elapsedMs));
    elapsedMs += delayMs;
  }
});

test('invalid and negative elapsed time safely starts the animation', () => {
  for (const elapsedMs of [
    -1,
    -6000,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    assert.deepEqual(getLogoFrame(elapsedMs), getLogoFrame(0));
    assert.equal(nextLogoFrameDelay(elapsedMs), nextLogoFrameDelay(0));
  }
});
