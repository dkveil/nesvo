import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { parsePort } from './validate-port';

describe('parsePort', () => {
  it('accepts ports in range', () => {
    assert.equal(parsePort(' 8791 '), 8791);
    assert.equal(parsePort('65535'), 65535);
  });

  it('rejects empty, zero, out of range and non numeric input', () => {
    for (const input of ['', '0', '65536', '80a', '-1', '1.5'])
      assert.equal(parsePort(input), null);
  });
});
