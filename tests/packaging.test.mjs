import ignore from 'ignore';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// EAS evaluates this file at the Git root and uses gitignore path semantics.
const archiveIgnore = ignore().add(readFileSync(resolve(root, '.easignore'), 'utf8'));

function filesIn(directory) {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? filesIn(path) : entry.isFile() ? [path] : [];
  });
}

function assertIncluded(path) {
  assert.ok(existsSync(resolve(root, path)), `Build input is missing: ${path}`);
  assert.equal(archiveIgnore.ignores(path), false, `EAS must include ${path}`);
}

test('EAS includes mobile source, including the host transport and terminal renderer', () => {
  const files = filesIn('apps/mobile/src').filter(path => !path.includes('/__tests__/'));
  assert.ok(files.length > 0);
  // Unanchored legacy "host/" once removed shared/api/host from the cloud archive.
  for (const path of files) assertIncluded(path);
});

test('EAS includes workspace dependency locks, mobile configuration and terminal build input', () => {
  for (const path of [
    'package.json',
    'package-lock.json',
    'apps/mobile/package.json',
    'apps/mobile/app.json',
    'apps/mobile/eas.json',
    'apps/mobile/tsconfig.json',
    'apps/mobile/metro.config.js',
    'scripts/build-terminal.mjs',
    'packages/brand/package.json',
    'packages/brand/tokens.json',
    'packages/brand/logo.json',
    'packages/brand/assets/nesvo-logo.svg',
    'packages/brand/assets/nesvo-logo-animated.svg',
  ])
    assertIncluded(path);
});

test('EAS includes all mobile images and resolves configured asset paths from the app directory', () => {
  const assets = filesIn('apps/mobile/assets');
  assert.ok(assets.length > 0);
  for (const path of assets) assertIncluded(path);
  const { expo } = JSON.parse(readFileSync(resolve(root, 'apps/mobile/app.json'), 'utf8'));
  const references = [
    expo.icon,
    expo.web.favicon,
    ...Object.entries(expo.android.adaptiveIcon)
      .filter(([key]) => key.endsWith('Image'))
      .map(([, value]) => value),
  ];
  for (const reference of references) {
    assert.equal(typeof reference, 'string');
    assertIncluded(`apps/mobile/${reference.replace(/^\.\//, '')}`);
  }
});

test('EAS excludes pairing data, secrets, dependencies, Rust products and legacy directories', () => {
  // Synthetic paths exercise privacy rules without reading local credentials.
  for (const path of [
    '.git/config',
    '.local/pairing.json',
    'apps/mobile/.local/pairing.json',
    '.env',
    '.env.production',
    'apps/mobile/.env.local',
    'credentials/signing.p12',
    'credentials/AuthKey.p8',
    'node_modules/expo/package.json',
    'apps/mobile/node_modules/react/package.json',
    'target/debug/nesvo-host.exe',
    'apps/host/target/debug/nesvo-host.exe',
    'apps/host/src/main.rs',
    'apps/tui/src/main.rs',
    'crates/protocol/src/lib.rs',
    'host/src/main.rs',
    'tui/src/main.rs',
    'apps/mobile/dist/index.html',
    'apps/mobile/.expo/settings.json',
    'artifacts/terminal-live.png',
  ])
    assert.equal(archiveIgnore.ignores(path), true, `EAS must exclude ${path}`);
});
