import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CONTRACT_TYPES,
  contractTypesPath,
  generateContractTypes,
} from '../apps/mobile/scripts/contract-types.mjs';

test('checked-in mobile contract types match a fresh generation from the published schemas', async () => {
  const generated = await generateContractTypes();
  assert.deepEqual(
    generated.map(({ output }) => output),
    CONTRACT_TYPES.map(({ output }) => output),
  );
  for (const { output, content } of generated) {
    const checkedIn = await readFile(contractTypesPath(output), 'utf8');
    assert.equal(
      checkedIn,
      content,
      `${output} differs from its schema; run npm run contracts:types and commit the result`,
    );
  }
});

test('generated contract types carry no comments, banners or interfaces', async () => {
  for (const { output, content } of await generateContractTypes()) {
    assert.doesNotMatch(content, /\/\*|\/\/|^export interface /m, output);
    assert.match(content, /^export type /, output);
  }
});
