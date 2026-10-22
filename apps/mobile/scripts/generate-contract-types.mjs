import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { contractTypesPath, generateContractTypes } from './contract-types.mjs';

for (const { output, content } of await generateContractTypes()) {
  const path = contractTypesPath(output);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  console.log(`wrote ${output}`);
}
