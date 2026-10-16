import { ESLint } from 'eslint';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

const eslint = new ESLint();
const source = 'apps/mobile/src';

async function messages(filename, code) {
  const [result] = await eslint.lintText(code, { filePath: path.resolve(source, filename) });
  assert.ok(result, 'ESLint must inspect the source fixture');
  assert.equal(result.fatalErrorCount, 0, 'The fixture must parse before checking architecture');
  return result.messages;
}

test('source filenames use kebab-case with only framework route exceptions', async () => {
  const invalid = await messages(
    'features/create-session/NewSession.tsx',
    'export const value = 1;',
  );
  assert.ok(invalid.some(message => message.ruleId === 'conventions/kebab-case'));
  for (const name of [
    'features/create-session/new-session.tsx',
    'app/_layout.tsx',
    'app/session/[id].tsx',
  ]) {
    const valid = await messages(name, 'export const value = 1;');
    assert.equal(
      valid.some(message => message.ruleId === 'conventions/kebab-case'),
      false,
      name,
    );
  }
});

test('domain dependencies resolve aliases and reject upward and private imports', async () => {
  const forbidden = [
    ['shared/ui/architecture-probe.ts', '@features/create-session'],
    ['features/create-session/architecture-probe.ts', '@features/manage-groups'],
    ['features/create-session/architecture-probe.ts', '@entities/group/ui/group-picker'],
    ['entities/group/model/architecture-probe.ts', '@widgets/app-shell'],
  ];
  for (const [filename, imported] of forbidden) {
    const result = await messages(
      filename,
      `import * as dependency from '${imported}'; export const probe = dependency;`,
    );
    assert.ok(
      result.some(message => message.ruleId === 'boundaries/dependencies'),
      `${filename} must reject ${imported}`,
    );
  }
  const valid = await messages(
    'features/create-session/architecture-probe.ts',
    "import * as group from '@entities/group'; export const probe = group;",
  );
  assert.equal(
    valid.some(message => message.ruleId === 'boundaries/dependencies'),
    false,
  );
});

test('host transport cannot import React and entities cannot own routing', async () => {
  const transport = await messages(
    'shared/api/host/architecture-probe.ts',
    "import * as React from 'react'; export const probe = React;",
  );
  assert.ok(transport.some(message => message.ruleId === 'no-restricted-imports'));
  const entity = await messages(
    'entities/workspace/model/architecture-probe.ts',
    "import { router } from 'expo-router'; export const probe = router;",
  );
  assert.ok(entity.some(message => message.ruleId === 'no-restricted-imports'));
});

test('new source modules must belong to an explicit application layer', async () => {
  const result = await messages('misc/architecture-probe.ts', 'export const value = 1;');
  assert.ok(result.some(message => message.ruleId === 'boundaries/no-unknown-files'));
});
