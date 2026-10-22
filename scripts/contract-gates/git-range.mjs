import { execFileSync } from 'node:child_process';

const MAX_BUFFER_BYTES = 512 * 1024 * 1024;
const NULL_REVISION = /^0+$/;
const REVISION = /^[0-9A-Za-z][\w./^~@{}-]*$/;
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const QUOTED_ESCAPES = { t: '\t', n: '\n', '"': '"', '\\': '\\' };
const SHORT_SHA_LENGTH = 12;

export const shortSha = sha => sha.slice(0, SHORT_SHA_LENGTH);

export const createGit =
  cwd =>
  (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

const tryGit = (git, ...args) => {
  try {
    return git(...args).trim();
  } catch {
    return null;
  }
};

const emptyTree = git => git('hash-object', '-t', 'tree', '/dev/null').trim();

const isUsableRevision = revision => Boolean(revision) && !NULL_REVISION.test(revision);

const assertRevision = (label, revision) => {
  if (!REVISION.test(revision)) throw new Error(`${label} "${revision}" is not a revision`);
};

const isShallow = git => git('rev-parse', '--is-shallow-repository').trim() === 'true';

const resolveBase = (git, base) => {
  if (!isUsableRevision(base)) return null;
  assertRevision('base', base);
  const baseSha = tryGit(git, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`);
  if (!baseSha && isShallow(git)) {
    throw new Error(
      `base ${shortSha(base)} is missing from this shallow clone; fetch the full history`,
    );
  }
  return baseSha;
};

const rangeBetween = (git, baseSha, headSha) => ({
  head: headSha,
  diffBase: tryGit(git, 'merge-base', baseSha, headSha) ?? emptyTree(git),
  logArguments: [`${baseSha}..${headSha}`],
  description: `${shortSha(baseSha)}..${shortSha(headSha)}`,
});

const headOnlyRange = (git, headSha) => ({
  head: headSha,
  diffBase: tryGit(git, 'rev-parse', '--verify', '--quiet', `${headSha}^1`) ?? emptyTree(git),
  logArguments: ['-1', headSha],
  description: `${shortSha(headSha)} (head commit only)`,
});

export const resolveRange = (git, { base, head }) => {
  assertRevision('head', head);
  const headSha = git('rev-parse', '--verify', `${head}^{commit}`).trim();
  const baseSha = resolveBase(git, base);
  return baseSha ? rangeBetween(git, baseSha, headSha) : headOnlyRange(git, headSha);
};

export const readCommits = (git, range) =>
  git('log', '--format=%H%x1f%B%x1e', ...range.logArguments)
    .split('\x1e')
    .map(record => record.trim())
    .filter(record => record !== '')
    .map(record => {
      const [sha, ...message] = record.split('\x1f');
      return { sha, message: message.join('\x1f') };
    });

const unquoteGitPath = quoted =>
  quoted.slice(1, -1).replace(/\\(["\\tn])/g, (_, escape) => QUOTED_ESCAPES[escape]);

const parseTargetPath = header => {
  const name = header.replace(/\t.*$/, '');
  const path = name.startsWith('"') ? unquoteGitPath(name) : name;
  if (path === '/dev/null') return null;
  return path.startsWith('b/') ? path.slice(2) : path;
};

export const parseAddedLines = diff => {
  const added = new Map();
  const lines = diff.split('\n');
  let path = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('diff --git ')) {
      path = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      path = parseTargetPath(line.slice(4));
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (!hunk) continue;
    const removedCount = hunk[1] ? Number(hunk[1]) : 1;
    const addedCount = hunk[3] ? Number(hunk[3]) : 1;
    const firstLine = Number(hunk[2]);
    if (path && addedCount > 0) {
      const lineNumbers = added.get(path) ?? new Set();
      for (let offset = 0; offset < addedCount; offset += 1) lineNumbers.add(firstLine + offset);
      added.set(path, lineNumbers);
    }
    for (let remaining = removedCount + addedCount; remaining > 0; index += 1) {
      if (!lines[index + 1]?.startsWith('\\')) remaining -= 1;
    }
  }
  return added;
};

export const readAddedLines = (git, range) =>
  parseAddedLines(
    git(
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--unified=0',
      '--find-renames',
      '--diff-filter=ACMR',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      range.diffBase,
      range.head,
    ),
  );

export const readBlob = (git, sha, path) => git('show', `${sha}:${path}`);
