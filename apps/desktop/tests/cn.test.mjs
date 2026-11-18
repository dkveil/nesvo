import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cn } from '../src/renderer/src/shared/lib/cn.ts';

test('class merging distinguishes font sizes from colors', () => {
  assert.equal(
    cn('text-ui', 'text-muted-foreground'),
    'text-ui text-muted-foreground',
  );
  assert.equal(cn('text-ui', 'text-sm'), 'text-sm');
});
