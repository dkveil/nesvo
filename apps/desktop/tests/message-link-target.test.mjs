import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyMessageLink,
  fileTarget,
} from '../src/renderer/src/widgets/conversation/message-link-target.ts';

const scope = { directory: 'C:\\Harbor\\App', ports: new Set([5173]) };

test('classifies GitHub references, loopback previews and internal links', () => {
  assert.equal(
    classifyMessageLink(
      'https://github.com/octo/repo/pull/33/files#diff',
      scope,
    )?.kind,
    'pr',
  );
  assert.equal(
    classifyMessageLink('https://github.com/octo/repo/issues/12', scope)?.kind,
    'issue',
  );
  assert.equal(
    classifyMessageLink(
      'https://github.com.evil.invalid/octo/repo/pull/33',
      scope,
    )?.kind,
    'external',
  );
  assert.equal(
    classifyMessageLink('http://[::1]:8080/path', scope)?.kind,
    'preview',
  );
  assert.equal(
    classifyMessageLink('http://harbor.test:5173/path', scope)?.kind,
    'preview',
  );
  assert.equal(
    classifyMessageLink('http://harbor.test:5174/path', scope)?.kind,
    'external',
  );
  assert.equal(
    classifyMessageLink(
      'nesvo://inbox/11111111-1111-4111-8111-111111111111?host=local',
      scope,
    )?.kind,
    'inbox',
  );
  for (const url of [
    'javascript:open()',
    'https://name@localhost:5173',
    '//localhost/app',
    'file:///C:/Harbor/App/private.txt',
    'nesvo://import-workflow/x',
  ]) {
    assert.equal(classifyMessageLink(url, scope), null);
  }
});

test('normalizes in-workspace paths and rejects escapes and sibling roots', () => {
  assert.deepEqual(
    fileTarget('c:/harbor/app/src/index.ts:42', scope.directory),
    { path: 'src/index.ts', line: 42 },
  );
  assert.deepEqual(
    fileTarget('./docs/Release%20notes.md#L8', scope.directory),
    { path: 'docs/Release notes.md', line: 8 },
  );
  assert.deepEqual(fileTarget('/srv/App/main.kt', '/srv/App'), {
    path: 'main.kt',
  });
  for (const path of [
    '..%2foutside.txt',
    'src/../outside.txt',
    'C:/Harbor/AppBackup/index.ts',
    '/etc/passwd',
    'C:\\other\\app.ts',
    'src/.. /private.txt',
  ]) {
    assert.equal(fileTarget(path, scope.directory), null);
  }
  assert.equal(fileTarget('/srv/app/main.kt', '/srv/App'), null);
});
