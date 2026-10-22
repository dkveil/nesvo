import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseAddedLines } from '../scripts/contract-gates/git-range.mjs';
import {
  findRustComments,
  findScriptComments,
  findTomlComments,
  findYamlComments,
} from '../scripts/contract-gates/lexers.mjs';
import { findAttribution, isCheckedPath, judgeComments } from '../scripts/contract-gates/rules.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gateScript = join(root, 'scripts', 'contract-gates.mjs');
const allowlistPath = join(root, 'scripts', 'contract-gates', 'allowlist.json');
const DROP_ORDER_LINE =
  "// Drop order: the input channel must close before ConPTY's potentially blocking destructor.";

const source = (...lines) => `${lines.join('\n')}\n`;
const everyLine = content => new Set(content.split('\n').map((_, index) => index + 1));
const verdicts = (path, content, { added = everyLine(content), allowlist = [] } = {}) =>
  judgeComments({ path, content, addedLines: added, allowlist: new Set(allowlist) }).map(
    ({ line, reason }) => `${line}: ${reason}`,
  );
const reasons = (path, lines, options) =>
  verdicts(path, source(...lines), options).map(verdict => verdict.split(': ')[1]);

test('comment gate: Rust, TypeScript, JavaScript, YAML and TOML are checked and generated output is not', () => {
  for (const path of [
    'apps/host/src/main.rs',
    'apps/mobile/src/app/session/[id].tsx',
    'scripts/contract-gates.mjs',
    'tests/fixtures/scoped-agent.cjs',
    '.github/workflows/ci.yml',
    'docs/config.yaml',
    'Cargo.toml',
  ]) {
    assert.equal(isCheckedPath(path), true, path);
  }
  for (const path of [
    'README.md',
    'package.json',
    'Cargo.lock',
    'LICENSE',
    'scripts/ensure-dev-host.ps1',
    'apps/mobile/src/shared/terminal/generated.ts',
    'apps/mobile/node_modules/pkg/index.js',
    'target/debug/build.rs',
  ]) {
    assert.equal(isCheckedPath(path), false, path);
  }
});

test('comment gate: Rust leading, trailing and block comments are rejected', () => {
  const content = source(
    'fn main() {',
    '    // note',
    '    let value = 1; // why',
    '    /* block',
    '       spans */',
    '}',
  );
  assert.deepEqual(verdicts('src/lib.rs', content), [
    '2: code comment',
    '3: trailing code comment',
    '4: block comment',
  ]);
});

test('comment gate: Rust comment markers inside strings, raw strings, chars and lifetimes are not comments', () => {
  const content = source(
    "fn probe<'a>(text: &'a str) -> &'a str {",
    '    let url = "https://example.com/a//b";',
    '    let escaped = "quote \\" // still text";',
    '    let raw = r#"// still text"#;',
    '    let fixture = r##"',
    '// inside the raw string',
    '/* and a block */',
    '"##;',
    "    let slash = '/';",
    "    let quote = '\\'';",
    '    let bytes = b"//";',
    '    text',
    '}',
  );
  assert.deepEqual(verdicts('src/lib.rs', content), []);
  assert.deepEqual(
    findRustComments('// first\r\nfn main() {}\r\n').map(({ text }) => text),
    ['// first'],
  );
});

test('comment gate: Rust nested block comments are one comment and inner doc comments are rejected', () => {
  const content = source('//! crate docs', '/* outer /* inner */ still outer */', '//// banner');
  assert.deepEqual(verdicts('src/lib.rs', content), [
    '1: inner doc comment',
    '2: block comment',
    '3: code comment',
  ]);
});

test('comment gate: Rust doc comments are allowed on clap and schemars items only', () => {
  const allowed = source(
    '/// Parser doc.',
    '#[derive(Debug, Parser)]',
    'pub struct Cli {',
    '    /// Field doc.',
    '    #[arg(long)]',
    '    pub verbose: bool,',
    '    #[command(subcommand)]',
    '    pub command: Command,',
    '}',
    '',
    '#[derive(Debug, Subcommand)]',
    'pub enum Command {',
    '    /// Variant doc.',
    '    Run {',
    '        /// Variant field doc.',
    '        #[arg(',
    '            long,',
    '        )]',
    '        id: String,',
    '    },',
    '}',
    '',
    '#[derive(',
    '    Debug,',
    '    JsonSchema,',
    ')]',
    '/// Doc between a multi-line derive and its struct.',
    'pub struct Shape {',
    '    /// Property doc.',
    '    pub name: String,',
    '}',
    '',
    '#[derive(Clone, ValueEnum)]',
    'pub enum Mode {',
    '    /// Fast.',
    '    Fast,',
    '}',
    '',
    '#[derive(Args)]',
    'pub struct Extra {',
    '    /// Positional.',
    '    pub id: String,',
    '}',
  );
  assert.deepEqual(verdicts('src/cli.rs', allowed), []);

  const rejected = source(
    '/// Doc on a free function.',
    'pub fn helper() {}',
    '',
    '#[derive(Debug, Clone)]',
    'pub struct Plain {',
    '    /// Field of a plain struct.',
    '    pub value: u8,',
    '}',
    '',
    'impl Plain {',
    '    /// Method doc.',
    '    pub fn get(&self) -> u8 {',
    '        self.value',
    '    }',
    '}',
  );
  const reason = 'doc comment outside clap and schemars items';
  assert.deepEqual(verdicts('src/plain.rs', rejected), [
    `1: ${reason}`,
    `6: ${reason}`,
    `11: ${reason}`,
  ]);
});

test('comment gate: a SAFETY comment passes only as one line directly above unsafe', () => {
  const unsafeCall = 'unsafe { read(pointer) }';
  assert.deepEqual(
    reasons('a.rs', ['// SAFETY: the caller keeps the pointer valid.', unsafeCall]),
    [],
  );
  assert.deepEqual(
    reasons('a.rs', [
      '// SAFETY: the pointer outlives the call.',
      'assert_ne!(',
      `    ${unsafeCall},`,
      '    0',
      ');',
    ]),
    [],
  );
  assert.deepEqual(reasons('a.rs', ['// SAFETY: first half', '// second half', unsafeCall]), [
    'code comment',
    'code comment',
  ]);
  assert.deepEqual(reasons('a.rs', ['// SAFETY: nothing unsafe follows', 'let value = 1;']), [
    'code comment',
  ]);
  assert.deepEqual(
    reasons('a.rs', ['// SAFETY: too far', 'let a = 1;', 'let b = 2;', 'let c = 3;', unsafeCall]),
    ['code comment'],
  );
  assert.deepEqual(reasons('a.rs', ['// safety: lowercase', unsafeCall]), ['code comment']);
  assert.deepEqual(reasons('a.rs', ['// SAFETY:', unsafeCall]), ['code comment']);
  assert.deepEqual(reasons('a.rs', [`${unsafeCall}; // SAFETY: trailing`]), [
    'trailing code comment',
  ]);
});

test('comment gate: listed WHY lines pass by exact trimmed text and any change fails', () => {
  const options = { allowlist: [DROP_ORDER_LINE] };
  assert.deepEqual(reasons('a.rs', [DROP_ORDER_LINE], options), []);
  assert.deepEqual(reasons('a.rs', [`        ${DROP_ORDER_LINE}`, 'drop(sender);'], options), []);
  assert.deepEqual(reasons('a.ts', [DROP_ORDER_LINE], options), []);
  assert.deepEqual(reasons('a.rs', [DROP_ORDER_LINE.replace('input', 'output')], options), [
    'code comment',
  ]);
  assert.deepEqual(reasons('a.rs', [`${DROP_ORDER_LINE} Really.`], options), ['code comment']);
  assert.deepEqual(reasons('a.rs', [`drop(sender); ${DROP_ORDER_LINE}`], options), [
    'trailing code comment',
  ]);
  assert.deepEqual(reasons('a.rs', [DROP_ORDER_LINE]), ['code comment']);
});

test('comment gate: the allowlist file holds only whole, distinct WHY comment lines', () => {
  const { allowedComments } = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  assert.ok(allowedComments.length > 0);
  assert.equal(new Set(allowedComments).size, allowedComments.length);
  for (const line of allowedComments) {
    assert.match(line, /^\/\/ \S/);
    assert.equal(line, line.trim());
    assert.equal(line.includes('\n'), false);
  }
});

test('comment gate: script comments of every shape are rejected', () => {
  const content = source(
    '// leading',
    'const value = 1; // trailing',
    '/* block */',
    '/**',
    ' * jsdoc',
    ' */',
    'const view = <View>{/* jsx */}</View>;',
    '/// <reference types="node" />',
    "const text = 'It\\'s'; // after an escaped quote",
  );
  assert.deepEqual(verdicts('src/a.tsx', content), [
    '1: code comment',
    '2: trailing code comment',
    '3: block comment',
    '4: block comment',
    '7: block comment',
    '8: code comment',
    '9: trailing code comment',
  ]);
});

test('comment gate: script markers inside strings, templates, regex literals, URLs and JSX text are not comments', () => {
  const content = source(
    '#!/usr/bin/env node',
    'const quoted = \'x // y\' + "http://z";',
    'const template = `a ${"//"} // b ${`nested // c`} d`;',
    'const multiline = `first',
    '// still template',
    '`;',
    'const pattern = /\\/\\//.test(value) || /[/]\\//g.test(value);',
    'const ratio = total / count / 2;',
    'const link = <a href="https://example.com">https://example.com</a>;',
    "const apostrophe = <Text>Don't</Text>;",
  );
  assert.deepEqual(verdicts('src/a.tsx', content), []);
  assert.deepEqual(
    findScriptComments("const apostrophe = <Text>Don't</Text>; // after jsx\n").map(
      ({ text }) => text,
    ),
    ['// after jsx'],
  );
});

test('comment gate: YAML comments are rejected while hashes in scalars and shell blocks are not', () => {
  const content = source(
    'name: Checks # trailing',
    '# leading',
    'jobs:',
    '  app:',
    '    steps:',
    '      - run: |',
    '          version="${tag#v}"',
    '          printf \'## %s\\n\' "$VERSION"',
    '          # shell comment',
    '      - name: next',
    "        if: ${{ github.ref == 'refs/heads/#main' }}",
    '        env:',
    '          QUOTED: "a # b"',
    '          PLAIN: a#b',
    '          FOLDED: >-',
    '            text # inside the folded block',
    '          AFTER: value',
  );
  assert.deepEqual(verdicts('.github/workflows/ci.yml', content), [
    '1: hash comment',
    '2: hash comment',
    '9: hash comment',
  ]);
  assert.deepEqual(
    findYamlComments('key: value\r\n# crlf\r\n').map(({ text }) => text),
    ['# crlf'],
  );
});

test('comment gate: TOML comments are rejected while hashes in strings are not', () => {
  const content = source(
    'name = "a # b"',
    "path = 'C:\\dir\\' # trailing",
    'text = """',
    '# inside a multi-line string',
    '"""',
    "literal = '''",
    '# inside a literal block',
    "'''",
    '# leading',
  );
  assert.deepEqual(verdicts('Cargo.toml', content), ['2: hash comment', '9: hash comment']);
  assert.deepEqual(findTomlComments('a = 1\n').length, 0);
});

test('comment gate: only comments on added lines are judged', () => {
  const content = source('fn a() {', '    // old', '}', 'fn b() {', '    // new', '}');
  assert.deepEqual(verdicts('src/lib.rs', content, { added: new Set([5]) }), ['5: code comment']);
  assert.deepEqual(verdicts('src/lib.rs', content, { added: new Set([1, 3, 4, 6]) }), []);
  const block = source('fn a() {}', '/* first', '   second */', 'fn b() {}');
  assert.deepEqual(verdicts('src/lib.rs', block, { added: new Set([3]) }), ['2: block comment']);
  assert.deepEqual(verdicts('src/lib.rs', block, { added: new Set([1, 4]) }), []);
});

test('attribution gate: co-author trailers, generated-with footers and session trailers are rejected', () => {
  const rejected = [
    ['Co-Authored-By: Someone <someone@example.com>', 'co-author trailer'],
    ['co-authored-by: lower case', 'co-author trailer'],
    ['\u{1F916} Generated with [Some Tool](https://example.com)', 'generated-with footer'],
    ['Generated with Some Tool', 'generated-with footer'],
    ['Generated by Some Tool', 'generated-with footer'],
    ['Claude-Session: https://example.com/s/1', 'session trailer'],
    ['Codex-Session: abc', 'session trailer'],
    ['https://claude.ai/code/session_01ABC', 'session link'],
  ];
  for (const [line, reason] of rejected) {
    const hits = findAttribution(`feat: subject\n\nbody paragraph\n\n${line}\n`);
    assert.deepEqual(
      hits.map(hit => [hit.line, hit.reason]),
      [[5, reason]],
      line,
    );
  }
});

test('attribution gate: messages that only mention the rules pass', () => {
  for (const message of [
    'feat(ci): reject co-author trailers in commit messages',
    'docs: explain why Generated with footers are refused',
    'fix: the generated file no longer repeats Co-Authored-By handling',
    'chore: regenerate the contracts\n\nRun NESVO_UPDATE_CONTRACTS=1 to refresh them.',
    'test: cover session-based fixtures\n\nThe session: field stays optional.',
  ]) {
    assert.deepEqual(findAttribution(message), [], message);
  }
});

test('diff parser: hunks map to added line numbers per target file', () => {
  const diff = source(
    'diff --git a/src/lib.rs b/src/lib.rs',
    'index 1111111..2222222 100644',
    '--- a/src/lib.rs',
    '+++ b/src/lib.rs',
    '@@ -3,0 +4,2 @@ fn existing() {',
    '+    let one = 1;',
    '+    let two = 2;',
    '@@ -10 +12 @@',
    '-    old();',
    '+    new();',
    '\\ No newline at end of file',
    'diff --git a/gone.rs b/gone.rs',
    'deleted file mode 100644',
    '--- a/gone.rs',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-a',
    '-b',
    'diff --git a/new file.ts b/new file.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new file.ts\t',
    '@@ -0,0 +1,2 @@',
    '+++ looks like a header',
    '+second',
    'diff --git a/x.toml b/y.toml',
    'similarity index 90%',
    'rename from x.toml',
    'rename to y.toml',
    '--- a/x.toml',
    '+++ b/y.toml',
    '@@ -1 +1 @@',
    '-a = 1',
    '+a = 2',
    'diff --git a/pure.rs b/moved.rs',
    'similarity index 100%',
    'rename from pure.rs',
    'rename to moved.rs',
  );
  const added = parseAddedLines(diff);
  assert.deepEqual(
    [...added].map(([path, lines]) => [path, [...lines]]),
    [
      ['src/lib.rs', [4, 5, 12]],
      ['new file.ts', [1, 2]],
      ['y.toml', [1]],
    ],
  );
});

const gitEnvironment = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1',
});

const createRepository = () => {
  const directory = mkdtempSync(join(tmpdir(), 'nesvo-gates-'));
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Gate Test',
        '-c',
        'user.email=gate-test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.autocrlf=false',
        ...args,
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: gitEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  git('init', '--quiet', '--initial-branch=main');
  const commit = (files, message) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), content);
    }
    git('add', '--all');
    git('commit', '--quiet', '--no-verify', '--message', message);
    return git('rev-parse', 'HEAD');
  };
  return { git, commit, directory };
};

const withRepository = callback => {
  const repository = createRepository();
  try {
    callback(repository);
  } finally {
    rmSync(repository.directory, { recursive: true, force: true });
  }
};

const runGate = (repository, ...args) => {
  const result = spawnSync(process.execPath, [gateScript, ...args], {
    cwd: repository.directory,
    encoding: 'utf8',
    env: gitEnvironment(),
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

const CLEAN_LIB = source('pub fn one() -> u8 {', '    1', '}');

test('cli: a clean range passes and counts what it inspected', () => {
  withRepository(repository => {
    const base = repository.commit({ 'src/lib.rs': CLEAN_LIB }, 'feat: first');
    repository.commit(
      {
        'src/lib.rs': `${CLEAN_LIB}${source('pub fn two() -> u8 {', '    2', '}')}`,
        '.github/workflows/ci.yml': 'name: Checks\n',
        'Cargo.toml': '[package]\nname = "gate"\n',
        'README.md': '# Heading\n',
      },
      'feat: second',
    );
    const result = runGate(repository, '--base', base, '--head', 'HEAD');
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /passed for [0-9a-f]{12}\.\.[0-9a-f]{12}: 1 commit, 3 files/);
  });
});

test('cli: added comments and attribution fail with a precise list', () => {
  withRepository(repository => {
    const base = repository.commit({ 'src/lib.rs': CLEAN_LIB }, 'feat: first');
    const head = repository.commit(
      {
        'src/lib.rs': source('pub fn one() -> u8 {', '    // restore the handle', '    1', '}'),
        'web/app.ts': source('export const a = 1;', 'export const b = 2; // why'),
        '.github/workflows/ci.yml': 'name: Checks\n# note\n',
        'Cargo.toml': '[package]\nname = "gate"\n\n# pinned\n',
      },
      'feat: second\n\nbody paragraph\n\nCo-Authored-By: Someone <someone@example.com>',
    );
    const result = runGate(repository, '--base', base, '--head', 'HEAD');
    assert.equal(result.status, 1, result.output);
    const short = head.slice(0, 12);
    for (const expected of [
      'failed for',
      '5 violations',
      'src/lib.rs:2: code comment: // restore the handle',
      'web/app.ts:2: trailing code comment: // why',
      '.github/workflows/ci.yml:2: hash comment: # note',
      'Cargo.toml:4: hash comment: # pinned',
      `commit ${short} message line 5: co-author trailer: Co-Authored-By: Someone`,
      'docs/engineering.md#comment-and-attribution-gates',
    ]) {
      assert.ok(result.output.includes(expected), `${expected}\n${result.output}`);
    }
  });
});

test('cli: allowed forms pass', () => {
  withRepository(repository => {
    const base = repository.commit({ 'README.md': 'seed\n' }, 'chore: seed');
    repository.commit(
      {
        'apps/tui/src/cli.rs': source(
          '#[derive(Parser)]',
          'pub struct Cli {',
          '    /// Print the build identity.',
          '    #[arg(long)]',
          '    pub version: bool,',
          '}',
        ),
        'apps/host/src/pty.rs': source(
          'fn close(sender: Sender) {',
          `    ${DROP_ORDER_LINE}`,
          '    drop(sender);',
          '    // SAFETY: the handle was just opened by this function.',
          '    unsafe { CloseHandle(handle) };',
          '}',
        ),
      },
      'feat: allowed forms',
    );
    const result = runGate(repository, '--base', base, '--head', 'HEAD');
    assert.equal(result.status, 0, result.output);
  });
});

test('cli: the net diff of the range decides, so a comment added and removed inside it passes', () => {
  withRepository(repository => {
    const base = repository.commit({ 'src/lib.rs': CLEAN_LIB }, 'feat: first');
    repository.commit(
      { 'src/lib.rs': source('pub fn one() -> u8 {', '    // temporary', '    1', '}') },
      'wip: note',
    );
    repository.commit({ 'src/lib.rs': CLEAN_LIB }, 'fix: drop the note');
    assert.equal(runGate(repository, '--base', base, '--head', 'HEAD').status, 0);
  });
});

test('cli: comments that predate the range stay unjudged in files the range touches', () => {
  withRepository(repository => {
    const legacy = source('// legacy', 'pub fn one() -> u8 {', '    1', '}');
    const base = repository.commit({ 'src/lib.rs': legacy }, 'chore: legacy');
    repository.commit({ 'src/lib.rs': `${legacy}pub fn two() -> u8 {}\n` }, 'feat: add two');
    assert.equal(runGate(repository, '--base', base, '--head', 'HEAD').status, 0);
  });
});

test('cli: a base that moved on does not charge the head with what the base removed', () => {
  withRepository(repository => {
    const legacy = source('// legacy', 'pub fn one() -> u8 {', '    1', '}');
    const fork = repository.commit({ 'src/lib.rs': legacy }, 'chore: legacy');
    const moved = repository.commit({ 'src/lib.rs': CLEAN_LIB }, 'refactor: drop the legacy note');
    repository.git('checkout', '--quiet', '-b', 'feature', fork);
    const head = repository.commit({ 'src/other.rs': CLEAN_LIB }, 'feat: other');
    const result = runGate(repository, '--base', moved, '--head', head);
    assert.equal(result.status, 0, result.output);
  });
});

test('cli: an absent, null or unknown base falls back to the head commit alone', () => {
  withRepository(repository => {
    repository.commit({ 'src/lib.rs': CLEAN_LIB }, 'feat: first');
    const dirty = repository.commit(
      { 'src/lib.rs': source('// note', 'pub fn one() -> u8 {', '    1', '}') },
      'feat: dirty\n\nGenerated with Some Tool',
    );
    const clean = repository.commit({ 'src/other.rs': CLEAN_LIB }, 'feat: clean');
    assert.equal(runGate(repository, '--head', clean).status, 0);
    assert.equal(runGate(repository, '--base', '', '--head', clean).status, 0);
    for (const base of [[], ['--base', '0'.repeat(40)], ['--base', 'f'.repeat(40)]]) {
      const result = runGate(repository, ...base, '--head', dirty);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /head commit only/);
      assert.match(result.output, /src\/lib\.rs:1: code comment: \/\/ note/);
      assert.match(result.output, /message line 3: generated-with footer/);
    }
  });
});

test('cli: a root commit is judged against the empty tree', () => {
  withRepository(repository => {
    const rootCommit = repository.commit({ 'src/lib.rs': '// first\n' }, 'feat: first');
    const result = runGate(repository, '--head', rootCommit);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /src\/lib\.rs:1: code comment/);
  });
});

test('cli: generated output and unsupported files are not inspected', () => {
  withRepository(repository => {
    const base = repository.commit({ 'README.md': 'seed\n' }, 'chore: seed');
    repository.commit(
      {
        'apps/mobile/src/shared/terminal/generated.ts': '// bundled banner\n',
        'notes.md': '# Heading\n',
        'data.json': '{}\n',
        'scripts/helper.ps1': '# powershell comment\n',
      },
      'chore: generated',
    );
    const result = runGate(repository, '--base', base, '--head', 'HEAD');
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /0 files/);
  });
});

test('cli: a git failure or an option-like revision ends the run with an error instead of a pass', () => {
  withRepository(repository => {
    repository.commit({ 'README.md': 'seed\n' }, 'chore: seed');
    for (const args of [
      ['--head', 'not-a-revision'],
      ['--head=--output=leak.txt'],
      ['--base=--output=leak.txt', '--head', 'HEAD'],
      ['--head', ''],
    ]) {
      const result = runGate(repository, ...args);
      assert.equal(result.status, 2, `${args}\n${result.output}`);
      assert.match(result.output, /could not run/);
    }
  });
});

test('cli: a base missing from a shallow clone is an error, while an absent base still checks the head commit', () => {
  withRepository(origin => {
    const first = origin.commit({ 'src/lib.rs': CLEAN_LIB }, 'feat: first');
    origin.commit({ 'src/other.rs': CLEAN_LIB }, 'feat: second');
    const clone = mkdtempSync(join(tmpdir(), 'nesvo-gates-shallow-'));
    try {
      execFileSync(
        'git',
        ['clone', '--quiet', '--depth', '1', pathToFileURL(origin.directory).href, clone],
        { env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const shallow = { directory: clone };
      const missing = runGate(shallow, '--base', first, '--head', 'HEAD');
      assert.equal(missing.status, 2, missing.output);
      assert.match(missing.output, /shallow clone/);
      const absent = runGate(shallow, '--base', '0'.repeat(40), '--head', 'HEAD');
      assert.equal(absent.status, 0, absent.output);
      assert.match(absent.output, /head commit only/);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});
